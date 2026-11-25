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

describe('WP-15.8I-D: Distributed Reconciliation Worker & Durable Intent Tests', () => {
  const paymentId = 'pay_wp15_8id_01';
  const machineId = 'mach_wp15_8id_01';
  const docId = 'doc_wp15_8id_01';
  const jobId = 'job_wp15_8id_01';

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
        machineKey: 'dummy_machine_key_158id',
        name: 'Test Kiosk 15.8I-D',
        status: 'ONLINE',
        printerModel: 'LaserJet 15.8I-D'
      },
      update: {}
    });

    await prisma.document.upsert({
      where: { id: docId },
      create: {
        id: docId,
        originalName: 'test_158id.pdf',
        filename: 'test_158id_uuid.pdf',
        mimetype: 'application/pdf',
        size: 2048,
        pages: 5
      },
      update: {}
    });

    await prisma.payment.create({
      data: {
        id: paymentId,
        amount: 50.0,
        currency: 'INR',
        type: 'PRINT_JOB',
        status: 'SUCCESS',
        paymentMethod: 'cashfree_upi',
        paymentGroup: 'upi',
        gatewayOrderId: 'order_wp15_8id_01',
        gatewayPaymentId: 'pay_cf_8id_01'
      }
    });

    await prisma.printJob.create({
      data: {
        id: jobId,
        shortId: 'PG-8ID-01',
        cost: 50.0,
        pagesToPrint: 5,
        color: 'BW',
        status: 'PRINTING',
        paymentId,
        machineId,
        documentId: docId
      }
    });
  });

  afterAll(async () => {
    cashfreeGateway.createRefund = originalCreateRefund;
    cashfreeGateway.getRefundDetails = originalGetRefundDetails;
    await cleanup();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    cashfreeGateway.createRefund = jest.fn(async ({ refundId, amount }) => ({
      success: true,
      status: 'SUCCESS',
      cfRefundId: `cf_${refundId}`,
      rawResponse: { refund_id: refundId, amount, status: 'SUCCESS' }
    }));

    cashfreeGateway.getRefundDetails = jest.fn(async (orderId, refundId) => ({
      success: true,
      status: 'SUCCESS',
      cfRefundId: `cf_${refundId}`,
      refundId,
      orderId,
      amount: 50.0,
      rawResponse: { refund_id: refundId, status: 'SUCCESS' }
    }));

    await prisma.refund.deleteMany({
      where: { paymentId: { startsWith: 'pay_wp15_8id_' } }
    }).catch(() => {});
    await prisma.payment.updateMany({
      where: { id: { startsWith: 'pay_wp15_8id_' } },
      data: { status: 'SUCCESS' }
    }).catch(() => {});
  });

  async function cleanup() {
    await prisma.reconciliationRecord.deleteMany({
      where: {
        OR: [
          { paymentId: { startsWith: 'pay_wp15_8id_' } },
          { discrepancyType: { startsWith: 'TEST_' } }
        ]
      }
    }).catch(() => {});
    await prisma.creditNote.deleteMany({
      where: { creditNoteNumber: { startsWith: 'CN-8ID-' } }
    }).catch(() => {});
    await prisma.transaction.deleteMany({
      where: { paymentId: { startsWith: 'pay_wp15_8id_' } }
    }).catch(() => {});
    await prisma.refund.deleteMany({
      where: { paymentId: { startsWith: 'pay_wp15_8id_' } }
    }).catch(() => {});
    await prisma.printJob.deleteMany({
      where: { paymentId: { startsWith: 'pay_wp15_8id_' } }
    }).catch(() => {});
    await prisma.payment.deleteMany({
      where: { id: { startsWith: 'pay_wp15_8id_' } }
    }).catch(() => {});
    await prisma.machine.deleteMany({
      where: { id: machineId }
    }).catch(() => {});
    await prisma.document.deleteMany({
      where: { id: docId }
    }).catch(() => {});
  }

  // =========================================================================
  // SUITE 1: WORKER LEASING & FENCING (Items 1-7)
  // =========================================================================
  describe('Worker Leasing & Fencing Enforcements', () => {
    test('1. Two workers compete for the same record; only one lease wins', async () => {
      const rec = await prisma.reconciliationRecord.create({
        data: {
          paymentId,
          status: 'DISCREPANCY_FLAGGED',
          discrepancyType: 'TEST_CONCURRENT_LEASING',
          details: 'Compete for lease',
          dispatchState: 'NOT_DISPATCHED'
        }
      });

      const workerA = 'worker_node_A';
      const workerB = 'worker_node_B';

      // Both workers attempt to claim the exact same record concurrently
      const [claimA, claimB] = await Promise.all([
        reconciliationWorker.claimRecord({ workerId: workerA, specificRecordId: rec.id }),
        reconciliationWorker.claimRecord({ workerId: workerB, specificRecordId: rec.id })
      ]);

      // Exactly one must win; the other must receive null
      const winner = claimA || claimB;
      const loser = claimA ? claimB : claimA;

      expect(winner).not.toBeNull();
      expect(loser).toBeNull();
      expect([workerA, workerB]).toContain(winner.workerId);
      expect(winner.fencingToken).toBe(1n);

      // Database verification
      const dbRec = await prisma.reconciliationRecord.findUnique({ where: { id: rec.id } });
      expect(dbRec.workerId).toBe(winner.workerId);
      expect(dbRec.fencingToken).toBe(1n);
    });

    test('2. Lease renewal succeeds for the current owner', async () => {
      const rec = await prisma.reconciliationRecord.create({
        data: {
          paymentId,
          status: 'DISCREPANCY_FLAGGED',
          discrepancyType: 'TEST_RENEWAL',
          details: 'Renewal test',
          dispatchState: 'NOT_DISPATCHED'
        }
      });

      const claimed = await reconciliationWorker.claimRecord({
        workerId: 'worker_renewal_01',
        specificRecordId: rec.id,
        leaseDurationMs: 15000
      });

      const originalExpiry = new Date(claimed.leaseExpiresAt).getTime();

      // Renew lease
      const renewed = await reconciliationWorker.renewLease({
        recordId: rec.id,
        workerId: 'worker_renewal_01',
        fencingToken: claimed.fencingToken,
        leaseDurationMs: 45000
      });

      const renewedExpiry = new Date(renewed.leaseExpiresAt).getTime();
      expect(renewedExpiry).toBeGreaterThan(originalExpiry);
    });

    test('3. Expired lease cannot be renewed by the stale worker', async () => {
      const rec = await prisma.reconciliationRecord.create({
        data: {
          paymentId,
          status: 'DISCREPANCY_FLAGGED',
          discrepancyType: 'TEST_EXPIRED_RENEWAL',
          details: 'Expired renewal test',
          workerId: 'worker_expired_01',
          fencingToken: 1n,
          leaseExpiresAt: new Date(Date.now() - 5000), // Already expired 5s ago
          dispatchState: 'NOT_DISPATCHED'
        }
      });

      await expect(
        reconciliationWorker.renewLease({
          recordId: rec.id,
          workerId: 'worker_expired_01',
          fencingToken: 1n,
          leaseDurationMs: 30000
        })
      ).rejects.toThrow(reconciliationWorker.StaleLeaseError);
    });

    test('4. Reclaimed lease increments fencingToken monotonically', async () => {
      const rec = await prisma.reconciliationRecord.create({
        data: {
          paymentId,
          status: 'DISCREPANCY_FLAGGED',
          discrepancyType: 'TEST_RECLAMATION_TOKEN',
          details: 'Reclaim token test',
          workerId: 'worker_stale_prior',
          fencingToken: 5n,
          leaseExpiresAt: new Date(Date.now() - 1000), // Expired
          dispatchState: 'NOT_DISPATCHED'
        }
      });

      const reclaimed = await reconciliationWorker.claimRecord({
        workerId: 'worker_fresh_reclaimer',
        specificRecordId: rec.id
      });

      expect(reclaimed.workerId).toBe('worker_fresh_reclaimer');
      expect(reclaimed.fencingToken).toBe(6n); // Monotonically incremented from 5 to 6
    });

    test('5. Old worker cannot mutate record after reclaim (Fencing rejection)', async () => {
      const rec = await prisma.reconciliationRecord.create({
        data: {
          paymentId,
          status: 'DISCREPANCY_FLAGGED',
          discrepancyType: 'TEST_FENCING_MUTATION',
          details: 'Fencing mutation test',
          workerId: 'worker_A',
          fencingToken: 2n,
          leaseExpiresAt: new Date(Date.now() - 1000), // Expired
          dispatchState: 'NOT_DISPATCHED'
        }
      });

      // Worker B reclaims
      const reclaimedByB = await reconciliationWorker.claimRecord({
        workerId: 'worker_B',
        specificRecordId: rec.id
      });
      expect(reclaimedByB.fencingToken).toBe(3n);

      // Stale Worker A wakes up and attempts a fenced mutation using stale token 2n
      await expect(
        reconciliationWorker.fencedUpdate({
          recordId: rec.id,
          workerId: 'worker_A',
          fencingToken: 2n,
          data: { resolutionNotes: 'Stale update attempt by worker A' }
        })
      ).rejects.toThrow(reconciliationWorker.StaleFencingTokenError);
    });

    test('6. Old worker cannot dispatch intent after losing ownership', async () => {
      const rec = await prisma.reconciliationRecord.create({
        data: {
          paymentId,
          status: 'DISCREPANCY_FLAGGED',
          discrepancyType: 'TEST_FENCING_DISPATCH_INTENT',
          details: 'Fencing intent test',
          workerId: 'worker_A',
          fencingToken: 1n,
          leaseExpiresAt: new Date(Date.now() - 1000), // Expired
          dispatchState: 'NOT_DISPATCHED'
        }
      });

      // Worker B reclaims
      await reconciliationWorker.claimRecord({
        workerId: 'worker_B',
        specificRecordId: rec.id
      });

      // Worker A attempts to persist DISPATCH_INTENT with stale token 1n
      await expect(
        reconciliationWorker.persistDispatchIntent({
          recordId: rec.id,
          workerId: 'worker_A',
          fencingToken: 1n
        })
      ).rejects.toThrow(reconciliationWorker.DispatchIntentError);
    });

    test('7. Concurrent claims across batch do not produce duplicate dispatch ownership', async () => {
      // Clean up previous test records so the batch only targets these 5
      await prisma.reconciliationRecord.deleteMany({
        where: { discrepancyType: { startsWith: 'TEST_' } }
      }).catch(() => {});

      // Create 5 test records
      const records = await Promise.all(
        [1, 2, 3, 4, 5].map(i =>
          prisma.reconciliationRecord.create({
            data: {
              paymentId,
              status: 'DISCREPANCY_FLAGGED',
              discrepancyType: `TEST_BATCH_${i}`,
              details: `Batch record ${i}`,
              dispatchState: 'NOT_DISPATCHED'
            }
          })
        )
      );

      // Run two workers concurrently competing for all records
      const workerA = 'batch_worker_A';
      const workerB = 'batch_worker_B';

      const [batchA, batchB] = await Promise.all([
        reconciliationWorker.runWorkerBatch({ workerId: workerA, maxRecords: 5 }),
        reconciliationWorker.runWorkerBatch({ workerId: workerB, maxRecords: 5 })
      ]);

      const claimedA = batchA.results.map(r => r.recordId);
      const claimedB = batchB.results.map(r => r.recordId);

      // Intersection must be empty (zero records claimed by both)
      const intersection = claimedA.filter(id => claimedB.includes(id));
      expect(intersection).toEqual([]);

      // All 5 records must have been processed
      expect(claimedA.length + claimedB.length).toBe(5);
    });
  });

  // =========================================================================
  // SUITE 2: DURABLE DISPATCH_INTENT BARRIER (Items 8-12)
  // =========================================================================
  describe('Durable DISPATCH_INTENT Barrier & Crash Points', () => {
    test('8. DISPATCH_INTENT commits before the HTTP adapter is called', async () => {
      const payIntentId = `pay_wp15_8id_intent_08_${Date.now()}`;
      await prisma.payment.create({
        data: {
          id: payIntentId,
          amount: 50.0,
          currency: 'INR',
          type: 'PRINT_JOB',
          status: 'SUCCESS',
          paymentMethod: 'cashfree_upi',
          paymentGroup: 'upi',
          gatewayOrderId: `order_${payIntentId}`,
          gatewayPaymentId: `pay_cf_${payIntentId}`
        }
      });

      const rec = await prisma.reconciliationRecord.create({
        data: {
          paymentId: payIntentId,
          status: 'DISCREPANCY_FLAGGED',
          discrepancyType: 'TEST_INTENT_BEFORE_HTTP',
          details: 'Verify commit before http',
          dispatchState: 'NOT_DISPATCHED'
        }
      });

      let dbStateWhenHttpCalled = null;
      cashfreeGateway.createRefund = jest.fn(async () => {
        // Inspect database inside mock adapter call
        const liveRec = await prisma.reconciliationRecord.findUnique({ where: { id: rec.id } });
        dbStateWhenHttpCalled = liveRec.dispatchState;
        return {
          success: true,
          status: 'SUCCESS',
          cfRefundId: 'cf_intent_test_01',
          rawResponse: { status: 'SUCCESS' }
        };
      });

      const worker = 'worker_intent_tester';
      const claimed = await reconciliationWorker.claimRecord({ workerId: worker, specificRecordId: rec.id });
      await reconciliationWorker.processRecord(claimed, { workerId: worker, fencingToken: claimed.fencingToken });

      // Invariant: database MUST have had DISPATCH_INTENT committed prior to the gateway call
      expect(dbStateWhenHttpCalled).toBe('DISPATCH_INTENT');
    });

    test('9. Database failure before intent prevents the external call completely', async () => {
      const rec = await prisma.reconciliationRecord.create({
        data: {
          paymentId,
          status: 'DISCREPANCY_FLAGGED',
          discrepancyType: 'TEST_INTENT_FAILURE',
          details: 'Intent failure test',
          dispatchState: 'MANUAL_REVIEW_REQUIRED' // Invalid initial state for intent
        }
      });

      const httpSpy = jest.fn();
      cashfreeGateway.createRefund = httpSpy;

      const worker = 'worker_intent_fail_01';
      // Attempting to persist intent on a MANUAL_REVIEW_REQUIRED record fails
      await expect(
        reconciliationWorker.persistDispatchIntent({
          recordId: rec.id,
          workerId: worker,
          fencingToken: 1n
        })
      ).rejects.toThrow(reconciliationWorker.DispatchIntentError);

      // Verify external HTTP call was NEVER triggered
      expect(httpSpy).not.toHaveBeenCalled();
    });

    test('10. Crash after intent but before HTTP does not cause blind retry on next worker', async () => {
      // Simulate crash point 3: record is left in DISPATCH_INTENT
      const rec = await prisma.reconciliationRecord.create({
        data: {
          paymentId,
          status: 'DISCREPANCY_FLAGGED',
          discrepancyType: 'TEST_CRASH_AFTER_INTENT',
          details: 'Crash point 3 simulation',
          workerId: 'worker_crashed_before_http',
          fencingToken: 1n,
          leaseExpiresAt: new Date(Date.now() - 1000), // Worker crashed & lease expired
          dispatchState: 'DISPATCH_INTENT'
        }
      });

      const createRefundSpy = jest.fn();
      cashfreeGateway.createRefund = createRefundSpy;

      // Next worker B claims the record
      const workerB = 'worker_recovering_B';
      const claimedB = await reconciliationWorker.claimRecord({ workerId: workerB, specificRecordId: rec.id });
      expect(claimedB.dispatchState).toBe('DISPATCH_INTENT');

      // Worker B processes the record
      await reconciliationWorker.processRecord(claimedB, { workerId: workerB, fencingToken: claimedB.fencingToken });

      // INVARIANT: createRefund must NEVER be called! Worker B must route to inquiry!
      expect(createRefundSpy).not.toHaveBeenCalled();
    });

    test('11. Crash during HTTP creates an ambiguous recovery path (OUTCOME_UNKNOWN)', async () => {
      const payTimeoutId = `pay_wp15_8id_to_11_${Date.now()}`;
      await prisma.payment.create({
        data: {
          id: payTimeoutId,
          amount: 50.0,
          currency: 'INR',
          type: 'PRINT_JOB',
          status: 'SUCCESS',
          paymentMethod: 'cashfree_upi',
          paymentGroup: 'upi',
          gatewayOrderId: `order_${payTimeoutId}`,
          gatewayPaymentId: `pay_cf_${payTimeoutId}`
        }
      });

      const rec = await prisma.reconciliationRecord.create({
        data: {
          paymentId: payTimeoutId,
          status: 'DISCREPANCY_FLAGGED',
          discrepancyType: 'TEST_CRASH_DURING_HTTP',
          details: 'Crash point 4 simulation',
          dispatchState: 'NOT_DISPATCHED'
        }
      });

      // Simulate gateway timeout during call
      cashfreeGateway.createRefund = jest.fn(async () => {
        const err = new Error('connect ECONNABORTED timeout');
        err.code = 'ECONNABORTED';
        throw err;
      });

      const worker = 'worker_timeout_01';
      const claimed = await reconciliationWorker.claimRecord({ workerId: worker, specificRecordId: rec.id });
      const result = await reconciliationWorker.processRecord(claimed, { workerId: worker, fencingToken: claimed.fencingToken });

      // State MUST be quarantined as OUTCOME_UNKNOWN, NOT FAILED
      expect(result.dispatchState).toBe('OUTCOME_UNKNOWN');

      const dbRec = await prisma.reconciliationRecord.findUnique({ where: { id: rec.id } });
      expect(dbRec.dispatchState).toBe('OUTCOME_UNKNOWN');
    });

    test('12. Crash after provider acceptance but before local persistence is safely recovered', async () => {
      // Simulate crash point 5: Gateway processed refund, but local worker died before updating DB
      const refund = await prisma.refund.create({
        data: {
          idempotencyKey: 'idemp_crash_point_5',
          paymentId,
          gatewayRefundId: 'ref_crash_point_5_id',
          amount: 50.0,
          currency: 'INR',
          status: 'PROCESSING'
        }
      });

      const rec = await prisma.reconciliationRecord.create({
        data: {
          paymentId,
          refundId: refund.id,
          status: 'DISCREPANCY_FLAGGED',
          discrepancyType: 'TEST_CRASH_POINT_5',
          details: 'Crash point 5 simulation',
          workerId: 'worker_crashed_post_ack',
          fencingToken: 1n,
          leaseExpiresAt: new Date(Date.now() - 1000), // Expired
          dispatchState: 'DISPATCH_INTENT'
        }
      });

      // Gateway inquiry reports SUCCESS
      cashfreeGateway.getRefundDetails = jest.fn(async () => ({
        success: true,
        status: 'SUCCESS',
        cfRefundId: 'cf_ack_confirmed_01',
        amount: 50.0,
        rawResponse: { status: 'SUCCESS' }
      }));

      const createRefundSpy = jest.fn();
      cashfreeGateway.createRefund = createRefundSpy;

      // Recovering worker claims and runs
      const worker = 'worker_recovery_05';
      const claimed = await reconciliationWorker.claimRecord({ workerId: worker, specificRecordId: rec.id });
      const result = await reconciliationWorker.processRecord(claimed, { workerId: worker, fencingToken: claimed.fencingToken });

      expect(createRefundSpy).not.toHaveBeenCalled();
      expect(result.dispatchState).toBe('GATEWAY_CONFIRMED');

      const dbRefund = await prisma.refund.findUnique({ where: { id: refund.id } });
      expect(dbRefund.status).toBe('SUCCESS');
    });
  });

  // =========================================================================
  // SUITE 3: INQUIRY-ONLY RECOVERY PATH (Items 13-19)
  // =========================================================================
  describe('Inquiry-Only Recovery Path Semantics', () => {
    test('13. Existing DISPATCH_INTENT is recovered through inquiry, not resend', async () => {
      const refund = await prisma.refund.create({
        data: {
          idempotencyKey: 'idemp_inquiry_path_13',
          paymentId,
          gatewayRefundId: 'ref_inquiry_path_13',
          amount: 50.0,
          currency: 'INR',
          status: 'PROCESSING'
        }
      });

      const rec = await prisma.reconciliationRecord.create({
        data: {
          paymentId,
          refundId: refund.id,
          status: 'DISCREPANCY_FLAGGED',
          discrepancyType: 'TEST_INQUIRY_RECOVERY',
          details: 'Inquiry recovery',
          workerId: 'worker_old',
          fencingToken: 1n,
          leaseExpiresAt: new Date(Date.now() - 1000),
          dispatchState: 'DISPATCH_INTENT'
        }
      });

      const createRefundSpy = jest.fn();
      cashfreeGateway.createRefund = createRefundSpy;
      const getRefundDetailsSpy = jest.fn(async () => ({
        success: true,
        status: 'SUCCESS',
        cfRefundId: 'cf_inq_13',
        amount: 50.0,
        rawResponse: { status: 'SUCCESS' }
      }));
      cashfreeGateway.getRefundDetails = getRefundDetailsSpy;

      const worker = 'worker_inq_13';
      const claimed = await reconciliationWorker.claimRecord({ workerId: worker, specificRecordId: rec.id });
      await reconciliationWorker.processRecord(claimed, { workerId: worker, fencingToken: claimed.fencingToken });

      expect(createRefundSpy).not.toHaveBeenCalled();
      expect(getRefundDetailsSpy).toHaveBeenCalledTimes(1);
    });

    test('14. Provider confirms success: persist GATEWAY_CONFIRMED and mark resolved', async () => {
      const refund = await prisma.refund.create({
        data: {
          idempotencyKey: 'idemp_inquiry_succ_14',
          paymentId,
          gatewayRefundId: 'ref_inquiry_succ_14',
          amount: 50.0,
          currency: 'INR',
          status: 'PROCESSING'
        }
      });

      const rec = await prisma.reconciliationRecord.create({
        data: {
          paymentId,
          refundId: refund.id,
          status: 'DISCREPANCY_FLAGGED',
          discrepancyType: 'TEST_INQUIRY_SUCCESS',
          details: 'Inquiry confirms success',
          workerId: 'worker_old_14',
          fencingToken: 1n,
          leaseExpiresAt: new Date(Date.now() - 1000),
          dispatchState: 'OUTCOME_UNKNOWN'
        }
      });

      cashfreeGateway.getRefundDetails = jest.fn(async () => ({
        success: true,
        status: 'SUCCESS',
        cfRefundId: 'cf_succ_14',
        amount: 50.0,
        rawResponse: { status: 'SUCCESS' }
      }));

      const worker = 'worker_inq_14';
      const claimed = await reconciliationWorker.claimRecord({ workerId: worker, specificRecordId: rec.id });
      const res = await reconciliationWorker.processRecord(claimed, { workerId: worker, fencingToken: claimed.fencingToken });

      expect(res.dispatchState).toBe('GATEWAY_CONFIRMED');

      const dbRec = await prisma.reconciliationRecord.findUnique({ where: { id: rec.id } });
      expect(dbRec.dispatchState).toBe('GATEWAY_CONFIRMED');
      expect(dbRec.resolved).toBe(true);
    });

    test('15. Provider definitively confirms failure: apply only GATEWAY_FAILED transition', async () => {
      const refund = await prisma.refund.create({
        data: {
          idempotencyKey: 'idemp_inquiry_fail_15',
          paymentId,
          gatewayRefundId: 'ref_inquiry_fail_15',
          amount: 50.0,
          currency: 'INR',
          status: 'PROCESSING'
        }
      });

      const rec = await prisma.reconciliationRecord.create({
        data: {
          paymentId,
          refundId: refund.id,
          status: 'DISCREPANCY_FLAGGED',
          discrepancyType: 'TEST_INQUIRY_FAIL',
          details: 'Inquiry confirms failure',
          workerId: 'worker_old_15',
          fencingToken: 1n,
          leaseExpiresAt: new Date(Date.now() - 1000),
          dispatchState: 'OUTCOME_UNKNOWN'
        }
      });

      cashfreeGateway.getRefundDetails = jest.fn(async () => ({
        success: false,
        status: 'FAILED',
        error: 'Beneficiary account invalid',
        rawResponse: { status: 'FAILED' }
      }));

      const worker = 'worker_inq_15';
      const claimed = await reconciliationWorker.claimRecord({ workerId: worker, specificRecordId: rec.id });
      const res = await reconciliationWorker.processRecord(claimed, { workerId: worker, fencingToken: claimed.fencingToken });

      expect(res.dispatchState).toBe('GATEWAY_FAILED');

      const dbRec = await prisma.reconciliationRecord.findUnique({ where: { id: rec.id } });
      expect(dbRec.dispatchState).toBe('GATEWAY_FAILED');
      expect(dbRec.resolved).toBe(false);
    });

    test('16. Provider reports processing: retain non-retryable OUTCOME_UNKNOWN state', async () => {
      const refund = await prisma.refund.create({
        data: {
          idempotencyKey: 'idemp_inquiry_proc_16',
          paymentId,
          gatewayRefundId: 'ref_inquiry_proc_16',
          amount: 50.0,
          currency: 'INR',
          status: 'PROCESSING'
        }
      });

      const rec = await prisma.reconciliationRecord.create({
        data: {
          paymentId,
          refundId: refund.id,
          status: 'DISCREPANCY_FLAGGED',
          discrepancyType: 'TEST_INQUIRY_PROCESSING',
          details: 'Inquiry reports processing',
          workerId: 'worker_old_16',
          fencingToken: 1n,
          leaseExpiresAt: new Date(Date.now() - 1000),
          dispatchState: 'OUTCOME_UNKNOWN'
        }
      });

      cashfreeGateway.getRefundDetails = jest.fn(async () => ({
        success: false,
        status: 'PROCESSING',
        rawResponse: { status: 'PROCESSING' }
      }));

      const worker = 'worker_inq_16';
      const claimed = await reconciliationWorker.claimRecord({ workerId: worker, specificRecordId: rec.id });
      const res = await reconciliationWorker.processRecord(claimed, { workerId: worker, fencingToken: claimed.fencingToken });

      expect(res.dispatchState).toBe('OUTCOME_UNKNOWN');

      const dbRec = await prisma.reconciliationRecord.findUnique({ where: { id: rec.id } });
      expect(dbRec.dispatchState).toBe('OUTCOME_UNKNOWN');
      expect(dbRec.resolved).toBe(false);
    });

    test('17. Inquiry timeout remains OUTCOME_UNKNOWN', async () => {
      const refund = await prisma.refund.create({
        data: {
          idempotencyKey: 'idemp_inquiry_to_17',
          paymentId,
          gatewayRefundId: 'ref_inquiry_to_17',
          amount: 50.0,
          currency: 'INR',
          status: 'PROCESSING'
        }
      });

      const rec = await prisma.reconciliationRecord.create({
        data: {
          paymentId,
          refundId: refund.id,
          status: 'DISCREPANCY_FLAGGED',
          discrepancyType: 'TEST_INQUIRY_TIMEOUT',
          details: 'Inquiry timeout',
          workerId: 'worker_old_17',
          fencingToken: 1n,
          leaseExpiresAt: new Date(Date.now() - 1000),
          dispatchState: 'OUTCOME_UNKNOWN'
        }
      });

      cashfreeGateway.getRefundDetails = jest.fn(async () => {
        const err = new Error('read ECONNRESET');
        err.code = 'ECONNRESET';
        throw err;
      });

      const worker = 'worker_inq_17';
      const claimed = await reconciliationWorker.claimRecord({ workerId: worker, specificRecordId: rec.id });
      const res = await reconciliationWorker.processRecord(claimed, { workerId: worker, fencingToken: claimed.fencingToken });

      expect(res.dispatchState).toBe('OUTCOME_UNKNOWN');
    });

    test('18. Inconclusive inquiry (404 Not Found) quarantines to MANUAL_REVIEW_REQUIRED', async () => {
      const refund = await prisma.refund.create({
        data: {
          idempotencyKey: 'idemp_inquiry_404_18',
          paymentId,
          gatewayRefundId: 'ref_inquiry_404_18',
          amount: 50.0,
          currency: 'INR',
          status: 'PROCESSING'
        }
      });

      const rec = await prisma.reconciliationRecord.create({
        data: {
          paymentId,
          refundId: refund.id,
          status: 'DISCREPANCY_FLAGGED',
          discrepancyType: 'TEST_INQUIRY_404',
          details: '404 on intent record',
          workerId: 'worker_old_18',
          fencingToken: 1n,
          leaseExpiresAt: new Date(Date.now() - 1000),
          dispatchState: 'DISPATCH_INTENT'
        }
      });

      cashfreeGateway.getRefundDetails = jest.fn(async () => ({
        success: false,
        status: 'NOT_FOUND',
        isNotFound: true,
        error: 'Refund not found at gateway'
      }));

      const worker = 'worker_inq_18';
      const claimed = await reconciliationWorker.claimRecord({ workerId: worker, specificRecordId: rec.id });
      const res = await reconciliationWorker.processRecord(claimed, { workerId: worker, fencingToken: claimed.fencingToken });

      expect(res.dispatchState).toBe('MANUAL_REVIEW_REQUIRED');

      const dbRec = await prisma.reconciliationRecord.findUnique({ where: { id: rec.id } });
      expect(dbRec.dispatchState).toBe('MANUAL_REVIEW_REQUIRED');
    });

    test('19. Expired worker lease does not authorize a new refund request', async () => {
      const rec = await prisma.reconciliationRecord.create({
        data: {
          paymentId,
          status: 'DISCREPANCY_FLAGGED',
          discrepancyType: 'TEST_EXPIRED_LEASE_RETRY_BLOCK',
          details: 'Expired lease retry block',
          workerId: 'worker_slow',
          fencingToken: 1n,
          leaseExpiresAt: new Date(Date.now() - 1000), // Expired
          dispatchState: 'OUTCOME_UNKNOWN'
        }
      });

      const createRefundSpy = jest.fn();
      cashfreeGateway.createRefund = createRefundSpy;

      // Reclaimer claims the record
      const reclaimer = await reconciliationWorker.claimRecord({
        workerId: 'worker_reclaimer_19',
        specificRecordId: rec.id
      });

      await reconciliationWorker.processRecord(reclaimer, {
        workerId: 'worker_reclaimer_19',
        fencingToken: reclaimer.fencingToken
      });

      // INVARIANT: Reclaiming an expired lease NEVER implies permission to re-send a refund request!
      expect(createRefundSpy).not.toHaveBeenCalled();
    });
  });
});
