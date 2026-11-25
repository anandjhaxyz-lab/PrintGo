/**
 * WP-15.8I-F: Operational Wiring & Fencing Closure Remediation Integration Tests
 * Strict Safety: Local Disposable PostgreSQL 16 on port 5433 with Mocked Cashfree Gateway
 */

const prisma = require('../src/utils/prisma');
const reconciliationWorker = require('../src/services/reconciliationWorker.service');
const cashfreeGateway = require('../src/services/cashfreeGateway.adapter');
const refundService = require('../src/services/refund.service');

function assertDisposableDatabaseUrl() {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error('DATABASE_URL is required for the integration test.');
  const parsed = new URL(raw);
  const databaseName = parsed.pathname.replace(/^\//, '').split('?')[0];
  if (!['localhost', '127.0.0.1'].includes(parsed.hostname) || databaseName !== 'printgo_disposable_target') {
    throw new Error('Safety stop: integration tests may run only against local printgo_disposable_target.');
  }
}

describe('WP-15.8I-F: Operational Lifecycle, Clock Semantics & Ambiguous Outcome Tests', () => {
  const paymentId = 'pay_wp15_8if_01';
  const machineId = 'mach_wp15_8if_01';
  const docId = 'doc_wp15_8if_01';
  const jobId = 'job_wp15_8if_01';

  let originalCreateRefund;
  let originalGetRefundDetails;

  beforeAll(async () => {
    assertDisposableDatabaseUrl();
    cashfreeGateway.setMockMode(true);
    originalCreateRefund = cashfreeGateway.createRefund;
    originalGetRefundDetails = cashfreeGateway.getRefundDetails;

    await cleanup();

    await prisma.machine.upsert({
      where: { id: machineId },
      create: {
        id: machineId,
        machineKey: 'dummy_machine_key_158if',
        name: 'Test Kiosk 15.8I-F',
        status: 'ONLINE',
        printerModel: 'LaserJet 15.8I-F'
      },
      update: {}
    });

    await prisma.document.upsert({
      where: { id: docId },
      create: {
        id: docId,
        originalName: 'test_158if.pdf',
        filename: 'test_158if_uuid.pdf',
        mimetype: 'application/pdf',
        size: 2048,
        pages: 5
      },
      update: {}
    });

    await prisma.payment.create({
      data: {
        id: paymentId,
        amount: 100.0,
        currency: 'INR',
        type: 'PRINT_JOB',
        status: 'SUCCESS',
        paymentMethod: 'upi',
        paymentGroup: 'upi',
        gatewayOrderId: 'cf_order_wp15_8if_01',
        gatewayPaymentId: 'cf_pay_wp15_8if_01'
      }
    });

    await prisma.printJob.create({
      data: {
        id: jobId,
        shortId: 'PJ-8IF-01',
        paymentId,
        machineId,
        documentId: docId,
        status: 'FAILED',
        cost: 100.0,
        pagesToPrint: 5,
        color: 'BW'
      }
    });
  });

  afterAll(async () => {
    cashfreeGateway.createRefund = originalCreateRefund;
    cashfreeGateway.getRefundDetails = originalGetRefundDetails;
    await reconciliationWorker.stopReconciliationWorkerLoop({ timeoutMs: 2000 });
    await cleanup();
    await prisma.$disconnect();
  });

  async function cleanup() {
    await prisma.creditNote.deleteMany({ where: { invoice: { printJobs: { some: { paymentId: { startsWith: 'pay_wp15_8if' } } } } } }).catch(() => {});
    await prisma.transaction.deleteMany({ where: { paymentId: { startsWith: 'pay_wp15_8if' } } }).catch(() => {});
    await prisma.reconciliationRecord.deleteMany({ where: { paymentId: { startsWith: 'pay_wp15_8if' } } }).catch(() => {});
    await prisma.reconciliationRecord.deleteMany({ where: { discrepancyType: { startsWith: 'TEST_8IF_' } } }).catch(() => {});
    await prisma.refund.deleteMany({ where: { paymentId: { startsWith: 'pay_wp15_8if' } } }).catch(() => {});
    await prisma.printJob.deleteMany({ where: { paymentId: { startsWith: 'pay_wp15_8if' } } }).catch(() => {});
    await prisma.payment.deleteMany({ where: { id: { startsWith: 'pay_wp15_8if' } } }).catch(() => {});
  }

  // =========================================================================
  // SECTION 1: WORKER OPERATIONAL LIFECYCLE (BLOCKER 1)
  // =========================================================================
  describe('Worker Operational Lifecycle', () => {
    afterEach(async () => {
      await reconciliationWorker.stopReconciliationWorkerLoop({ timeoutMs: 2000 });
    });

    test('Test 1: Worker health reports disabled when loop is not started', () => {
      const health = reconciliationWorker.getReconciliationWorkerHealth();
      expect(health.enabled).toBe(false);
      expect(health.status).toBe('disabled');
      expect(health.ready).toBe(true);
    });

    test('Test 2: startReconciliationWorkerLoop is a singleton and ignores duplicate starts', async () => {
      const health1 = await reconciliationWorker.startReconciliationWorkerLoop({
        pollIntervalMs: 5000,
        batchSize: 2,
        initialDelayMs: 500
      });
      expect(health1.enabled).toBe(true);
      expect(health1.status).toBe('starting');

      // Duplicate start should return current health and not re-initialize
      const health2 = await reconciliationWorker.startReconciliationWorkerLoop({
        pollIntervalMs: 10000
      });
      expect(health2.workerId).toBe(health1.workerId);
    });

    test('Test 3: Graceful shutdown stops future runs and reports cleanly', async () => {
      await reconciliationWorker.startReconciliationWorkerLoop({
        pollIntervalMs: 5000,
        initialDelayMs: 2000
      });

      const stopResult = await reconciliationWorker.stopReconciliationWorkerLoop({ timeoutMs: 2000 });
      expect(stopResult.stopped).toBe(true);

      const health = reconciliationWorker.getReconciliationWorkerHealth();
      expect(health.enabled).toBe(false);
      expect(health.status).toBe('disabled');
    });

    test('Test 4: Worker loop handles batch execution and reports healthy upon completion', async () => {
      const health = await reconciliationWorker.startReconciliationWorkerLoop({
        pollIntervalMs: 1000,
        batchSize: 2,
        initialDelayMs: 50,
        runImmediately: true
      });

      // Wait briefly for first immediate batch to complete
      await new Promise(r => setTimeout(r, 200));

      const updatedHealth = reconciliationWorker.getReconciliationWorkerHealth();
      expect(updatedHealth.enabled).toBe(true);
      expect(updatedHealth.status).toBe('healthy');
      expect(updatedHealth.ready).toBe(true);
      expect(updatedHealth.consecutiveFailures).toBe(0);
      expect(updatedHealth.lastRunCompletedAt).toBeDefined();
    });
  });

  // =========================================================================
  // SECTION 2: POSTGRESQL LEASE CLOCK CORRECTNESS (BLOCKER 2)
  // =========================================================================
  describe('PostgreSQL Lease Clock Correctness (clock_timestamp)', () => {
    test('Test 5: Lease renewal succeeds within valid lease duration using clock_timestamp', async () => {
      const rec = await prisma.reconciliationRecord.create({
        data: {
          discrepancyType: 'TEST_8IF_CLOCK_VALID',
          status: 'PENDING_RECONCILIATION',
          dispatchState: 'NOT_DISPATCHED',
          resolved: false
        }
      });

      const claimed = await reconciliationWorker.claimRecord({
        specificRecordId: rec.id,
        workerId: 'worker_clock_01',
        leaseDurationMs: 5000
      });

      expect(claimed).toBeDefined();
      expect(claimed.fencingToken).toBe(1n);

      const renewed = await reconciliationWorker.renewLease({
        recordId: rec.id,
        workerId: 'worker_clock_01',
        fencingToken: claimed.fencingToken,
        leaseDurationMs: 5000
      });

      expect(renewed).toBeDefined();
      expect(new Date(renewed.leaseExpiresAt).getTime()).toBeGreaterThan(Date.now());
    });

    test('Test 6: Stale renewal fails when clock_timestamp exceeds lease expiration', async () => {
      const rec = await prisma.reconciliationRecord.create({
        data: {
          discrepancyType: 'TEST_8IF_CLOCK_EXPIRED',
          status: 'PENDING_RECONCILIATION',
          dispatchState: 'NOT_DISPATCHED',
          resolved: false
        }
      });

      // Claim with 100ms lease
      const claimed = await reconciliationWorker.claimRecord({
        specificRecordId: rec.id,
        workerId: 'worker_clock_02',
        leaseDurationMs: 100
      });

      // Wait 250ms so lease physically expires in PostgreSQL clock_timestamp()
      await new Promise(r => setTimeout(r, 250));

      await expect(
        reconciliationWorker.renewLease({
          recordId: rec.id,
          workerId: 'worker_clock_02',
          fencingToken: claimed.fencingToken,
          leaseDurationMs: 5000
        })
      ).rejects.toThrow(reconciliationWorker.StaleLeaseError);
    });

    test('Test 7: Fenced update fails when lease expires before execution', async () => {
      const rec = await prisma.reconciliationRecord.create({
        data: {
          discrepancyType: 'TEST_8IF_CLOCK_FENCED_EXP',
          status: 'PENDING_RECONCILIATION',
          dispatchState: 'NOT_DISPATCHED',
          resolved: false
        }
      });

      const claimed = await reconciliationWorker.claimRecord({
        specificRecordId: rec.id,
        workerId: 'worker_clock_03',
        leaseDurationMs: 100
      });

      await new Promise(r => setTimeout(r, 250));

      await expect(
        reconciliationWorker.fencedUpdate({
          recordId: rec.id,
          workerId: 'worker_clock_03',
          fencingToken: claimed.fencingToken,
          data: { resolutionNotes: 'Stale write' }
        })
      ).rejects.toThrow(reconciliationWorker.StaleFencingTokenError);
    });

    test('Test 8: Competing worker reclaims expired lease and increments fencingToken monotonically', async () => {
      const rec = await prisma.reconciliationRecord.create({
        data: {
          discrepancyType: 'TEST_8IF_RECLAIM_INC',
          status: 'PENDING_RECONCILIATION',
          dispatchState: 'NOT_DISPATCHED',
          resolved: false
        }
      });

      const claimA = await reconciliationWorker.claimRecord({
        specificRecordId: rec.id,
        workerId: 'worker_clock_A',
        leaseDurationMs: 100
      });
      expect(claimA.fencingToken).toBe(1n);

      await new Promise(r => setTimeout(r, 200));

      // Worker B claims expired lease
      const claimB = await reconciliationWorker.claimRecord({
        specificRecordId: rec.id,
        workerId: 'worker_clock_B',
        leaseDurationMs: 5000
      });
      expect(claimB).toBeDefined();
      expect(claimB.workerId).toBe('worker_clock_B');
      expect(claimB.fencingToken).toBe(2n);

      // Worker A attempts update with stale token 1 -> rejected
      await expect(
        reconciliationWorker.fencedUpdate({
          recordId: rec.id,
          workerId: 'worker_clock_A',
          fencingToken: claimA.fencingToken,
          data: { resolutionNotes: 'Zombie worker A' }
        })
      ).rejects.toThrow(reconciliationWorker.StaleFencingTokenError);
    });
  });

  // =========================================================================
  // SECTION 3: AMBIGUOUS REFUND DISPATCH STATE (BLOCKER 3)
  // =========================================================================
  describe('Ambiguous Refund Dispatch State & Inquiry Enforcement', () => {
    test('Test 9: Gateway timeout in refundService creates OUTCOME_UNKNOWN discrepancy record', async () => {
      const payTimeoutId = `pay_wp15_8if_to_${Date.now()}`;
      await prisma.payment.create({
        data: {
          id: payTimeoutId,
          amount: 50.0,
          currency: 'INR',
          type: 'PRINT_JOB',
          status: 'SUCCESS',
          paymentMethod: 'upi',
          paymentGroup: 'upi',
          gatewayOrderId: `cf_order_to_${Date.now()}`,
          gatewayPaymentId: `cf_pay_to_${Date.now()}`
        }
      });

      cashfreeGateway.createRefund = jest.fn().mockImplementation(() => {
        const err = new Error('Gateway socket timeout');
        err.code = 'ECONNABORTED';
        throw err;
      });

      const refundResult = await refundService.createRefund({
        paymentId: payTimeoutId,
        amount: 50.0,
        reason: 'Timeout test',
        idempotencyKey: `idem_timeout_${Date.now()}`
      });

      expect(refundResult.status).toBe('PROCESSING');
      expect(refundResult.retryEligible).toBe(false);

      // Verify reconciliation record was created with OUTCOME_UNKNOWN
      const discrepancy = await prisma.reconciliationRecord.findFirst({
        where: { paymentId: payTimeoutId, discrepancyType: 'AMBIGUOUS_GATEWAY_OUTCOME' }
      });

      expect(discrepancy).toBeDefined();
      expect(discrepancy.dispatchState).toBe('OUTCOME_UNKNOWN');
      expect(discrepancy.refundId).toBe(refundResult.id);
    });

    test('Test 10: Worker claiming record with AMBIGUOUS_GATEWAY_OUTCOME routes strictly to inquiry, never re-dispatches', async () => {
      const payInqId = `pay_wp15_8if_inq_${Date.now()}`;
      await prisma.payment.create({
        data: {
          id: payInqId,
          amount: 40.0,
          currency: 'INR',
          type: 'PRINT_JOB',
          status: 'SUCCESS',
          paymentMethod: 'upi',
          paymentGroup: 'upi',
          gatewayOrderId: `cf_order_inq_${Date.now()}`,
          gatewayPaymentId: `cf_pay_inq_${Date.now()}`
        }
      });

      const refund = await prisma.refund.create({
        data: {
          paymentId: payInqId,
          gatewayRefundId: `cf_ref_inq_${Date.now()}`,
          amount: 40.0,
          currency: 'INR',
          status: 'PROCESSING',
          reason: 'Inquiry test',
          retryEligible: false
        }
      });

      const rec = await prisma.reconciliationRecord.create({
        data: {
          paymentId: payInqId,
          refundId: refund.id,
          discrepancyType: 'AMBIGUOUS_GATEWAY_OUTCOME',
          status: 'PENDING_RECONCILIATION',
          dispatchState: 'OUTCOME_UNKNOWN',
          resolved: false
        }
      });

      // Ensure createRefund is NOT called
      const createRefundSpy = jest.fn();
      cashfreeGateway.createRefund = createRefundSpy;

      // Mock inquiry returning confirmed SUCCESS
      cashfreeGateway.getRefundDetails = jest.fn().mockResolvedValue({
        success: true,
        status: 'SUCCESS',
        cfRefundId: 'cf_ref_authoritative_success',
        rawResponse: { refund_status: 'SUCCESS' }
      });

      const claimed = await reconciliationWorker.claimRecord({
        specificRecordId: rec.id,
        workerId: 'worker_inq_01'
      });

      const outcome = await reconciliationWorker.processRecord(claimed, {
        workerId: 'worker_inq_01',
        fencingToken: claimed.fencingToken
      });

      // Verify zero calls to createRefund
      expect(createRefundSpy).not.toHaveBeenCalled();
      expect(cashfreeGateway.getRefundDetails).toHaveBeenCalled();
      expect(outcome.dispatchState).toBe('GATEWAY_CONFIRMED');

      const updatedRec = await prisma.reconciliationRecord.findUnique({ where: { id: rec.id } });
      expect(updatedRec.dispatchState).toBe('GATEWAY_CONFIRMED');
      expect(updatedRec.resolved).toBe(true);

      const updatedRefund = await prisma.refund.findUnique({ where: { id: refund.id } });
      expect(updatedRefund.status).toBe('SUCCESS');
    });

    test('Test 11: Inquiry returning 404 NOT_FOUND escalates to MANUAL_REVIEW_REQUIRED and never re-dispatches', async () => {
      const pay404Id = `pay_wp15_8if_404_${Date.now()}`;
      await prisma.payment.create({
        data: {
          id: pay404Id,
          amount: 30.0,
          currency: 'INR',
          type: 'PRINT_JOB',
          status: 'SUCCESS',
          paymentMethod: 'upi',
          paymentGroup: 'upi',
          gatewayOrderId: `cf_order_404_${Date.now()}`,
          gatewayPaymentId: `cf_pay_404_${Date.now()}`
        }
      });

      const refund = await prisma.refund.create({
        data: {
          paymentId: pay404Id,
          gatewayRefundId: `cf_ref_404_${Date.now()}`,
          amount: 30.0,
          currency: 'INR',
          status: 'PROCESSING',
          reason: '404 test',
          retryEligible: false
        }
      });

      const rec = await prisma.reconciliationRecord.create({
        data: {
          paymentId: pay404Id,
          refundId: refund.id,
          discrepancyType: 'AMBIGUOUS_GATEWAY_OUTCOME',
          status: 'PENDING_RECONCILIATION',
          dispatchState: 'OUTCOME_UNKNOWN',
          resolved: false
        }
      });

      const createRefundSpy = jest.fn();
      cashfreeGateway.createRefund = createRefundSpy;

      cashfreeGateway.getRefundDetails = jest.fn().mockResolvedValue({
        success: false,
        status: 'NOT_FOUND',
        isNotFound: true,
        error: 'Refund not found on gateway'
      });

      const claimed = await reconciliationWorker.claimRecord({
        specificRecordId: rec.id,
        workerId: 'worker_404_01'
      });

      const outcome = await reconciliationWorker.processRecord(claimed, {
        workerId: 'worker_404_01',
        fencingToken: claimed.fencingToken
      });

      expect(createRefundSpy).not.toHaveBeenCalled();
      expect(outcome.dispatchState).toBe('MANUAL_REVIEW_REQUIRED');

      const updatedRec = await prisma.reconciliationRecord.findUnique({ where: { id: rec.id } });
      expect(updatedRec.dispatchState).toBe('MANUAL_REVIEW_REQUIRED');
      expect(updatedRec.resolved).toBe(false);
    });

    test('Test 12: Inquiry returning timeout/inconclusive retains OUTCOME_UNKNOWN and never re-dispatches', async () => {
      const payIncId = `pay_wp15_8if_inc_${Date.now()}`;
      await prisma.payment.create({
        data: {
          id: payIncId,
          amount: 25.0,
          currency: 'INR',
          type: 'PRINT_JOB',
          status: 'SUCCESS',
          paymentMethod: 'upi',
          paymentGroup: 'upi',
          gatewayOrderId: `cf_order_inc_${Date.now()}`,
          gatewayPaymentId: `cf_pay_inc_${Date.now()}`
        }
      });

      const refund = await prisma.refund.create({
        data: {
          paymentId: payIncId,
          gatewayRefundId: `cf_ref_inc_${Date.now()}`,
          amount: 25.0,
          currency: 'INR',
          status: 'PROCESSING',
          reason: 'Inconclusive test',
          retryEligible: false
        }
      });

      const rec = await prisma.reconciliationRecord.create({
        data: {
          paymentId: payIncId,
          refundId: refund.id,
          discrepancyType: 'AMBIGUOUS_GATEWAY_OUTCOME',
          status: 'PENDING_RECONCILIATION',
          dispatchState: 'OUTCOME_UNKNOWN',
          resolved: false
        }
      });

      const createRefundSpy = jest.fn();
      cashfreeGateway.createRefund = createRefundSpy;

      cashfreeGateway.getRefundDetails = jest.fn().mockRejectedValue(new Error('Gateway inquiry timeout (ECONNABORTED)'));

      const claimed = await reconciliationWorker.claimRecord({
        specificRecordId: rec.id,
        workerId: 'worker_inc_01'
      });

      const outcome = await reconciliationWorker.processRecord(claimed, {
        workerId: 'worker_inc_01',
        fencingToken: claimed.fencingToken
      });

      expect(createRefundSpy).not.toHaveBeenCalled();
      expect(outcome.dispatchState).toBe('OUTCOME_UNKNOWN');

      const updatedRec = await prisma.reconciliationRecord.findUnique({ where: { id: rec.id } });
      expect(updatedRec.dispatchState).toBe('OUTCOME_UNKNOWN');
      expect(updatedRec.resolved).toBe(false);
    });
  });
});
