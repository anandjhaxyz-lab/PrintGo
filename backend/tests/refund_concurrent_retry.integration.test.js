const prisma = require('../src/utils/prisma');
const refundService = require('../src/services/refund.service');
const cashfreeGateway = require('../src/services/cashfreeGateway.adapter');
const reconciliationService = require('../src/services/reconciliation.service');

function assertDisposableDatabaseUrl() {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error('DATABASE_URL is required for the integration test.');
  const parsed = new URL(raw);
  const databaseName = parsed.pathname.replace(/^\//, '').split('?')[0];
  if (!['localhost', '127.0.0.1'].includes(parsed.hostname) || databaseName !== 'printgo_disposable_target') {
    throw new Error('Safety stop: integration tests may run only against local printgo_disposable_target.');
  }
}

describe('Actual Concurrent Refund Retry Integration & Gateway Idempotency', () => {
  const paymentId = 'pay_concurrent_retry_01';
  const paymentId2 = 'pay_concurrent_retry_02';
  const idempotencyKey = 'idemp_concurrent_retry_01';
  let originalCreateRefund;
  let originalGetRefundDetails;

  beforeAll(async () => {
    assertDisposableDatabaseUrl();
    cashfreeGateway.setMockMode(true);
    originalCreateRefund = cashfreeGateway.createRefund;
    originalGetRefundDetails = cashfreeGateway.getRefundDetails;

    // Seed Payment 1
    await prisma.payment.upsert({
      where: { id: paymentId },
      create: {
        id: paymentId,
        amount: 100.0,
        currency: 'INR',
        type: 'PRINT_JOB',
        status: 'SUCCESS',
        paymentMethod: 'cashfree_upi',
        paymentGroup: 'upi',
        gatewayOrderId: 'order_conc_001',
        gatewayPaymentId: 'pay_conc_001'
      },
      update: {
        status: 'SUCCESS',
        amount: 100.0
      }
    });

    // Seed Payment 2
    await prisma.payment.upsert({
      where: { id: paymentId2 },
      create: {
        id: paymentId2,
        amount: 100.0,
        currency: 'INR',
        type: 'PRINT_JOB',
        status: 'SUCCESS',
        paymentMethod: 'cashfree_upi',
        paymentGroup: 'upi',
        gatewayOrderId: 'order_conc_002',
        gatewayPaymentId: 'pay_conc_002'
      },
      update: {
        status: 'SUCCESS',
        amount: 100.0
      }
    });
  });

  afterAll(async () => {
    cashfreeGateway.createRefund = originalCreateRefund;
    cashfreeGateway.getRefundDetails = originalGetRefundDetails;
    await prisma.reconciliationRecord.deleteMany({ where: { paymentId: { in: [paymentId, paymentId2] } } }).catch(() => {});
    await prisma.transaction.deleteMany({ where: { paymentId: { in: [paymentId, paymentId2] } } }).catch(() => {});
    await prisma.refund.deleteMany({ where: { paymentId: { in: [paymentId, paymentId2] } } }).catch(() => {});
    await prisma.payment.deleteMany({ where: { id: { in: [paymentId, paymentId2] } } }).catch(() => {});
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.reconciliationRecord.deleteMany({ where: { paymentId: { in: [paymentId, paymentId2] } } });
    await prisma.transaction.deleteMany({ where: { paymentId: { in: [paymentId, paymentId2] } } });
    await prisma.refund.deleteMany({ where: { paymentId: { in: [paymentId, paymentId2] } } });
    await prisma.payment.updateMany({
      where: { id: { in: [paymentId, paymentId2] } },
      data: { status: 'SUCCESS' }
    });
  });

  test('proves two simultaneous requests using the same FAILED retry-eligible refund trigger exactly ONE gateway call and produce zero duplicate refunds', async () => {
    // 1. Seed initial FAILED retry-eligible refund
    const initialFailed = await prisma.refund.create({
      data: {
        idempotencyKey,
        paymentId,
        gatewayRefundId: 'ref_failed_initial_01',
        amount: 50.0,
        currency: 'INR',
        reason: 'Initial network failure',
        status: 'FAILED',
        retryEligible: true,
        failureReason: 'Initial connection timeout'
      }
    });

    let gatewayCallCount = 0;
    cashfreeGateway.createRefund = jest.fn(async ({ refundId, amount }) => {
      gatewayCallCount++;
      // Simulate real external network roundtrip latency while holding claim
      await new Promise((r) => setTimeout(r, 80));
      return {
        success: true,
        status: 'SUCCESS',
        cfRefundId: 'cf_success_conc_01',
        rawResponse: { refund_id: refundId, amount, status: 'SUCCESS' }
      };
    });

    // 2. Launch two simultaneous retry requests via Promise.all
    const [result1, result2] = await Promise.all([
      refundService.createRefund({
        paymentId,
        amount: 50.0,
        idempotencyKey,
        reason: 'Concurrent retry 1'
      }),
      refundService.createRefund({
        paymentId,
        amount: 50.0,
        idempotencyKey,
        reason: 'Concurrent retry 2'
      })
    ]);

    // 3. Verify exactly ONE gateway invocation occurred
    expect(gatewayCallCount).toBe(1);
    expect(cashfreeGateway.createRefund).toHaveBeenCalledTimes(1);

    // 4. Verify both callers receive valid refund states (one finalized SUCCESS, the other recognized in-flight / success)
    expect(['SUCCESS', 'PROCESSING']).toContain(result1.status);
    expect(['SUCCESS', 'PROCESSING']).toContain(result2.status);

    // 5. Verify database records: exactly ONE refund row exists for this idempotency key
    const refundRows = await prisma.refund.findMany({
      where: { idempotencyKey }
    });
    expect(refundRows).toHaveLength(1);
    expect(refundRows[0].id).toBe(initialFailed.id);
    expect(refundRows[0].status).toBe('SUCCESS');
    expect(refundRows[0].cfRefundId).toBe('cf_success_conc_01');

    // 6. Verify subsequent attempt returns SUCCESS immediately with zero gateway calls
    const thirdAttempt = await refundService.createRefund({
      paymentId,
      amount: 50.0,
      idempotencyKey,
      reason: 'Third retry attempt'
    });
    expect(thirdAttempt.status).toBe('SUCCESS');
    expect(gatewayCallCount).toBe(1); // Still exactly 1
  });

  test('proves gateway timeout marks status PROCESSING with retryEligible=false and blocks blind second gateway retry', async () => {
    const timeoutKey = 'idemp_timeout_test_01';
    let timeoutGatewayCalls = 0;

    cashfreeGateway.createRefund = jest.fn(async () => {
      timeoutGatewayCalls++;
      await new Promise((r) => setTimeout(r, 40));
      return {
        success: false,
        isTimeout: true,
        error: 'Cashfree Gateway response timed out after 10000ms',
        rawResponse: { code: 'ETIMEDOUT' }
      };
    });

    // Attempt 1: times out
    const timeoutResult = await refundService.createRefund({
      paymentId,
      amount: 25.0,
      idempotencyKey: timeoutKey,
      reason: 'Timeout test'
    });

    expect(timeoutResult.status).toBe('PROCESSING');
    expect(timeoutResult.retryEligible).toBe(false);
    expect(timeoutGatewayCalls).toBe(1);

    // Verify DB row is in PROCESSING and not retry-eligible
    const dbRow = await prisma.refund.findUnique({ where: { idempotencyKey: timeoutKey } });
    expect(dbRow.status).toBe('PROCESSING');
    expect(dbRow.retryEligible).toBe(false);

    // Attempt 2: second request with the same idempotency key
    const blindRetryResult = await refundService.createRefund({
      paymentId,
      amount: 25.0,
      idempotencyKey: timeoutKey,
      reason: 'Attempt blind retry'
    });

    // Must be blocked from triggering a second gateway call!
    expect(blindRetryResult.status).toBe('PROCESSING');
    expect(timeoutGatewayCalls).toBe(1); // Gateway was NOT called a second time
  });

  test('proves crash after claiming refund in PROCESSING is fully recovered by existing reconciliation process', async () => {
    const crashKey = 'idemp_crash_recovery_01';

    // Simulate process crash after atomic claim: record exists in DB as PROCESSING
    const claimedRecord = await prisma.refund.create({
      data: {
        idempotencyKey: crashKey,
        paymentId,
        gatewayRefundId: 'ref_crashed_in_flight_01',
        amount: 20.0,
        currency: 'INR',
        reason: 'Crash recovery test',
        status: 'PROCESSING',
        retryEligible: false
      }
    });

    // Mock Cashfree reporting that the refund did indeed succeed upstream
    cashfreeGateway.getRefundDetails = jest.fn(async (orderId, refundId) => {
      if (refundId === 'ref_crashed_in_flight_01') {
        return {
          success: true,
          status: 'SUCCESS',
          cfRefundId: 'cf_recovered_by_cron_01',
          rawResponse: { refund_status: 'SUCCESS' }
        };
      }
      return { success: false, status: 'NOT_FOUND' };
    });

    // Run existing reconciliation service
    const report = await reconciliationService.runReconciliation({ limit: 50, dryRun: false });

    // Verify refund was transitioned from PROCESSING to SUCCESS
    const recovered = await prisma.refund.findUnique({
      where: { id: claimedRecord.id }
    });
    expect(recovered.status).toBe('SUCCESS');
    expect(recovered.cfRefundId).toBe('cf_recovered_by_cron_01');

    // Verify audit transaction was recorded
    const recoveryTx = await prisma.transaction.findFirst({
      where: {
        paymentId,
        action: 'RECONCILIATION_REFUND_SUCCESS'
      }
    });
    expect(recoveryTx).not.toBeNull();
    expect(recoveryTx.status).toBe('SUCCESS');
  });

  test('Finding 5 — proves cross-payment idempotency key reuse is rejected with 409 Conflict without triggering gateway or creating refund for payment 2', async () => {
    const crossKey = 'idemp_cross_payment_integration_01';

    // 1. First refund succeeds on payment 1
    cashfreeGateway.createRefund = jest.fn(async ({ refundId, amount }) => ({
      success: true,
      status: 'SUCCESS',
      cfRefundId: 'cf_cross_01',
      rawResponse: { refund_id: refundId, amount, status: 'SUCCESS' }
    }));

    const refund1 = await refundService.createRefund({
      paymentId,
      amount: 40.0,
      idempotencyKey: crossKey,
      reason: 'Refund on payment 1'
    });
    expect(refund1.status).toBe('SUCCESS');
    expect(cashfreeGateway.createRefund).toHaveBeenCalledTimes(1);

    // 2. Second refund attempt uses the SAME idempotency key on payment 2
    let crossError;
    try {
      await refundService.createRefund({
        paymentId: paymentId2,
        amount: 40.0,
        idempotencyKey: crossKey,
        reason: 'Attempt cross-payment reuse'
      });
    } catch (err) {
      crossError = err;
    }

    // Must be rejected with 409 Conflict
    expect(crossError).toBeDefined();
    expect(crossError.statusCode).toBe(409);
    expect(crossError.message).toMatch(/is already bound to another payment/);
    expect(crossError.message).toContain(paymentId);

    // Gateway must NOT have been called a second time
    expect(cashfreeGateway.createRefund).toHaveBeenCalledTimes(1);

    // Zero refund records exist for payment 2
    const pay2Refunds = await prisma.refund.findMany({ where: { paymentId: paymentId2 } });
    expect(pay2Refunds).toHaveLength(0);

    // Zero transaction records exist for payment 2
    const pay2Transactions = await prisma.transaction.findMany({ where: { paymentId: paymentId2 } });
    expect(pay2Transactions).toHaveLength(0);
  });
});
