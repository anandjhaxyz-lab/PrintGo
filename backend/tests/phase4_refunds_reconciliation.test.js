const path = require('path');
process.env.NODE_PATH = path.resolve(__dirname, '../node_modules');
require('module').Module._initPaths();
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const fs = require('fs');
const crypto = require('crypto');
const prisma = require('../src/utils/prisma');
const cashfreeGateway = require('../src/services/cashfreeGateway.adapter');
const refundService = require('../src/services/refund.service');
const reconciliationService = require('../src/services/reconciliation.service');
const {
  generateInvoiceForJob,
  issueCreditNoteForInvoice,
  INVOICE_DIR
} = require('../src/services/invoice.service');

async function runTestSuite() {
  console.log('======================================================================');
  console.log('PRINTGO — PHASE 4 REFUNDS, FINANCIAL RECOVERY & RECONCILIATION TESTS');
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
        originalName: 'phase4_test_doc.pdf',
        filename: '/uploads/phase4_test_doc.pdf',
        mimetype: 'application/pdf',
        size: 2048,
        pages
      }
    });
  };

  // Helper to create a paid test job and payment
  const createPaidJob = async (amount = 50.0, isDemo = false, paymentStatus = 'SUCCESS') => {
    const doc = await createTestDoc(2);
    const shortId = `p4_${Date.now().toString().slice(-5)}_${Math.floor(Math.random() * 1000)}`;

    const payment = await prisma.payment.create({
      data: {
        amount,
        currency: 'INR',
        type: 'PRINT_JOB',
        status: paymentStatus,
        paymentMethod: isDemo ? 'demo' : 'cashfree_upi',
        paymentGroup: isDemo ? 'simulated' : 'upi',
        gatewayOrderId: isDemo ? `demo_order_${shortId}` : `order_${shortId}`
      }
    });

    const job = await prisma.printJob.create({
      data: {
        shortId,
        documentId: doc.id,
        cost: amount,
        copies: 1,
        pagesToPrint: 2,
        status: paymentStatus === 'SUCCESS' ? 'WAITING' : 'PENDING_PAYMENT',
        paymentId: payment.id,
        pricingSnapshot: JSON.stringify({ baseCost: amount, taxableAmount: amount / 1.18, totalTax: amount - (amount / 1.18) })
      }
    });

    // Create initial transaction entry
    await prisma.transaction.create({
      data: {
        paymentId: payment.id,
        action: 'PAYMENT_SUCCESS',
        status: 'SUCCESS',
        amount
      }
    });

    return { job, payment };
  };

  // Enable Gateway Mock Mode for safe local testing
  cashfreeGateway.setMockMode(true);

  // Snapshot existing ab36197e state (unchanged invariant) + construct isolated PRINTING safety fixture
  const ab36197eBefore = await prisma.printJob.findUnique({
    where: { shortId: 'ab36197e' },
    select: { status: true, cost: true, updatedAt: true }
  });

  const printingDoc = await createTestDoc(1);
  const printingPayment = await prisma.payment.create({
    data: {
      amount: 50.0,
      currency: 'INR',
      type: 'PRINT_JOB',
      status: 'SUCCESS',
      paymentMethod: 'cashfree_upi',
      paymentGroup: 'upi',
      gatewayOrderId: `order_p4_printing_${Date.now()}`
    }
  });
  const printingFixture = await prisma.printJob.create({
    data: {
      shortId: `p4prt_${Date.now().toString().slice(-5)}`,
      documentId: printingDoc.id,
      cost: 50.0,
      copies: 1,
      pagesToPrint: 1,
      status: 'PRINTING',
      paymentId: printingPayment.id
    }
  });
  await prisma.printHistory.create({
    data: {
      printJobId: printingFixture.id,
      success: false,
      errorDetails: 'Simulated ambiguous active PRINTING fixture'
    }
  });

  // =========================================================================
  // REFUND TESTS (1 - 12)
  // =========================================================================

  // TEST 1: Successful full refund
  let fullRefundJob, fullRefundPayment;
  await test('1. Successful full refund', async () => {
    const setup = await createPaidJob(50.0);
    fullRefundJob = setup.job;
    fullRefundPayment = setup.payment;

    const refund = await refundService.createRefund({
      paymentId: fullRefundPayment.id,
      reason: 'Job cancelled before dispatch'
    });

    if (refund.status !== 'SUCCESS') throw new Error(`Expected SUCCESS status, got ${refund.status}`);
    if (refund.amount !== 50.0) throw new Error(`Expected amount 50.0, got ${refund.amount}`);

    const updatedPayment = await prisma.payment.findUnique({ where: { id: fullRefundPayment.id } });
    if (updatedPayment.status !== 'REFUNDED') throw new Error(`Expected payment status REFUNDED, got ${updatedPayment.status}`);
  });

  // TEST 2: Successful partial refund
  let partialPayment;
  await test('2. Successful partial refund', async () => {
    const setup = await createPaidJob(100.0);
    partialPayment = setup.payment;

    const refund = await refundService.createRefund({
      paymentId: partialPayment.id,
      amount: 40.0,
      reason: 'Partial sheet misprint'
    });

    if (refund.status !== 'SUCCESS') throw new Error(`Expected SUCCESS, got ${refund.status}`);
    if (refund.amount !== 40.0) throw new Error(`Expected 40.0, got ${refund.amount}`);

    const updatedPayment = await prisma.payment.findUnique({ where: { id: partialPayment.id } });
    if (updatedPayment.status !== 'PARTIALLY_REFUNDED') throw new Error(`Expected PARTIALLY_REFUNDED, got ${updatedPayment.status}`);
  });

  // TEST 3: Multiple partial refunds against one payment
  await test('3. Multiple partial refunds', async () => {
    // Remaining balance on partialPayment is 100 - 40 = 60
    const refund2 = await refundService.createRefund({
      paymentId: partialPayment.id,
      amount: 30.0,
      reason: 'Second partial adjustment'
    });
    if (refund2.amount !== 30.0) throw new Error(`Expected 30.0, got ${refund2.amount}`);

    // Final refund of remaining 30.0
    const refund3 = await refundService.createRefund({
      paymentId: partialPayment.id,
      amount: 30.0,
      reason: 'Final remaining balance refund'
    });
    if (refund3.amount !== 30.0) throw new Error(`Expected 30.0, got ${refund3.amount}`);

    const finalPayment = await prisma.payment.findUnique({ where: { id: partialPayment.id } });
    if (finalPayment.status !== 'REFUNDED') throw new Error(`Expected REFUNDED when fully consumed, got ${finalPayment.status}`);
  });

  // TEST 4: Refund amount exceeding remaining balance rejected
  await test('4. Refund amount exceeding remaining balance rejected', async () => {
    const setup = await createPaidJob(50.0);
    let threw = false;
    try {
      await refundService.createRefund({
        paymentId: setup.payment.id,
        amount: 60.0,
        reason: 'Attempted over-refund exceeding 50.0'
      });
    } catch (err) {
      threw = true;
      if (!err.message.includes('exceeds remaining refundable balance')) {
        throw new Error(`Unexpected error message: ${err.message}`);
      }
    }
    if (!threw) throw new Error('Expected over-refund to throw 400');
  });

  // TEST 5: Refund against failed payment rejected
  await test('5. Refund against failed payment rejected', async () => {
    const setup = await createPaidJob(20.0, false, 'FAILED');
    let threw = false;
    try {
      await refundService.createRefund({ paymentId: setup.payment.id });
    } catch (err) {
      threw = true;
      if (!err.message.includes('Only SUCCESS payments are refundable')) {
        throw new Error(`Unexpected error message: ${err.message}`);
      }
    }
    if (!threw) throw new Error('Expected failed payment refund to be rejected');
  });

  // TEST 6: Refund against pending payment rejected
  await test('6. Refund against pending payment rejected', async () => {
    const setup = await createPaidJob(20.0, false, 'PENDING');
    let threw = false;
    try {
      await refundService.createRefund({ paymentId: setup.payment.id });
    } catch (err) {
      threw = true;
      if (!err.message.includes('Only SUCCESS payments are refundable')) {
        throw new Error(`Unexpected error message: ${err.message}`);
      }
    }
    if (!threw) throw new Error('Expected pending payment refund to be rejected');
  });

  // TEST 7: Demo payment refund rejected
  await test('7. Demo payment refund rejected', async () => {
    const setup = await createPaidJob(30.0, true, 'SUCCESS');
    let threw = false;
    try {
      await refundService.createRefund({ paymentId: setup.payment.id });
    } catch (err) {
      threw = true;
      if (!err.message.includes('Demo/simulated payments cannot be processed through real financial refund channels')) {
        throw new Error(`Unexpected error message: ${err.message}`);
      }
    }
    if (!threw) throw new Error('Expected demo payment refund to be rejected');
  });

  // TEST 8: Duplicate idempotency key handled safely
  await test('8. Duplicate idempotency key handled safely', async () => {
    const setup = await createPaidJob(50.0);
    const key = `idem_${Date.now()}`;

    const r1 = await refundService.createRefund({
      paymentId: setup.payment.id,
      amount: 10.0,
      idempotencyKey: key
    });

    const r2 = await refundService.createRefund({
      paymentId: setup.payment.id,
      amount: 10.0,
      idempotencyKey: key
    });

    if (r1.id !== r2.id) throw new Error(`Idempotent refund returned different ID: ${r1.id} vs ${r2.id}`);
  });

  // TEST 9: Concurrent refund requests cannot over-refund
  await test('9. Concurrent refund requests cannot over-refund', async () => {
    const setup = await createPaidJob(50.0);

    // Two parallel requests attempting to refund 40.0 each (total 80 > 50)
    const results = await Promise.allSettled([
      refundService.createRefund({ paymentId: setup.payment.id, amount: 40.0 }),
      refundService.createRefund({ paymentId: setup.payment.id, amount: 40.0 })
    ]);

    const successes = results.filter(r => r.status === 'fulfilled');
    const failures = results.filter(r => r.status === 'rejected');

    if (successes.length !== 1 || failures.length !== 1) {
      throw new Error(`Expected exactly 1 success and 1 failure, got ${successes.length} successes and ${failures.length} failures`);
    }

    const liveRefunds = await prisma.refund.findMany({ where: { paymentId: setup.payment.id, status: 'SUCCESS' } });
    const totalRefunded = liveRefunds.reduce((sum, r) => sum + r.amount, 0);
    if (totalRefunded > 50.0) throw new Error(`Over-refund occurred! Total refunded: ${totalRefunded}`);
  });

  // TEST 10: Gateway timeout does not cause duplicate refund
  await test('10. Gateway timeout does not cause duplicate refund', async () => {
    const setup = await createPaidJob(50.0);

    // Set mock to simulate timeout
    cashfreeGateway.setMockMode(true, {
      createRefund: async () => ({
        success: false,
        isTimeout: true,
        status: 'FAILED',
        error: 'Gateway timeout'
      })
    });

    const refund = await refundService.createRefund({
      paymentId: setup.payment.id,
      amount: 25.0
    });

    if (refund.status !== 'PROCESSING') {
      throw new Error(`Expected timeout refund to be in PROCESSING state, got ${refund.status}`);
    }
    if (refund.retryEligible !== false) {
      throw new Error('Timeout refund should not be immediately retry-eligible without reconciliation');
    }

    // Reset default mock
    cashfreeGateway.setMockMode(true);
  });

  // TEST 11: Gateway failure handled correctly
  await test('11. Gateway failure handled correctly', async () => {
    const setup = await createPaidJob(50.0);

    cashfreeGateway.setMockMode(true, {
      createRefund: async () => ({
        success: false,
        isTimeout: false,
        status: 'FAILED',
        error: 'Invalid order state on gateway'
      })
    });

    const refund = await refundService.createRefund({
      paymentId: setup.payment.id,
      amount: 20.0
    });

    if (refund.status !== 'FAILED') throw new Error(`Expected FAILED status, got ${refund.status}`);
    if (refund.retryEligible !== true) throw new Error('Legitimate gateway rejection should be marked retry-eligible');

    cashfreeGateway.setMockMode(true);
  });

  // TEST 12: Successful gateway refund is recorded correctly
  await test('12. Successful gateway refund is recorded correctly', async () => {
    const setup = await createPaidJob(25.0);

    const refund = await refundService.createRefund({
      paymentId: setup.payment.id,
      amount: 25.0,
      reason: 'Full order reversal'
    });

    if (!refund.cfRefundId) throw new Error('cfRefundId was not stored on refund record');
    if (!refund.gatewayResponse) throw new Error('gatewayResponse was not stored');

    // Verify audit transaction was recorded
    const txRecord = await prisma.transaction.findFirst({
      where: { paymentId: setup.payment.id, action: 'REFUND_SUCCESS' }
    });
    if (!txRecord) throw new Error('Transaction audit record for REFUND_SUCCESS was not found');
  });

  // =========================================================================
  // CREDIT NOTE TESTS (13 - 20)
  // =========================================================================

  let invoiceTestJob, invoiceRecord;

  // TEST 13: Full refund credit note
  await test('13. Full refund credit note', async () => {
    const setup = await createPaidJob(40.0);
    invoiceTestJob = setup.job;
    invoiceRecord = await generateInvoiceForJob(invoiceTestJob.shortId);

    const refund = await refundService.createRefund({
      paymentId: setup.payment.id,
      amount: 40.0,
      reason: 'Defective print batch full refund'
    });

    const cn = await prisma.creditNote.findFirst({
      where: { refundId: refund.id }
    });

    if (!cn) throw new Error('Credit Note was not automatically created for refund');
    if (cn.totalAmount !== 40.0) throw new Error(`Expected CN amount 40.0, got ${cn.totalAmount}`);
    if (cn.invoiceId !== invoiceRecord.id) throw new Error(`Invoice ID mismatch on CN: ${cn.invoiceId}`);
  });

  // TEST 14: Partial refund credit note
  let partialInvJob, partialInvoice;
  await test('14. Partial refund credit note', async () => {
    const setup = await createPaidJob(100.0);
    partialInvJob = setup.job;
    partialInvoice = await generateInvoiceForJob(partialInvJob.shortId);

    const refund = await refundService.createRefund({
      paymentId: setup.payment.id,
      amount: 40.0,
      reason: 'Partial reprint compensation'
    });

    const cn = await prisma.creditNote.findFirst({ where: { refundId: refund.id } });
    if (!cn) throw new Error('Credit Note not found for partial refund');
    if (cn.totalAmount !== 40.0) throw new Error(`Expected CN amount 40.0, got ${cn.totalAmount}`);

    // Verify invoice status is updated to PARTIALLY_REFUNDED
    const updatedInv = await prisma.invoice.findUnique({ where: { id: partialInvoice.id } });
    if (updatedInv.status !== 'PARTIALLY_REFUNDED') {
      throw new Error(`Expected invoice status PARTIALLY_REFUNDED, got ${updatedInv.status}`);
    }
  });

  // TEST 15: Multiple partial credit notes
  await test('15. Multiple partial credit notes', async () => {
    const setup = await prisma.payment.findUnique({
      where: { id: partialInvoice.paymentId },
      include: { printJobs: true }
    });

    const refund2 = await refundService.createRefund({
      paymentId: setup.id,
      amount: 30.0,
      reason: 'Second partial adjustment'
    });

    const allCns = await prisma.creditNote.findMany({ where: { invoiceId: partialInvoice.id } });
    if (allCns.length !== 2) throw new Error(`Expected 2 Credit Notes on invoice, got ${allCns.length}`);

    const totalCnAmount = allCns.reduce((sum, c) => sum + c.totalAmount, 0);
    if (totalCnAmount !== 70.0) throw new Error(`Expected total credited 70.0, got ${totalCnAmount}`);
  });

  // TEST 16: Credit notes cannot exceed original invoice amounts
  await test('16. Credit notes cannot exceed original invoice amounts', async () => {
    // Invoice total was 100, 70 already credited, remaining is 30. Try crediting 35 directly.
    let threw = false;
    try {
      await issueCreditNoteForInvoice(partialInvoice.id, {
        amount: 35.0,
        reason: 'Attempt to over-credit invoice'
      });
    } catch (err) {
      threw = true;
      if (!err.message.includes('exceeds remaining creditable invoice balance')) {
        throw new Error(`Unexpected error message: ${err.message}`);
      }
    }
    if (!threw) throw new Error('Expected over-crediting invoice to throw 400');
  });

  // TEST 17: Original invoice remains unchanged
  await test('17. Original invoice remains unchanged', async () => {
    const freshInvoice = await prisma.invoice.findUnique({ where: { id: partialInvoice.id } });

    // Financial columns must remain preserved
    if (freshInvoice.totalAmount !== partialInvoice.totalAmount) {
      throw new Error(`Original totalAmount mutated! ${freshInvoice.totalAmount} vs ${partialInvoice.totalAmount}`);
    }
    if (freshInvoice.subtotal !== partialInvoice.subtotal) {
      throw new Error('Original subtotal was mutated');
    }
    if (freshInvoice.pdfPath !== partialInvoice.pdfPath) {
      throw new Error('Original invoice PDF path was mutated');
    }
  });

  // TEST 18: Duplicate credit note prevented
  await test('18. Duplicate credit note prevented', async () => {
    const existingCn = await prisma.creditNote.findFirst({ where: { invoiceId: partialInvoice.id } });

    const duplicateCn = await issueCreditNoteForInvoice(partialInvoice.id, {
      refundId: existingCn.refundId,
      amount: existingCn.totalAmount
    });

    if (duplicateCn.id !== existingCn.id) {
      throw new Error(`Expected same CN record to be returned idempotently, got ${duplicateCn.id}`);
    }
  });

  // TEST 19: Credit note number concurrency safety
  await test('19. Credit note number concurrency safety', async () => {
    const setup = await createPaidJob(90.0);
    const inv = await generateInvoiceForJob(setup.job.shortId);

    // Concurrently issue 3 partial credit notes of 20.0 each (total 60 <= 90)
    const cns = await Promise.all([
      issueCreditNoteForInvoice(inv.id, { amount: 20.0, reason: 'Parallel CN 1' }),
      issueCreditNoteForInvoice(inv.id, { amount: 20.0, reason: 'Parallel CN 2' }),
      issueCreditNoteForInvoice(inv.id, { amount: 20.0, reason: 'Parallel CN 3' })
    ]);

    const cnNumbers = cns.map(c => c.creditNoteNumber);
    const uniqueNumbers = new Set(cnNumbers);

    if (uniqueNumbers.size !== 3) {
      throw new Error(`Credit note number collision detected: ${cnNumbers.join(', ')}`);
    }
  });

  // TEST 20: PDF credit note generation and preservation
  await test('20. PDF credit note generation and preservation', async () => {
    const setup = await createPaidJob(30.0);
    const inv = await generateInvoiceForJob(setup.job.shortId);

    const cn = await issueCreditNoteForInvoice(inv.id, {
      amount: 30.0,
      reason: 'Physical PDF Verification Test'
    });

    const cnPdfPath = path.join(INVOICE_DIR, `${cn.creditNoteNumber}.pdf`);
    if (!fs.existsSync(cnPdfPath)) {
      throw new Error(`Physical PDF Credit Note was not found at ${cnPdfPath}`);
    }

    const stat = fs.statSync(cnPdfPath);
    if (stat.size < 1000) {
      throw new Error(`Credit Note PDF is abnormally small: ${stat.size} bytes`);
    }
  });

  // =========================================================================
  // RECONCILIATION TESTS (21 - 28)
  // =========================================================================

  // TEST 21: Matching payment and gateway records
  await test('21. Matching payment and gateway records', async () => {
    const setup = await createPaidJob(50.0);

    cashfreeGateway.setMockMode(true, {
      getOrderPayments: async (orderId) => ({
        success: true,
        payments: [{ payment_status: 'SUCCESS', payment_amount: 50.0 }]
      })
    });

    const res = await reconciliationService.runReconciliation({ dryRun: true });
    if (!res.success) throw new Error('Reconciliation run failed');
  });

  // TEST 22: Gateway refund success with internal pending state
  await test('22. Gateway refund success with internal pending state', async () => {
    const setup = await createPaidJob(30.0);

    // Create a local refund stuck in PENDING status
    const pendingRefund = await prisma.refund.create({
      data: {
        paymentId: setup.payment.id,
        gatewayRefundId: `ref_recon_${Date.now()}`,
        amount: 30.0,
        status: 'PENDING',
        reason: 'Simulated pending refund'
      }
    });

    // Mock Gateway returning SUCCESS for this refund
    cashfreeGateway.setMockMode(true, {
      getRefundDetails: async (orderId, refId) => ({
        success: true,
        status: 'SUCCESS',
        cfRefundId: 'cf_ref_recon_confirmed',
        rawResponse: { refund_status: 'SUCCESS' }
      })
    });

    // Run reconciliation
    await reconciliationService.runReconciliation({ dryRun: false });

    // Assert refund was automatically advanced to SUCCESS
    const updated = await prisma.refund.findUnique({ where: { id: pendingRefund.id } });
    if (updated.status !== 'SUCCESS') {
      throw new Error(`Expected reconciliation to update refund to SUCCESS, got ${updated.status}`);
    }
  });

  // TEST 23: Amount mismatch detection
  await test('23. Amount mismatch detection', async () => {
    const setup = await createPaidJob(50.0);

    // Mock Gateway reporting different amount (40 vs 50)
    cashfreeGateway.setMockMode(true, {
      getOrderPayments: async () => ({
        success: true,
        payments: [{ payment_status: 'SUCCESS', payment_amount: 40.0 }]
      })
    });

    const res = await reconciliationService.runReconciliation({ dryRun: false });
    const mismatch = res.findings.find(f => f.discrepancyType === 'PAYMENT_AMOUNT_MISMATCH');
    if (!mismatch) throw new Error('Expected PAYMENT_AMOUNT_MISMATCH discrepancy to be flagged');
  });

  // TEST 24: Duplicate webhook detection
  await test('24. Duplicate webhook detection', async () => {
    const testOrderId = `order_dup_${Date.now()}`;

    // Insert 2 events for the same order and eventType
    await prisma.paymentEvent.create({
      data: {
        eventId: `ev1_${Date.now()}`,
        eventType: 'PAYMENT_SUCCESS_WEBHOOK',
        gatewayOrderId: testOrderId,
        payload: '{}'
      }
    });

    await prisma.paymentEvent.create({
      data: {
        eventId: `ev2_${Date.now()}`,
        eventType: 'PAYMENT_SUCCESS_WEBHOOK',
        gatewayOrderId: testOrderId,
        payload: '{}'
      }
    });

    const res = await reconciliationService.runReconciliation({ dryRun: true });
    const dupFlag = res.findings.find(f => f.discrepancyType === 'DUPLICATE_WEBHOOK_EVENT');
    if (!dupFlag) throw new Error('Expected DUPLICATE_WEBHOOK_EVENT to be flagged');
  });

  // TEST 25: Invalid webhook signature rejected
  await test('25. Invalid webhook signature rejected', async () => {
    const fakeRawBody = JSON.stringify({ data: { order: { order_id: 'test' } } });
    const timestamp = Date.now().toString();
    const fakeSignature = 'invalid_tampered_signature_base64==';

    const isValid = cashfreeGateway.verifyWebhookSignature(fakeSignature, fakeRawBody, timestamp);
    if (isValid !== false) throw new Error('Expected tampered signature to be rejected as false');
  });

  // TEST 26: Missing transaction ledger entry detected
  await test('26. Missing transaction ledger entry detected', async () => {
    // Create payment without any transaction
    const orphanPayment = await prisma.payment.create({
      data: {
        amount: 25.0,
        currency: 'INR',
        type: 'PRINT_JOB',
        status: 'SUCCESS',
        paymentMethod: 'cashfree_upi',
        gatewayOrderId: `order_notx_${Date.now()}`
      }
    });

    cashfreeGateway.setMockMode(true, {
      getOrderPayments: async () => ({
        success: true,
        payments: [{ payment_status: 'SUCCESS', payment_amount: 25.0 }]
      })
    });

    const res = await reconciliationService.runReconciliation({ dryRun: false });
    const missingTx = res.findings.find(
      f => f.paymentId === orphanPayment.id && f.discrepancyType === 'MISSING_TRANSACTION'
    );
    if (!missingTx) throw new Error('Expected MISSING_TRANSACTION to be flagged for payment lacking ledger entry');
  });

  // TEST 27: Manual resolution requires authorized admin
  await test('27. Manual resolution requires authorized admin', async () => {
    const rec = await prisma.reconciliationRecord.create({
      data: {
        status: 'MANUAL_REVIEW_REQUIRED',
        discrepancyType: 'TEST_MANUAL_ESCALATION',
        details: 'Manual verification required by auditor'
      }
    });

    // Rejects empty resolution note
    let threw = false;
    try {
      await reconciliationService.resolveDiscrepancy(rec.id, { resolutionNotes: '   ' });
    } catch (err) {
      threw = true;
      if (!err.message.includes('valid resolution note')) {
        throw new Error(`Unexpected error message: ${err.message}`);
      }
    }
    if (!threw) throw new Error('Expected empty resolution notes to be rejected');

    // Valid resolution
    const resolved = await reconciliationService.resolveDiscrepancy(rec.id, {
      resolutionNotes: 'Verified with bank statement: payment cleared successfully',
      user: { id: 'admin_test_1' }
    });

    if (resolved.resolved !== true) throw new Error('Expected resolved to be true');
    if (resolved.resolvedBy !== 'admin_test_1') throw new Error(`Expected resolvedBy admin_test_1, got ${resolved.resolvedBy}`);
  });

  // TEST 28: Repeated reconciliation is idempotent
  await test('28. Repeated reconciliation is idempotent', async () => {
    const countBefore = await prisma.reconciliationRecord.count();
    await reconciliationService.runReconciliation({ dryRun: false });
    const countAfter = await prisma.reconciliationRecord.count();

    // Second run should not create duplicate open records
    await reconciliationService.runReconciliation({ dryRun: false });
    const countFinal = await prisma.reconciliationRecord.count();

    if (countFinal !== countAfter) {
      throw new Error(`Reconciliation created duplicate records on subsequent run: ${countAfter} -> ${countFinal}`);
    }
  });

  // HISTORICAL & PRINTING FIXTURE SAFETY CHECK:
  // Verify reconciliation never alters active PRINTING jobs or existing historical ab36197e row
  await test('Historical Safety: Active PRINTING fixture and historical ab36197e remain untouched', async () => {
    const isolatedJob = await prisma.printJob.findUnique({
      where: { id: printingFixture.id },
      include: { printHistory: true, payment: true }
    });

    if (!isolatedJob || isolatedJob.status !== 'PRINTING' || isolatedJob.cost !== 50.0) {
      throw new Error('Isolated PRINTING fixture status or cost was altered by reconciliation!');
    }
    if (isolatedJob.printHistory.length === 0 || isolatedJob.printHistory[0].success !== false) {
      throw new Error('Isolated PRINTING fixture print history was altered!');
    }

    if (ab36197eBefore) {
      const ab36197eAfter = await prisma.printJob.findUnique({
        where: { shortId: 'ab36197e' },
        select: { status: true, cost: true, updatedAt: true }
      });
      if (
        !ab36197eAfter ||
        ab36197eAfter.status !== ab36197eBefore.status ||
        ab36197eAfter.cost !== ab36197eBefore.cost ||
        ab36197eAfter.updatedAt.getTime() !== ab36197eBefore.updatedAt.getTime()
      ) {
        throw new Error('Existing historical job ab36197e was altered during Phase 4 suite!');
      }
    }
  });

  // TEST 30: Authorized Admin REST APIs for Refunds & Reconciliation
  await test('30. Authorized Admin REST APIs for Refunds & Reconciliation', async () => {
    const express = require('express');
    const request = require('supertest');
    const jwt = require('jsonwebtoken');
    const adminRoutes = require('../src/modules/admin/admin.routes');
    const { errorHandler } = require('../src/middlewares/error');

    const app = express();
    app.use(express.json());
    app.use('/api/admin', adminRoutes);
    app.use(errorHandler);

    // Find or create superadmin
    let superadmin = await prisma.user.findFirst({ where: { role: 'SUPERADMIN' } });
    if (!superadmin) {
      superadmin = await prisma.user.create({
        data: {
          name: 'Super Admin',
          email: 'admin_phase4@printgo.local',
          password: 'mock_password_hash',
          role: 'SUPERADMIN'
        }
      });
    }

    const adminToken = jwt.sign({ id: superadmin.id }, process.env.JWT_SECRET, { expiresIn: '1h' });

    // 1. Unauthenticated request rejected (401)
    const unauthRes = await request(app).get('/api/admin/refunds');
    if (unauthRes.status !== 401) {
      throw new Error(`Expected 401 for unauthenticated admin request, got ${unauthRes.status}`);
    }

    // 2. Authenticated GET /api/admin/refunds
    const refundsRes = await request(app)
      .get('/api/admin/refunds')
      .set('Authorization', `Bearer ${adminToken}`);
    if (refundsRes.status !== 200 || !refundsRes.body.success) {
      throw new Error(`Expected 200 for GET /api/admin/refunds, got ${refundsRes.status}`);
    }

    // 3. Authenticated GET /api/admin/reconciliation
    const reconRes = await request(app)
      .get('/api/admin/reconciliation')
      .set('Authorization', `Bearer ${adminToken}`);
    if (reconRes.status !== 200 || !reconRes.body.success) {
      throw new Error(`Expected 200 for GET /api/admin/reconciliation, got ${reconRes.status}`);
    }

    // 4. Authenticated POST /api/admin/refunds
    const setup = await createPaidJob(35.0);
    const postRefundRes = await request(app)
      .post('/api/admin/refunds')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        paymentId: setup.payment.id,
        amount: 35.0,
        reason: 'Admin initiated full refund test'
      });
    if (postRefundRes.status !== 201 || !postRefundRes.body.success) {
      throw new Error(`Expected 201 for POST /api/admin/refunds, got ${postRefundRes.status}`);
    }
  });

  console.log('\n======================================================================');
  console.log(`PHASE 4 TEST RESULTS: ${passed} PASSED, ${failed} FAILED (Total: ${passed + failed})`);
  console.log('======================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runTestSuite()
  .catch(err => {
    console.error('Phase 4 test suite execution error:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
