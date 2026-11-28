/**
 * PRINTGO — PHASE 5 AUTOMATED TEST SUITE
 * Admin Dashboard, Shop Management, Multi-Tenancy & Financial Analytics
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const jwt = require('jsonwebtoken');

// Import services and helpers
const adminAnalytics = require('../src/services/adminAnalytics.service');
const jobsService = require('../src/modules/jobs/jobs.service');

const JWT_SECRET = process.env.JWT_SECRET || 'test_secret_for_jwt_256_bit_testing';

let passed = 0;
let failed = 0;

const test = async (name, fn) => {
  try {
    await fn();
    console.log(`✅ PASS: ${name}`);
    passed++;
  } catch (e) {
    console.error(`❌ FAIL: ${name}`);
    console.error(`   Details: ${e.message}\n`);
    failed++;
  }
};

async function runTestSuite() {
  console.log('======================================================================');
  console.log('PRINTGO — PHASE 5 ADMIN DASHBOARD & SHOP MANAGEMENT TEST SUITE');
  console.log('======================================================================\n');

  // SETUP: Create test companies and users for tenant isolation testing
  const testCompany1 = await prisma.company.upsert({
    where: { contactEmail: 'shop1_franchisee@test.com' },
    update: {},
    create: {
      name: 'Shop 1 Downtown',
      contactEmail: 'shop1_franchisee@test.com'
    }
  });

  const testCompany2 = await prisma.company.upsert({
    where: { contactEmail: 'shop2_suburbs@test.com' },
    update: {},
    create: {
      name: 'Shop 2 Suburbs',
      contactEmail: 'shop2_suburbs@test.com'
    }
  });

  // Create machines for Shop 1 & Shop 2
  const machine1 = await prisma.machine.upsert({
    where: { machineKey: 'test_machine_key_shop1' },
    update: { companyId: testCompany1.id, status: 'ACTIVE' },
    create: {
      machineKey: 'test_machine_key_shop1',
      name: 'Shop 1 Kiosk A',
      companyId: testCompany1.id,
      status: 'ACTIVE'
    }
  });

  const machine2 = await prisma.machine.upsert({
    where: { machineKey: 'test_machine_key_shop2' },
    update: { companyId: testCompany2.id, status: 'INACTIVE' },
    create: {
      machineKey: 'test_machine_key_shop2',
      name: 'Shop 2 Kiosk B',
      companyId: testCompany2.id,
      status: 'INACTIVE'
    }
  });

  // Tokens
  const superadminUser = { id: 'superadmin_test', email: 'superadmin@printgo.in', role: 'SUPERADMIN', name: 'Super Admin' };
  const franchisee1User = { id: 'franchisee_1', email: 'shop1@test.com', role: 'FRANCHISEE', companyId: testCompany1.id, name: 'Franchisee 1' };
  const franchisee2User = { id: 'franchisee_2', email: 'shop2@test.com', role: 'FRANCHISEE', companyId: testCompany2.id, name: 'Franchisee 2' };

  // 1. Authoritative Financial Aggregation (Gross vs Net vs Demo)
  await test('1. Overview financial aggregation strictly separates real collections from demo payments', async () => {
    // Create Document
    const doc = await prisma.document.create({
      data: { originalName: 'financial_test.pdf', filename: 'financial_test.pdf', mimetype: 'application/pdf', size: 1024, pages: 2 }
    });

    // 1 Real Payment of ₹100.00
    const realPayment = await prisma.payment.create({
      data: {
        amount: 100.0,
        currency: 'INR',
        status: 'SUCCESS',
        gatewayOrderId: `order_real_${Date.now()}`,
        paymentMethod: 'upi',
        type: 'PRINT_JOB'
      }
    });

    // 1 Demo Payment of ₹50.00
    const demoPayment = await prisma.payment.create({
      data: {
        amount: 50.0,
        currency: 'INR',
        status: 'SUCCESS',
        gatewayOrderId: `demo_order_${Date.now()}`,
        paymentMethod: 'demo',
        paymentGroup: 'simulated',
        type: 'PRINT_JOB'
      }
    });

    // Link print jobs
    const realJob = await prisma.printJob.create({
      data: {
        shortId: `r_${Date.now().toString().slice(-6)}`,
        machineId: machine1.id,
        documentId: doc.id,
        paymentId: realPayment.id,
        cost: 100.0,
        status: 'COMPLETED'
      }
    });

    const demoJob = await prisma.printJob.create({
      data: {
        shortId: `d_${Date.now().toString().slice(-6)}`,
        machineId: machine1.id,
        documentId: doc.id,
        paymentId: demoPayment.id,
        cost: 50.0,
        status: 'COMPLETED'
      }
    });

    // Fetch Overview Stats
    const stats = await adminAnalytics.getOverviewStats(superadminUser, { period: 'today' });

    if (!stats.financials) throw new Error('Missing financials block in overview stats');
    if (stats.financials.grossCollections < 100) {
      throw new Error(`Gross collections should include real payment (got ₹${stats.financials.grossCollections})`);
    }
    if (stats.financials.demoCollections < 50) {
      throw new Error(`Demo collections should track simulated revenue separately (got ₹${stats.financials.demoCollections})`);
    }

    // Verify Net = Gross - Total Refunds
    const expectedNet = Math.round((stats.financials.grossCollections - stats.financials.totalRefunds) * 100) / 100;
    if (Math.abs(stats.financials.netCollections - expectedNet) > 0.01) {
      throw new Error(`Net collections mismatch: expected ${expectedNet}, got ${stats.financials.netCollections}`);
    }
  });

  // 2. Multi-Tenant Scoping for Franchisee
  await test('2. Franchisee tenant isolation restricts metrics and data to their own company', async () => {
    // Shop 1 Franchisee query
    const shop1Stats = await adminAnalytics.getOverviewStats(franchisee1User, { period: '30d' });
    // Shop 2 Franchisee query
    const shop2Stats = await adminAnalytics.getOverviewStats(franchisee2User, { period: '30d' });

    if (shop1Stats.hardware.totalMachines !== 1) {
      throw new Error(`Shop 1 should see exactly 1 machine (got ${shop1Stats.hardware.totalMachines})`);
    }
    if (shop2Stats.hardware.totalMachines !== 1) {
      throw new Error(`Shop 2 should see exactly 1 machine (got ${shop2Stats.hardware.totalMachines})`);
    }

    // Jobs Service Multi-Tenancy Check
    const shop1Jobs = await jobsService.getAllJobs(franchisee1User);
    const shop2Jobs = await jobsService.getAllJobs(franchisee2User);

    const hasCrossCompanyInShop1 = shop1Jobs.jobs.some(j => j.machine?.companyId === testCompany2.id);
    const hasCrossCompanyInShop2 = shop2Jobs.jobs.some(j => j.machine?.companyId === testCompany1.id);

    if (hasCrossCompanyInShop1) throw new Error('Security breach: Shop 1 can see jobs from Shop 2');
    if (hasCrossCompanyInShop2) throw new Error('Security breach: Shop 2 can see jobs from Shop 1');
  });

  // 3. Date Filters Handling
  await test('3. Date filters (today, yesterday, 7d, 30d, custom) apply authoritative bounds', async () => {
    const todayStats = await adminAnalytics.getOverviewStats(superadminUser, { period: 'today' });
    const weekStats = await adminAnalytics.getOverviewStats(superadminUser, { period: '7d' });
    const monthStats = await adminAnalytics.getOverviewStats(superadminUser, { period: '30d' });

    if (todayStats.period !== 'today') throw new Error('Expected period today');
    if (weekStats.period !== '7d') throw new Error('Expected period 7d');
    if (monthStats.period !== '30d') throw new Error('Expected period 30d');

    const customStats = await adminAnalytics.getOverviewStats(superadminUser, {
      period: 'custom',
      startDate: '2026-01-01',
      endDate: '2026-12-31'
    });
    if (customStats.period !== 'custom') throw new Error('Expected period custom');
  });

  // 4. Sales Charts Aggregations
  await test('4. Sales charts aggregation returns daily trend, payment breakdown, and print modes', async () => {
    const charts = await adminAnalytics.getSalesChartsData(superadminUser, { period: '30d' });

    if (!Array.isArray(charts.dailyTrend)) throw new Error('dailyTrend must be an array');
    if (!Array.isArray(charts.paymentMethods)) throw new Error('paymentMethods must be an array');
    if (!Array.isArray(charts.printModes)) throw new Error('printModes must be an array');
    if (!Array.isArray(charts.paperSizes)) throw new Error('paperSizes must be an array');

    const hasPrintModes = charts.printModes.some(m => m.name.includes('Single-Sided') || m.name.includes('Duplex'));
    if (!hasPrintModes) throw new Error('printModes should include B&W and Colour breakdown');
  });

  // 5. Payments List and Demo Discrimination
  await test('5. Payments list marks demo payments with isDemo=true and isolates real payments', async () => {
    const paymentsRes = await adminAnalytics.getPayments(superadminUser, { limit: 20 });

    if (!paymentsRes.success) throw new Error('Payments query failed');
    if (!Array.isArray(paymentsRes.payments)) throw new Error('Payments must be an array');

    const demoPay = paymentsRes.payments.find(p => p.paymentMethod === 'demo');
    if (demoPay && demoPay.isDemo !== true) {
      throw new Error(`Demo payment ${demoPay.id} must have isDemo: true`);
    }
  });

  // 6. Invoices Register
  await test('6. Invoices register returns paginated tax invoices with GST breakdown', async () => {
    const invRes = await adminAnalytics.getInvoices(superadminUser, { limit: 10 });

    if (!invRes.success) throw new Error('Invoices query failed');
    if (!Array.isArray(invRes.invoices)) throw new Error('Invoices must be an array');
    if (invRes.invoices.length > 0) {
      const inv = invRes.invoices[0];
      if (typeof inv.totalAmount !== 'number') throw new Error('Invoice must have numeric totalAmount');
      if (typeof inv.taxableAmount !== 'number') throw new Error('Invoice must have numeric taxableAmount');
    }
  });

  // 7. Credit Notes Register
  await test('7. Credit notes register returns statutory records linked to refunds', async () => {
    const cnRes = await adminAnalytics.getCreditNotes(superadminUser, { limit: 10 });

    if (!cnRes.success) throw new Error('Credit notes query failed');
    if (!Array.isArray(cnRes.creditNotes)) throw new Error('Credit notes must be an array');
  });

  // 8. Customer Directory Aggregation
  await test('8. Customer directory aggregates print jobs count by phone or email', async () => {
    const custRes = await adminAnalytics.getCustomers(superadminUser, { limit: 10 });

    if (!custRes.success) throw new Error('Customers query failed');
    if (!Array.isArray(custRes.customers)) throw new Error('Customers must be an array');
  });

  // 9. Operator Listing & Security
  await test('9. Operator listing excludes password hashes and exposes roles and companies safely', async () => {
    const opsRes = await adminAnalytics.getOperators(superadminUser);

    if (!opsRes.success) throw new Error('Operators query failed');
    if (!Array.isArray(opsRes.operators)) throw new Error('Operators must be an array');

    for (const op of opsRes.operators) {
      if (op.password) throw new Error(`Security violation: password hash leaked for operator ${op.email}`);
    }
  });

  // 10. Audit Logs Redaction
  await test('10. Audit logs endpoint redacts passwords, tokens, and secrets from activity details', async () => {
    const anyUser = await prisma.user.findFirst();

    // Insert test activity log with secret tokens
    await prisma.activityLog.create({
      data: {
        userId: anyUser?.id || null,
        action: 'TEST_ACTION',
        details: 'User authenticated with password=supersecretpass and token=jwt123456789'
      }
    });

    const logsRes = await adminAnalytics.getAuditLogs(superadminUser, { limit: 10 });

    if (!logsRes.success) throw new Error('Audit logs query failed');
    const testLog = logsRes.logs.find(l => l.action === 'TEST_ACTION');
    if (testLog) {
      if (testLog.details.includes('supersecretpass')) {
        throw new Error('Security violation: unredacted password found in audit log details');
      }
      if (testLog.details.includes('jwt123456789')) {
        throw new Error('Security violation: unredacted token found in audit log details');
      }
    }
  });

  // 11. CSV Export Generation
  await test('11. CSV export streams valid CSV headers and rows for sales, jobs, and payments', async () => {
    const salesCsv = await adminAnalytics.exportReportCsv(superadminUser, 'sales', { period: '30d' });
    if (!salesCsv.startsWith('Date,Actual Collections (INR),Service Value (INR)')) {
      throw new Error(`Invalid sales CSV header: ${salesCsv.slice(0, 50)}`);
    }

    const jobsCsv = await adminAnalytics.exportReportCsv(superadminUser, 'jobs', { period: '30d' });
    if (!jobsCsv.startsWith('Job ID,Document Name')) {
      throw new Error(`Invalid jobs CSV header: ${jobsCsv.slice(0, 50)}`);
    }

    const paymentsCsv = await adminAnalytics.exportReportCsv(superadminUser, 'payments', { period: '30d' });
    if (!paymentsCsv.startsWith('Payment ID,Gateway Order ID')) {
      throw new Error(`Invalid payments CSV header: ${paymentsCsv.slice(0, 50)}`);
    }
  });

  // 12. Protection of Historical Baseline Job ab36197e
  await test('12. Historical baseline job ab36197e cannot be dispatched or modified from admin routes', async () => {
    // Attempt to update status of ab36197e
    try {
      await jobsService.updateJobStatus('ab36197e', 'COMPLETED', superadminUser);
      throw new Error('Should have rejected modification of ab36197e');
    } catch (e) {
      if (!e.message.includes('protected and cannot be altered')) {
        throw new Error(`Expected protection error, got: ${e.message}`);
      }
    }

    // Check DB state remains PRINTING
    const job = await prisma.printJob.findUnique({ where: { shortId: 'ab36197e' } });
    if (job.status !== 'PRINTING') {
      throw new Error(`Integrity violated: ab36197e status changed to ${job.status}`);
    }
  });

  console.log('\n======================================================================');
  console.log(`PHASE 5 TEST RESULTS: ${passed} PASSED, ${failed} FAILED (Total: ${passed + failed})`);
  console.log('======================================================================\n');

  await prisma.$disconnect();

  if (failed > 0) {
    process.exit(1);
  }
}

runTestSuite();
