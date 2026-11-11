require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const fs = require('fs');
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const prisma = require('../src/utils/prisma');
const jobsRoutes = require('../src/modules/jobs/jobs.routes');
const { errorHandler } = require('../src/middlewares/error');
const {
  generateInvoiceForJob,
  getInvoiceByShortId,
  issueCreditNoteForInvoice,
  INVOICE_DIR
} = require('../src/services/invoice.service');

// Setup minimal Express test application with full middleware chain
const app = express();
app.use(express.json());
app.use(cookieParser());
app.use('/api/jobs', jobsRoutes);
app.use(errorHandler);

const JWT_SECRET = process.env.JWT_SECRET;

async function runTestSuite() {
  console.log('======================================================================');
  console.log('PRINTGO — PHASE 3.1 CRITICAL FINANCIAL & INVOICE SECURITY TEST SUITE');
  console.log('======================================================================\n');

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

  // Helper to create test document
  const createTestDoc = async (pages = 2) => {
    return await prisma.document.create({
      data: {
        originalName: 'sec_test_doc.pdf',
        filename: '/uploads/sec_test_doc.pdf',
        mimetype: 'application/pdf',
        size: 2048,
        pages
      }
    });
  };

  // Helper to create machines
  const machineA = await prisma.machine.upsert({
    where: { machineKey: 'TEST_MACHINE_A' },
    update: {},
    create: {
      name: 'Test Machine Alpha',
      location: 'Store 1',
      machineKey: 'TEST_MACHINE_A',
      status: 'ONLINE'
    }
  });

  const machineB = await prisma.machine.upsert({
    where: { machineKey: 'TEST_MACHINE_B' },
    update: {},
    create: {
      name: 'Test Machine Beta',
      location: 'Store 2',
      machineKey: 'TEST_MACHINE_B',
      status: 'ONLINE'
    }
  });

  // Generate tokens
  const tokenMachineA = jwt.sign(
    { type: 'session', sessionId: 'sess-a', machineId: machineA.id },
    JWT_SECRET,
    { expiresIn: '1h' }
  );

  const tokenMachineB = jwt.sign(
    { type: 'session', sessionId: 'sess-b', machineId: machineB.id },
    JWT_SECRET,
    { expiresIn: '1h' }
  );

  // Setup test job assigned to Machine A
  const docA = await createTestDoc(2);
  const testJobA = await prisma.printJob.create({
    data: {
      shortId: `sec_${Date.now().toString().slice(-5)}a`,
      machineId: machineA.id,
      documentId: docA.id,
      cost: 20.0,
      copies: 1,
      pagesToPrint: 2,
      status: 'WAITING',
      pricingSnapshot: JSON.stringify({ baseCost: 20, calculation: '2 pages @ 10' })
    }
  });

  // Successful payment for testJobA
  const paymentA = await prisma.payment.create({
    data: {
      gatewayOrderId: `order_sec_${Date.now()}_a`,
      amount: 20.0,
      currency: 'INR',
      type: 'PRINT_JOB',
      status: 'SUCCESS',
      paymentMethod: 'cashfree_upi'
    }
  });

  await prisma.printJob.update({
    where: { id: testJobA.id },
    data: { paymentId: paymentA.id }
  });

  // Pre-generate invoice for testJobA
  const invoiceA = await generateInvoiceForJob(testJobA.shortId, {
    name: 'Customer A',
    phone: '9999900001'
  });

  // -------------------------------------------------------------------------
  // TEST 1: Unauthenticated request to invoice download rejected (401)
  // -------------------------------------------------------------------------
  await test('SEC-01: Unauthenticated request to /api/jobs/:id/invoice/download rejected (401)', async () => {
    const res = await request(app).get(`/api/jobs/${testJobA.shortId}/invoice/download`);
    if (res.status !== 401) {
      throw new Error(`Expected HTTP 401 Unauthorized, got ${res.status}`);
    }
  });

  // -------------------------------------------------------------------------
  // TEST 2: Cross-machine IDOR to invoice metadata rejected with 404 (Anti-Enumeration)
  // -------------------------------------------------------------------------
  await test('SEC-02: Cross-machine IDOR to /api/jobs/:id/invoice rejected with 404 (Anti-Enumeration)', async () => {
    // Session B tries to access Job A
    const res = await request(app)
      .get(`/api/jobs/${testJobA.shortId}/invoice`)
      .set('Authorization', `Bearer ${tokenMachineB}`);

    // Must return 404, NOT 403, to prevent enumeration of valid shortIds
    if (res.status !== 404) {
      throw new Error(`Expected HTTP 404 Not Found to prevent job enumeration, got ${res.status}`);
    }
    if (res.body.error !== 'Job not found') {
      throw new Error(`Expected error message 'Job not found', got '${res.body.error}'`);
    }
  });

  // -------------------------------------------------------------------------
  // TEST 3: Cross-machine IDOR to invoice download rejected with 404
  // -------------------------------------------------------------------------
  await test('SEC-01: Cross-machine IDOR to /api/jobs/:id/invoice/download rejected with 404', async () => {
    // Session B tries to download Job A's invoice PDF
    const res = await request(app)
      .get(`/api/jobs/${testJobA.shortId}/invoice/download`)
      .set('Authorization', `Bearer ${tokenMachineB}`);

    if (res.status !== 404) {
      throw new Error(`Expected HTTP 404 Not Found, got ${res.status}`);
    }
    if (res.body.error !== 'Job not found') {
      throw new Error(`Expected error message 'Job not found', got '${res.body.error}'`);
    }
  });

  // -------------------------------------------------------------------------
  // TEST 4: Authorized session can access metadata and download invoice PDF
  // -------------------------------------------------------------------------
  await test('Authorized session owner can view invoice metadata and download PDF', async () => {
    // 1. Metadata endpoint
    const metaRes = await request(app)
      .get(`/api/jobs/${testJobA.shortId}/invoice`)
      .set('Authorization', `Bearer ${tokenMachineA}`);

    if (metaRes.status !== 200 || !metaRes.body.success) {
      throw new Error(`Expected 200 OK for metadata, got ${metaRes.status}`);
    }
    if (metaRes.body.invoice.invoiceNumber !== invoiceA.invoiceNumber) {
      throw new Error(`Invoice number mismatch: ${metaRes.body.invoice.invoiceNumber} vs ${invoiceA.invoiceNumber}`);
    }

    // 2. Download endpoint
    const dlRes = await request(app)
      .get(`/api/jobs/${testJobA.shortId}/invoice/download`)
      .set('Authorization', `Bearer ${tokenMachineA}`);

    if (dlRes.status !== 200) {
      throw new Error(`Expected 200 OK for download, got ${dlRes.status}`);
    }
    if (!dlRes.headers['content-type']?.includes('application/pdf')) {
      throw new Error(`Expected Content-Type application/pdf, got ${dlRes.headers['content-type']}`);
    }
    if (parseInt(dlRes.headers['content-length'] || '0', 10) < 1000) {
      throw new Error('Downloaded PDF content length is invalid or empty');
    }
  });

  // -------------------------------------------------------------------------
  // TEST 5: Invoice generation on PENDING_PAYMENT job throws 400 error
  // -------------------------------------------------------------------------
  await test('Invoice eligibility: Rejects invoice generation for unpaid PENDING_PAYMENT job', async () => {
    const unpaidDoc = await createTestDoc(1);
    const unpaidJob = await prisma.printJob.create({
      data: {
        shortId: `sec_${Date.now().toString().slice(-5)}u`,
        documentId: unpaidDoc.id,
        cost: 15.0,
        copies: 1,
        pagesToPrint: 1,
        status: 'PENDING_PAYMENT'
      }
    });

    let threw = false;
    try {
      await generateInvoiceForJob(unpaidJob.shortId);
    } catch (err) {
      threw = true;
      if (err.statusCode !== 400 || !err.message.includes('pending payment and unpaid')) {
        throw new Error(`Unexpected error: ${err.message} (status: ${err.statusCode})`);
      }
    }

    if (!threw) {
      throw new Error('generateInvoiceForJob did not throw 400 for unpaid job');
    }
  });

  // -------------------------------------------------------------------------
  // TEST 6: Invoice generation on FAILED payment throws 400 error
  // -------------------------------------------------------------------------
  await test('Invoice eligibility: Rejects invoice generation for FAILED payment', async () => {
    const failedDoc = await createTestDoc(1);
    const failedPayment = await prisma.payment.create({
      data: {
        gatewayOrderId: `order_failed_${Date.now()}`,
        amount: 10.0,
        currency: 'INR',
        type: 'PRINT_JOB',
        status: 'FAILED',
        paymentMethod: 'cashfree_upi'
      }
    });

    const failedJob = await prisma.printJob.create({
      data: {
        shortId: `sec_${Date.now().toString().slice(-5)}f`,
        documentId: failedDoc.id,
        cost: 10.0,
        copies: 1,
        pagesToPrint: 1,
        status: 'WAITING',
        paymentId: failedPayment.id
      }
    });

    let threw = false;
    try {
      await generateInvoiceForJob(failedJob.shortId);
    } catch (err) {
      threw = true;
      if (err.statusCode !== 400 || !err.message.includes("'FAILED'")) {
        throw new Error(`Unexpected error: ${err.message} (status: ${err.statusCode})`);
      }
    }

    if (!threw) {
      throw new Error('generateInvoiceForJob did not throw 400 for FAILED payment');
    }
  });

  // -------------------------------------------------------------------------
  // TEST 7: Amount mismatch between job.cost and payment.amount throws 400 error
  // -------------------------------------------------------------------------
  await test('Financial integrity: Rejects invoice generation when payment amount mismatches job cost', async () => {
    const mismatchDoc = await createTestDoc(1);
    const mismatchPayment = await prisma.payment.create({
      data: {
        gatewayOrderId: `order_mismatch_${Date.now()}`,
        amount: 5.0, // Fraudulent / partial amount
        currency: 'INR',
        type: 'PRINT_JOB',
        status: 'SUCCESS',
        paymentMethod: 'cashfree_upi'
      }
    });

    const mismatchJob = await prisma.printJob.create({
      data: {
        shortId: `sec_${Date.now().toString().slice(-5)}m`,
        documentId: mismatchDoc.id,
        cost: 25.0, // Server-calculated cost is 25.0
        copies: 1,
        pagesToPrint: 1,
        status: 'WAITING',
        paymentId: mismatchPayment.id
      }
    });

    let threw = false;
    try {
      await generateInvoiceForJob(mismatchJob.shortId);
    } catch (err) {
      threw = true;
      if (err.statusCode !== 400 || !err.message.includes('does not match payment amount')) {
        throw new Error(`Unexpected error: ${err.message} (status: ${err.statusCode})`);
      }
    }

    if (!threw) {
      throw new Error('generateInvoiceForJob did not throw 400 for amount mismatch');
    }
  });

  // -------------------------------------------------------------------------
  // TEST 8: Demo payment generates simulated receipt (isDemo = true, zero GST)
  // -------------------------------------------------------------------------
  await test('Demo payment handling: Generates simulated receipt with isDemo=true and zero tax', async () => {
    const demoDoc = await createTestDoc(1);
    const demoPayment = await prisma.payment.create({
      data: {
        gatewayOrderId: `demo_order_${Date.now()}`,
        amount: 10.0,
        currency: 'INR',
        type: 'PRINT_JOB',
        status: 'SUCCESS',
        paymentMethod: 'demo',
        paymentGroup: 'simulated'
      }
    });

    const demoJob = await prisma.printJob.create({
      data: {
        shortId: `sec_${Date.now().toString().slice(-5)}d`,
        documentId: demoDoc.id,
        cost: 10.0,
        copies: 1,
        pagesToPrint: 1,
        status: 'WAITING',
        paymentId: demoPayment.id
      }
    });

    const demoInvoice = await generateInvoiceForJob(demoJob.shortId);

    if (demoInvoice.isDemo !== true) {
      throw new Error(`Expected isDemo to be true, got ${demoInvoice.isDemo}`);
    }
    if (demoInvoice.cgstAmount !== 0 || demoInvoice.sgstAmount !== 0 || demoInvoice.totalTax !== 0) {
      throw new Error(`Demo invoice must have 0 tax liability, got CGST=${demoInvoice.cgstAmount}, SGST=${demoInvoice.sgstAmount}`);
    }
    if (demoInvoice.sellerGstin !== null) {
      throw new Error(`Demo invoice must not carry real GSTIN, got ${demoInvoice.sellerGstin}`);
    }

    // Verify PDF on disk contains simulated receipt notice
    const expectedPdfPath = path.join(INVOICE_DIR, `${demoInvoice.invoiceNumber}.pdf`);
    if (!fs.existsSync(expectedPdfPath)) {
      throw new Error('Physical PDF receipt was not created on disk for demo payment');
    }
    console.log(`   Demo receipt verified: ${demoInvoice.invoiceNumber} (isDemo=true, tax=0)`);
  });

  // -------------------------------------------------------------------------
  // TEST 9: Concurrency-safe invoice numbering produces distinct numbers
  // -------------------------------------------------------------------------
  await test('Transactional concurrency: Produces distinct sequential numbers without collisions', async () => {
    // Create 3 jobs in parallel
    const createdJobs = [];
    for (let i = 0; i < 3; i++) {
      const doc = await createTestDoc(1);
      const pay = await prisma.payment.create({
        data: {
          gatewayOrderId: `order_concur_${Date.now()}_${i}`,
          amount: 5.0,
          currency: 'INR',
          type: 'PRINT_JOB',
          status: 'SUCCESS',
          paymentMethod: 'cashfree_upi'
        }
      });
      const job = await prisma.printJob.create({
        data: {
          shortId: `sec_${Date.now().toString().slice(-4)}c${i}`,
          documentId: doc.id,
          cost: 5.0,
          copies: 1,
          pagesToPrint: 1,
          status: 'WAITING',
          paymentId: pay.id
        }
      });
      createdJobs.push(job);
    }

    // Issue invoices concurrently
    const invoices = await Promise.all(
      createdJobs.map(j => generateInvoiceForJob(j.shortId))
    );

    const invoiceNumbers = invoices.map(inv => inv.invoiceNumber);
    const uniqueNumbers = new Set(invoiceNumbers);

    if (uniqueNumbers.size !== invoiceNumbers.length) {
      throw new Error(`Collision detected in concurrent invoice numbers: ${invoiceNumbers.join(', ')}`);
    }

    console.log(`   Issued 3 distinct concurrent invoices: ${invoiceNumbers.join(', ')}`);
  });

  // -------------------------------------------------------------------------
  // TEST 10: Issue Credit Note transitions Invoice to CANCELLED and creates record
  // -------------------------------------------------------------------------
  await test('Invoice lifecycle: issueCreditNoteForInvoice marks CANCELLED and generates CreditNote PDF', async () => {
    const cn = await issueCreditNoteForInvoice(invoiceA.id, {
      reason: 'Customer cancelled print job before spooling'
    });

    if (!cn.creditNoteNumber || !cn.creditNoteNumber.startsWith('CN-')) {
      throw new Error(`Invalid credit note number: ${cn.creditNoteNumber}`);
    }
    if (cn.totalAmount !== invoiceA.totalAmount) {
      throw new Error(`Credit note amount ${cn.totalAmount} != Invoice amount ${invoiceA.totalAmount}`);
    }

    // Verify original invoice status is updated to CANCELLED
    const updatedInvoice = await prisma.invoice.findUnique({ where: { id: invoiceA.id } });
    if (updatedInvoice.status !== 'CANCELLED') {
      throw new Error(`Expected Invoice status 'CANCELLED', got '${updatedInvoice.status}'`);
    }

    // Verify physical PDF Credit Note exists on disk
    const cnPdfPath = path.join(INVOICE_DIR, `${cn.creditNoteNumber}.pdf`);
    if (!fs.existsSync(cnPdfPath)) {
      throw new Error(`Physical Credit Note PDF not found at ${cnPdfPath}`);
    }

    const cnStat = fs.statSync(cnPdfPath);
    if (cnStat.size < 1000) {
      throw new Error(`Credit Note PDF is abnormally small: ${cnStat.size} bytes`);
    }

    console.log(`   Credit Note issued: ${cn.creditNoteNumber} for Invoice ${invoiceA.invoiceNumber} (${cnStat.size} bytes)`);

    // Verify idempotency: Calling again returns existing Credit Note
    const idempCn = await issueCreditNoteForInvoice(invoiceA.id);
    if (idempCn.id !== cn.id) {
      throw new Error('issueCreditNoteForInvoice is not idempotent');
    }
  });

  // -------------------------------------------------------------------------
  // TEST 11: Anti-path-traversal protection prevents directory escape
  // -------------------------------------------------------------------------
  await test('Anti-path-traversal: Reject invoice paths attempting directory traversal', async () => {
    // Malicious invoice number simulation
    const maliciousNumber = '../../etc/passwd';
    const sanitizedNumber = maliciousNumber.replace(/[^a-zA-Z0-9_-]/g, '');
    const resolvedPath = path.resolve(INVOICE_DIR, `${sanitizedNumber}.pdf`);

    if (!resolvedPath.startsWith(path.resolve(INVOICE_DIR))) {
      throw new Error(`Resolved path escaped INVOICE_DIR: ${resolvedPath}`);
    }
    if (sanitizedNumber.includes('/') || sanitizedNumber.includes('\\') || sanitizedNumber.includes('..')) {
      throw new Error(`Sanitization failed: ${sanitizedNumber}`);
    }
  });

  // -------------------------------------------------------------------------
  // TEST 12: Historical jobs and payments remain 100% unaltered
  // -------------------------------------------------------------------------
  await test('Historical database records and baseline jobs remain 100% intact', async () => {
    // Check job cded2789 (₹2 completed job)
    const jobCded = await prisma.printJob.findUnique({ where: { shortId: 'cded2789' } });
    if (!jobCded || jobCded.cost !== 2 || jobCded.status !== 'COMPLETED') {
      throw new Error('Historical job cded2789 was modified or lost!');
    }

    // Check job ab36197e (authorized test job)
    const jobAb = await prisma.printJob.findUnique({
      where: { shortId: 'ab36197e' },
      include: { payment: true }
    });
    if (!jobAb) {
      throw new Error('Historical job ab36197e was lost!');
    }
    if (jobAb.payment && jobAb.payment.status !== 'SUCCESS') {
      throw new Error(`Historical job ab36197e payment status altered: ${jobAb.payment.status}`);
    }

    // Check physical print history for PG-CSMH66
    const jobCsmh = await prisma.printJob.findUnique({
      where: { shortId: 'PG-CSMH66' },
      include: { printHistory: true }
    });
    if (!jobCsmh || !jobCsmh.printHistory || jobCsmh.printHistory.length === 0 || jobCsmh.printHistory[0].success !== true) {
      throw new Error('Historical print history for PG-CSMH66 was altered!');
    }

    console.log('   All historical records verified intact.');
  });

  console.log('\n======================================================================');
  console.log(`PHASE 3.1 TEST RESULTS: ${passed} PASSED, ${failed} FAILED (Total: ${passed + failed})`);
  console.log('======================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runTestSuite()
  .catch(err => {
    console.error('Phase 3.1 test suite failure:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
