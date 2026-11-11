const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const fs = require('fs');
const prisma = require('../src/utils/prisma');
const { calculatePrice, parseCustomPageRange } = require('../src/services/pricing.service');
const { generateInvoiceForJob, getInvoiceByShortId, INVOICE_DIR } = require('../src/services/invoice.service');
const jobsService = require('../src/modules/jobs/jobs.service');

async function runTestSuite() {
  console.log('======================================================================');
  console.log('PRINTGO — PHASE 3 PRICING, DYNAMIC DB, TAXES & INVOICES TEST SUITE');
  console.log('======================================================================\n');

  let passed = 0;
  let failed = 0;

  // Clean test profiles at start
  await prisma.businessProfile.deleteMany();
  await prisma.printPricingProfile.deleteMany();

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

  // Helper to create test doc
  const createTestDoc = async (pages = 4) => {
    return await prisma.document.create({
      data: {
        originalName: 'test_invoice_doc.pdf',
        filename: '/uploads/test_invoice_doc.pdf',
        mimetype: 'application/pdf',
        size: 4096,
        pages
      }
    });
  };

  // -------------------------------------------------------------------------
  // TEST 1: Page Range Parsing
  // -------------------------------------------------------------------------
  await test('Custom page range parser correctly computes total pages', async () => {
    const totalPages = 20;
    const count1 = parseCustomPageRange('1-5', totalPages);
    if (count1 !== 5) throw new Error(`Expected 5, got ${count1}`);

    const count2 = parseCustomPageRange('1-3, 5, 8-10', totalPages);
    // 1-3 = 3, 5 = 1, 8-10 = 3 => total = 7
    if (count2 !== 7) throw new Error(`Expected 7, got ${count2}`);

    const count3 = parseCustomPageRange('', totalPages);
    if (count3 !== 20) throw new Error(`Expected 20, got ${count3}`);
  });

  // -------------------------------------------------------------------------
  // TEST 2: Dynamic Database Pricing Profile
  // -------------------------------------------------------------------------
  let customProfile = null;
  await test('Dynamic pricing profile in database is applied correctly', async () => {
    customProfile = await prisma.printPricingProfile.create({
      data: {
        name: 'Unit Test Dynamic Profile',
        isDefault: true,
        bwSingleRate: 4.0,       // ₹4 instead of default ₹2
        bwDuplexRate: 6.0,       // ₹6 instead of default ₹3
        colorSingleRate: 15.0,   // ₹15 instead of default ₹10
        colorDuplexRate: 25.0,   // ₹25 instead of default ₹18
        minOrderAmount: 5.0,
        isActive: true
      }
    });

    const doc = { pages: 2 };
    // B&W Single: 2 pages * ₹4 = ₹8
    const resBw = await calculatePrice({ color: 'bw', duplex: 'single', copies: 1 }, doc);
    if (resBw.cost !== 8) throw new Error(`Expected ₹8, got ₹${resBw.cost}`);

    // B&W Duplex: 1 sheet * ₹6 = ₹6
    const resDuplex = await calculatePrice({ color: 'bw', duplex: 'double', copies: 1 }, doc);
    if (resDuplex.cost !== 6) throw new Error(`Expected ₹6, got ₹${resDuplex.cost}`);

    // Color Single: 2 pages * ₹15 = ₹30
    const resColor = await calculatePrice({ color: 'color', duplex: 'single', copies: 1 }, doc);
    if (resColor.cost !== 30) throw new Error(`Expected ₹30, got ₹${resColor.cost}`);
  });

  // -------------------------------------------------------------------------
  // TEST 3: Machine / Shop-Specific Pricing Overrides
  // -------------------------------------------------------------------------
  await test('Machine-specific pricing overrides default kiosk profile', async () => {
    const machine = await prisma.machine.findFirst();
    if (!machine) throw new Error('No machine found in DB');

    // Create a special premium rate for this specific machine
    const machineProfile = await prisma.printPricingProfile.create({
      data: {
        name: 'Machine Override Profile',
        machineId: machine.id,
        bwSingleRate: 10.0, // ₹10/page on this specific kiosk
        isActive: true
      }
    });

    const doc = { pages: 2 };
    // Call for this machine
    const resMachine = await calculatePrice({ color: 'bw', duplex: 'single', copies: 1 }, doc, machine.id);
    if (resMachine.cost !== 20) throw new Error(`Expected ₹20 for machine override, got ₹${resMachine.cost}`);

    // Call without machineId (should use default profile: ₹4/page => ₹8)
    const resDefault = await calculatePrice({ color: 'bw', duplex: 'single', copies: 1 }, doc, null);
    if (resDefault.cost !== 8) throw new Error(`Expected ₹8 for default profile, got ₹${resDefault.cost}`);

    // Clean up machine profile
    await prisma.printPricingProfile.delete({ where: { id: machineProfile.id } });
  });

  // -------------------------------------------------------------------------
  // TEST 4: Paper Size Multipliers & Paper Type Surcharges
  // -------------------------------------------------------------------------
  await test('Paper size multipliers (A3) and glossy photo paper surcharges apply accurately', async () => {
    const doc = { pages: 1 };
    // Custom profile has bwSingleRate = ₹4.0, a3Multiplier = 2.0 => A3 B&W Single = 4 * 2.0 = ₹8
    const resA3 = await calculatePrice({ color: 'bw', duplex: 'single', copies: 1, paperSize: 'A3' }, doc);
    if (resA3.cost !== 8) throw new Error(`Expected ₹8 for A3, got ₹${resA3.cost}`);

    // Update profile with glossy surcharge = ₹5.0 per side
    await prisma.printPricingProfile.update({
      where: { id: customProfile.id },
      data: { glossySurcharge: 5.0 }
    });

    // Glossy A4 Color Single: (colorSingleRate: 15 + glossy: 5) * 1 = ₹20
    const resGlossy = await calculatePrice({ color: 'color', duplex: 'single', copies: 1, paperSize: 'A4', paperType: 'glossy' }, doc);
    if (resGlossy.cost !== 20) throw new Error(`Expected ₹20 for glossy photo print, got ₹${resGlossy.cost}`);
  });

  // -------------------------------------------------------------------------
  // TEST 5: GST Calculation & CGST / SGST Breakdown
  // -------------------------------------------------------------------------
  await test('Configurable 18% GST calculates correct taxable amount and 50-50 CGST/SGST split', async () => {
    // Enable 18% tax-inclusive GST on profile
    await prisma.printPricingProfile.update({
      where: { id: customProfile.id },
      data: {
        gstEnabled: true,
        gstRatePercent: 18.0,
        isTaxInclusive: true
      }
    });

    const doc = { pages: 5 }; // 5 pages * ₹4 = ₹20 gross
    const res = await calculatePrice({ color: 'bw', duplex: 'single', copies: 1 }, doc);
    
    // Taxable = 20 / 1.18 = 16.95, Tax = 3.05 (CGST = 1.53, SGST = 1.52 or 1.53)
    const breakdown = res.taxBreakdown;
    if (Math.abs((breakdown.taxableAmount + breakdown.totalTax) - res.cost) > 0.05) {
      throw new Error(`Taxable (${breakdown.taxableAmount}) + Tax (${breakdown.totalTax}) != Cost (${res.cost})`);
    }

    if (Math.abs(breakdown.cgstAmount - breakdown.sgstAmount) > 0.02) {
      throw new Error(`CGST (${breakdown.cgstAmount}) and SGST (${breakdown.sgstAmount}) are not split 50/50`);
    }

    console.log(`   GST breakdown for ₹${res.cost}: Taxable=₹${breakdown.taxableAmount}, CGST=₹${breakdown.cgstAmount}, SGST=₹${breakdown.sgstAmount}`);
  });

  // -------------------------------------------------------------------------
  // TEST 6: Immutable Pricing Snapshot Retention with PrintJob
  // -------------------------------------------------------------------------
  let testJobShortId = null;
  await test('PrintJob retains immutable pricing snapshot even if profile is changed later', async () => {
    const doc = await createTestDoc(2);
    
    // Create job via jobsService
    const job = await jobsService.createJob({
      file: { originalName: 'snapshot_test.pdf', filename: doc.filename, mimetype: doc.mimetype, size: doc.size, pages: doc.pages },
      settings: { color: 'bw', duplex: 'single', copies: 1, paperSize: 'A4', paperType: 'plain' }
    });

    testJobShortId = job.shortId;
    const initialCost = job.cost;
    const initialSnapshot = JSON.parse(job.pricingSnapshot);

    if (!job.pricingSnapshot || !initialSnapshot.calculation) {
      throw new Error('pricingSnapshot was not saved to PrintJob');
    }

    // Now change the pricing profile dramatically (e.g. increase rate from ₹4 to ₹50)
    await prisma.printPricingProfile.update({
      where: { id: customProfile.id },
      data: { bwSingleRate: 50.0 }
    });

    // Re-query the job from database
    const freshJob = await prisma.printJob.findUnique({ where: { id: job.id } });
    if (freshJob.cost !== initialCost) {
      throw new Error(`Job cost was mutated! Initial: ₹${initialCost}, Fresh: ₹${freshJob.cost}`);
    }

    const freshSnapshot = JSON.parse(freshJob.pricingSnapshot);
    if (freshSnapshot.ratesApplied.unitRate !== initialSnapshot.ratesApplied.unitRate) {
      throw new Error('Immutable snapshot rates were unexpectedly modified');
    }
  });

  // -------------------------------------------------------------------------
  // TEST 7: Downloadable Customer Invoice & PDF Generation
  // -------------------------------------------------------------------------
  await test('Generates customer invoice in database and physical PDF receipt on disk', async () => {
    // Fulfill Phase 3.1 requirement: Job must have a verified successful payment
    const dbJob = await prisma.printJob.findUnique({ where: { shortId: testJobShortId } });
    const p1 = await prisma.payment.create({
      data: {
        gatewayOrderId: `order_test_${Date.now()}`,
        amount: dbJob.cost,
        currency: 'INR',
        type: 'PRINT_JOB',
        status: 'SUCCESS',
        paymentMethod: 'cashfree_upi'
      }
    });
    await prisma.printJob.update({
      where: { id: dbJob.id },
      data: { status: 'WAITING', paymentId: p1.id }
    });

    // Generate invoice for our test job
    const invoice = await generateInvoiceForJob(testJobShortId, {
      name: 'Ramesh Kumar',
      phone: '9876543210',
      email: 'ramesh@example.com'
    });

    if (!invoice.invoiceNumber || !invoice.invoiceNumber.startsWith('INV-')) {
      throw new Error(`Invalid invoice number: ${invoice.invoiceNumber}`);
    }

    if (invoice.totalAmount <= 0) {
      throw new Error(`Invalid invoice totalAmount: ${invoice.totalAmount}`);
    }

    // Verify PDF was written to disk
    const expectedPdfPath = path.join(INVOICE_DIR, `${invoice.invoiceNumber}.pdf`);
    if (!fs.existsSync(expectedPdfPath)) {
      throw new Error(`Physical PDF invoice does not exist at ${expectedPdfPath}`);
    }

    const fileStat = fs.statSync(expectedPdfPath);
    if (fileStat.size < 1000) {
      throw new Error(`Generated PDF file is abnormally small: ${fileStat.size} bytes`);
    }

    console.log(`   Invoice generated: ${invoice.invoiceNumber} (${fileStat.size} bytes PDF created on disk)`);

    // Verify idempotency: Calling again returns exact same invoice
    const duplicate = await generateInvoiceForJob(testJobShortId);
    if (duplicate.id !== invoice.id || duplicate.invoiceNumber !== invoice.invoiceNumber) {
      throw new Error('generateInvoiceForJob is not idempotent for the same job');
    }
  });

  // -------------------------------------------------------------------------
  // TEST 8: Configurable GSTIN & Legal Business Profile
  // -------------------------------------------------------------------------
  await test('BusinessProfile controls legal identity and validates GSTIN before issuing tax invoices', async () => {
    const business = await prisma.businessProfile.create({
      data: {
        legalName: 'Apex Franchise Kiosks Pvt Ltd',
        tradeName: 'PrintGo Cyberabad',
        gstin: '36ABCDE1234F1Z5', // Valid Telangana GSTIN format
        city: 'Hyderabad',
        state: 'Telangana',
        stateCode: '36',
        invoicePrefix: 'INV-APEX-'
      }
    });

    // Create a new job to test tax invoice issuance with business details
    const doc = await createTestDoc(1);
    const job = await jobsService.createJob({
      file: { originalName: 'tax_inv_test.pdf', filename: doc.filename, mimetype: doc.mimetype, size: doc.size, pages: 1 },
      settings: { color: 'bw', duplex: 'single', copies: 1 }
    });

    // Record verified payment for job
    const p2 = await prisma.payment.create({
      data: {
        gatewayOrderId: `order_apex_${Date.now()}`,
        amount: job.cost,
        currency: 'INR',
        type: 'PRINT_JOB',
        status: 'SUCCESS',
        paymentMethod: 'cashfree_upi'
      }
    });
    await prisma.printJob.update({
      where: { id: job.id },
      data: { status: 'WAITING', paymentId: p2.id }
    });

    const taxInvoice = await generateInvoiceForJob(job.shortId);
    if (!taxInvoice.invoiceNumber.startsWith('INV-APEX-')) {
      throw new Error(`Invoice did not use configured prefix: ${taxInvoice.invoiceNumber}`);
    }
    if (taxInvoice.sellerGstin !== '36ABCDE1234F1Z5') {
      throw new Error(`Invoice did not record seller GSTIN: ${taxInvoice.sellerGstin}`);
    }
    if (taxInvoice.sellerName !== 'Apex Franchise Kiosks Pvt Ltd') {
      throw new Error(`Invoice sellerName mismatch: ${taxInvoice.sellerName}`);
    }

    // Clean up test business profile
    await prisma.businessProfile.delete({ where: { id: business.id } });
  });

  // -------------------------------------------------------------------------
  // TEST 9: Historical Production Data & Workflows Intact
  // -------------------------------------------------------------------------
  await test('Historical jobs remain 100% intact and default rates match standard constants', async () => {
    // Delete custom test profile so system defaults to standard constants
    if (customProfile) {
      await prisma.printPricingProfile.delete({ where: { id: customProfile.id } });
    }

    // Historical job check
    const job = await prisma.printJob.findUnique({ where: { shortId: 'cded2789' } });
    if (!job || job.cost !== 2 || job.status !== 'COMPLETED') {
      throw new Error('Job cded2789 altered!');
    }

    // Standard fallback check: 1 page B&W single = ₹2, Color = ₹10
    const fallbackBw = await calculatePrice({ color: 'bw', duplex: 'single', copies: 1 }, { pages: 1 });
    if (fallbackBw.cost !== 2) throw new Error(`Expected fallback ₹2, got ₹${fallbackBw.cost}`);

    const fallbackColor = await calculatePrice({ color: 'color', duplex: 'single', copies: 1 }, { pages: 1 });
    if (fallbackColor.cost !== 10) throw new Error(`Expected fallback ₹10, got ₹${fallbackColor.cost}`);
  });

  console.log('\n======================================================================');
  console.log(`PHASE 3 TEST RESULTS: ${passed} PASSED, ${failed} FAILED (Total: ${passed + failed})`);
  console.log('======================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runTestSuite()
  .catch(err => {
    console.error('Phase 3 test suite error:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
