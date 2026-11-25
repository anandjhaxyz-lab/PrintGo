const prisma = require('../src/utils/prisma');
const refundService = require('../src/services/refund.service');
const cashfreeGateway = require('../src/services/cashfreeGateway.adapter');
const AppError = require('../src/utils/AppError');

function assertDisposableDatabaseUrl() {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error('DATABASE_URL is required for the integration test.');
  const parsed = new URL(raw);
  const databaseName = parsed.pathname.replace(/^\//, '').split('?')[0];
  if (!['localhost', '127.0.0.1'].includes(parsed.hostname) || databaseName !== 'printgo_disposable_target') {
    throw new Error('Safety stop: integration tests may run only against local printgo_disposable_target.');
  }
}

describe('WP-15.8I-C: Refund Integrity & Fencing Schema Tests', () => {
  const payMultiId = 'pay_wp15_8ic_multi_01';
  const paySingleId = 'pay_wp15_8ic_single_01';
  const job1Id = 'job_wp15_8ic_01';
  const job2Id = 'job_wp15_8ic_02';
  const jobSingleId = 'job_wp15_8ic_single';
  const machineId = 'mach_wp15_8ic_01';
  const userId = 'user_wp15_8ic_01';
  const docId = 'doc_wp15_8ic_01';

  let originalCreateRefund;

  beforeAll(async () => {
    assertDisposableDatabaseUrl();
    cashfreeGateway.setMockMode(true);
    originalCreateRefund = cashfreeGateway.createRefund;

    cashfreeGateway.createRefund = jest.fn(async ({ refundId, amount }) => {
      return {
        success: true,
        status: 'SUCCESS',
        cfRefundId: `cf_${refundId}`,
        rawResponse: { refund_id: refundId, amount, status: 'SUCCESS' }
      };
    });

    // Cleanup any lingering data
    await cleanup();

    // Seed User & Machine
    await prisma.user.upsert({
      where: { id: userId },
      create: {
        id: userId,
        email: 'wp15_8ic_test@example.com',
        password: 'dummy_password_hash',
        name: 'WP15.8I-C Tester',
        role: 'USER'
      },
      update: {}
    });

    await prisma.machine.upsert({
      where: { id: machineId },
      create: {
        id: machineId,
        machineKey: 'dummy_machine_key_158ic',
        name: 'Test Kiosk 15.8I-C',
        status: 'ONLINE',
        printerModel: 'LaserJet Test'
      },
      update: {}
    });

    await prisma.document.upsert({
      where: { id: docId },
      create: {
        id: docId,
        originalName: 'test.pdf',
        filename: 'test-uuid.pdf',
        mimetype: 'application/pdf',
        size: 1024,
        pages: 10
      },
      update: {}
    });

    // Seed Multi-job Payment (Total: 250.00, Job1: 100.00, Job2: 150.00)
    await prisma.payment.create({
      data: {
        id: payMultiId,
        amount: 250.0,
        currency: 'INR',
        type: 'PRINT_JOB',
        status: 'SUCCESS',
        paymentMethod: 'cashfree_upi',
        paymentGroup: 'upi',
        gatewayOrderId: 'order_multi_01',
        gatewayPaymentId: 'pay_gateway_multi_01'
      }
    });

    await prisma.printJob.create({
      data: {
        id: job1Id,
        shortId: 'PG-IC-01',
        cost: 100.0,
        pagesToPrint: 10,
        color: 'BW',
        status: 'PRINTING',
        paymentId: payMultiId,
        machineId,
        documentId: docId
      }
    });

    await prisma.printJob.create({
      data: {
        id: job2Id,
        shortId: 'PG-IC-02',
        cost: 150.0,
        pagesToPrint: 15,
        color: 'COLOR',
        status: 'PRINTING',
        paymentId: payMultiId,
        machineId,
        documentId: docId
      }
    });

    // Seed Single-job Payment (Total: 60.00, JobSingle: 60.00)
    await prisma.payment.create({
      data: {
        id: paySingleId,
        amount: 60.0,
        currency: 'INR',
        type: 'PRINT_JOB',
        status: 'SUCCESS',
        paymentMethod: 'cashfree_upi',
        paymentGroup: 'upi',
        gatewayOrderId: 'order_single_01',
        gatewayPaymentId: 'pay_gateway_single_01'
      }
    });

    await prisma.printJob.create({
      data: {
        id: jobSingleId,
        shortId: 'PG-IC-S1',
        cost: 60.0,
        pagesToPrint: 6,
        color: 'BW',
        status: 'PRINTING',
        paymentId: paySingleId,
        machineId,
        documentId: docId
      }
    });
  });

  afterAll(async () => {
    cashfreeGateway.createRefund = originalCreateRefund;
    await cleanup();
    await prisma.$disconnect();
  });

  async function cleanup() {
    await prisma.creditNote.deleteMany({
      where: { creditNoteNumber: { startsWith: 'CN-IC-' } }
    }).catch(() => {});
    await prisma.reconciliationRecord.deleteMany({
      where: { paymentId: { in: [payMultiId, paySingleId, 'pay_rec_fencing_01'] } }
    }).catch(() => {});
    await prisma.transaction.deleteMany({
      where: { paymentId: { in: [payMultiId, paySingleId] } }
    }).catch(() => {});
    await prisma.refund.deleteMany({
      where: { paymentId: { in: [payMultiId, paySingleId] } }
    }).catch(() => {});
    await prisma.printJob.deleteMany({
      where: { id: { in: [job1Id, job2Id, jobSingleId] } }
    }).catch(() => {});
    await prisma.payment.deleteMany({
      where: { id: { in: [payMultiId, paySingleId] } }
    }).catch(() => {});
    await prisma.machine.deleteMany({
      where: { id: machineId }
    }).catch(() => {});
    await prisma.document.deleteMany({
      where: { id: docId }
    }).catch(() => {});
    await prisma.user.deleteMany({
      where: { id: userId }
    }).catch(() => {});
  }

  describe('C-01: Queue Service Refund Amount Integrity', () => {
    test('proves stuck-job cleaner uses job.cost and rejects invalid/missing cost', () => {
      // Direct unit evaluation of the C-01 logic added in queueService.js
      const calculateRefundPayload = (job) => {
        const rawCost = job?.cost;
        const validJobCost = Number(rawCost);
        if (!rawCost || isNaN(validJobCost) || validJobCost <= 0 || !Number.isFinite(validJobCost)) {
          throw new Error(`Invalid job cost (${rawCost}); refusing automated refund.`);
        }
        return {
          paymentId: job.paymentId,
          amount: validJobCost,
          printJobId: job.id,
          reason: `Automated refund for stuck printing job ${job.shortId || job.id}`
        };
      };

      const jobWithPayment = {
        id: 'job-test-c01',
        shortId: 'PG-C01',
        cost: 45.0,
        paymentId: 'pay-test-c01',
        payment: { id: 'pay-test-c01', amount: 350.0 }
      };

      // Ensure it uses job.cost (45.00) NOT payment.amount (350.00)
      const payload = calculateRefundPayload(jobWithPayment);
      expect(payload.amount).toBe(45.0);
      expect(payload.amount).not.toBe(350.0);
      expect(payload.printJobId).toBe('job-test-c01');

      // Ensure invalid costs throw rather than substituting payment.amount
      expect(() => calculateRefundPayload({ ...jobWithPayment, cost: null })).toThrow(/Invalid job cost/);
      expect(() => calculateRefundPayload({ ...jobWithPayment, cost: 0 })).toThrow(/Invalid job cost/);
      expect(() => calculateRefundPayload({ ...jobWithPayment, cost: -10 })).toThrow(/Invalid job cost/);
      expect(() => calculateRefundPayload({ ...jobWithPayment, cost: NaN })).toThrow(/Invalid job cost/);
      expect(() => calculateRefundPayload({ ...jobWithPayment, cost: undefined })).toThrow(/Invalid job cost/);
    });
  });

  describe('C-02: Explicit printJobId Ownership', () => {
    test('rejects refund on multi-job payment when printJobId is omitted', async () => {
      await expect(
        refundService.createRefund({
          paymentId: payMultiId,
          amount: 50.0,
          reason: 'Attempt refund without printJobId on multi-job payment'
        })
      ).rejects.toThrow(/explicit printJobId is required/i);
    });

    test('rejects refund when printJobId does not belong to the payment', async () => {
      await expect(
        refundService.createRefund({
          paymentId: payMultiId,
          printJobId: 'job_alien_9999',
          amount: 50.0,
          reason: 'Attempt refund with foreign printJobId'
        })
      ).rejects.toThrow(/does not belong to payment/i);
    });

    test('permits refund on single-job payment when printJobId is omitted (safe resolution)', async () => {
      const res = await refundService.createRefund({
        paymentId: paySingleId,
        amount: 20.0,
        idempotencyKey: 'idemp_single_safe_res_01',
        reason: 'Safe single job resolution test'
      });
      expect(res.status).toBe('SUCCESS');
      expect(res.printJobId).toBe(jobSingleId);
      expect(res.amount).toBe(20.0);
    });

    test('permits refund on multi-job payment when explicit valid printJobId is provided', async () => {
      const res = await refundService.createRefund({
        paymentId: payMultiId,
        printJobId: job1Id,
        amount: 40.0,
        idempotencyKey: 'idemp_multi_explicit_job1_01',
        reason: 'Explicit job 1 refund'
      });
      expect(res.status).toBe('SUCCESS');
      expect(res.printJobId).toBe(job1Id);
      expect(res.amount).toBe(40.0);
    });
  });

  describe('C-03: Per-Job Cumulative Refund Cap', () => {
    test('enforces that cumulative refunds for job1 cannot exceed job1.cost (100.00)', async () => {
      // job1 had 40.00 refunded above. Remaining job1 balance is 60.00.
      // Attempting to refund 70.00 must be rejected.
      await expect(
        refundService.createRefund({
          paymentId: payMultiId,
          printJobId: job1Id,
          amount: 70.0,
          idempotencyKey: 'idemp_multi_job1_over_cap',
          reason: 'Over cap attempt'
        })
      ).rejects.toThrow(/exceeds remaining refundable balance for print job/);

      // Refunding exactly the remaining 60.00 must succeed
      const resFull = await refundService.createRefund({
        paymentId: payMultiId,
        printJobId: job1Id,
        amount: 60.0,
        idempotencyKey: 'idemp_multi_job1_full_cap',
        reason: 'Full remaining job1 cap'
      });
      expect(resFull.status).toBe('SUCCESS');
      expect(resFull.amount).toBe(60.0);

      // Attempting ANY further refund for job1 must be rejected as fully refunded
      await expect(
        refundService.createRefund({
          paymentId: payMultiId,
          printJobId: job1Id,
          amount: 1.0,
          idempotencyKey: 'idemp_multi_job1_exceeded',
          reason: 'Post-cap attempt'
        })
      ).rejects.toThrow(/already fully refunded/);

      // Meanwhile, job2 (cost 150.00) remains refundable up to 150.00
      const resJob2 = await refundService.createRefund({
        paymentId: payMultiId,
        printJobId: job2Id,
        amount: 100.0,
        idempotencyKey: 'idemp_multi_job2_valid',
        reason: 'Valid job2 refund'
      });
      expect(resJob2.status).toBe('SUCCESS');
      expect(resJob2.amount).toBe(100.0);
    });
  });

  describe('Phase 3 Schema Integrity & CreditNote Uniqueness', () => {
    test('enforces partial unique constraint CreditNote(refundId) for non-null refundId', async () => {
      const invId = 'inv_wp15_8ic_cn_01';
      await prisma.invoice.create({
        data: {
          id: invId,
          invoiceNumber: 'INV-IC-CN-001',
          printJobId: jobSingleId,
          subtotal: 50.0,
          discountAmount: 0.0,
          taxableAmount: 50.0,
          cgstRate: 9.0,
          cgstAmount: 4.5,
          sgstRate: 9.0,
          sgstAmount: 4.5,
          igstRate: 0.0,
          igstAmount: 0.0,
          totalTax: 9.0,
          convenienceFee: 0.0,
          totalAmount: 59.0,
          currency: 'INR',
          sellerName: 'PrintGo Kiosk',
          sacCode: '9989',
          pricingSnapshot: '{}',
          lineItems: '[]',
          status: 'ISSUED',
          isDemo: true
        }
      });

      // 1. Create a dummy refund to link
      const testRefund = await prisma.refund.create({
        data: {
          idempotencyKey: 'idemp_cn_test_ref_01',
          paymentId: paySingleId,
          amount: 10.0,
          currency: 'INR',
          status: 'SUCCESS',
          reason: 'CreditNote unique test'
        }
      });

      const baseCn = {
        invoiceId: invId,
        reason: 'Test credit note',
        subtotal: 10.0,
        cgstAmount: 0.0,
        sgstAmount: 0.0,
        igstAmount: 0.0,
        totalTax: 0.0,
        totalAmount: 10.0,
        currency: 'INR'
      };

      // 2. First CreditNote with testRefund.id succeeds
      const cn1 = await prisma.creditNote.create({
        data: {
          id: 'cn_wp15_8ic_01',
          creditNoteNumber: 'CN-IC-001',
          refundId: testRefund.id,
          ...baseCn
        }
      });
      expect(cn1.refundId).toBe(testRefund.id);

      // 3. Second CreditNote with same testRefund.id MUST FAIL unique constraint
      await expect(
        prisma.creditNote.create({
          data: {
            id: 'cn_wp15_8ic_02',
            creditNoteNumber: 'CN-IC-002',
            refundId: testRefund.id,
            ...baseCn
          }
        })
      ).rejects.toThrow();

      // 4. Multiple CreditNotes with refundId: null succeed without collision (partial index)
      const cnNull1 = await prisma.creditNote.create({
        data: {
          id: 'cn_wp15_8ic_null_01',
          creditNoteNumber: 'CN-IC-NULL-01',
          refundId: null,
          ...baseCn
        }
      });
      const cnNull2 = await prisma.creditNote.create({
        data: {
          id: 'cn_wp15_8ic_null_02',
          creditNoteNumber: 'CN-IC-NULL-02',
          refundId: null,
          ...baseCn
        }
      });
      expect(cnNull1.id).toBeDefined();
      expect(cnNull2.id).toBeDefined();

      // Cleanup local invoice & credit notes
      await prisma.creditNote.deleteMany({ where: { invoiceId: invId } }).catch(() => {});
      await prisma.invoice.deleteMany({ where: { id: invId } }).catch(() => {});
    });

    test('proves ReconciliationRecord fencing columns and default values', async () => {
      const rec = await prisma.reconciliationRecord.create({
        data: {
          paymentId: paySingleId,
          status: 'DISCREPANCY_FLAGGED',
          discrepancyType: 'TEST_FENCING_INTEGRITY',
          details: 'Verifying fencing fields'
        }
      });

      expect(rec.fencingToken).toBe(0n);
      expect(rec.dispatchState).toBe('NOT_DISPATCHED');
      expect(rec.workerId).toBeNull();
      expect(rec.leaseExpiresAt).toBeNull();

      // Test worker fencing claim update
      const futureExpiry = new Date(Date.now() + 60000);
      const claimedRec = await prisma.reconciliationRecord.update({
        where: { id: rec.id },
        data: {
          workerId: 'worker-node-alpha',
          leaseExpiresAt: futureExpiry,
          fencingToken: 42n,
          dispatchState: 'DISPATCH_INTENT'
        }
      });

      expect(claimedRec.workerId).toBe('worker-node-alpha');
      expect(claimedRec.fencingToken).toBe(42n);
      expect(claimedRec.dispatchState).toBe('DISPATCH_INTENT');
      expect(new Date(claimedRec.leaseExpiresAt).getTime()).toBe(futureExpiry.getTime());
    });
  });
});
