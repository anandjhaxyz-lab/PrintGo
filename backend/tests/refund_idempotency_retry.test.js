const AppError = require('../src/utils/AppError');
const cashfreeGateway = require('../src/services/cashfreeGateway.adapter');
const refundService = require('../src/services/refund.service');
const prisma = require('../src/utils/prisma');

jest.mock('../src/utils/prisma', () => ({
  refund: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn()
  },
  payment: {
    findUnique: jest.fn(),
    update: jest.fn()
  },
  transaction: {
    create: jest.fn()
  },
  reconciliationRecord: {
    updateMany: jest.fn()
  },
  $transaction: jest.fn(),
  $executeRawUnsafe: jest.fn()
}));

jest.mock('../src/services/cashfreeGateway.adapter', () => ({
  createRefund: jest.fn(),
  setMockMode: jest.fn()
}));

jest.mock('../src/services/invoice.service', () => ({
  issueCreditNoteForInvoice: jest.fn().mockResolvedValue({})
}));

describe('Phase 4A Refund Idempotency Retry & Concurrency Safety', () => {
  const paymentId = 'pay-001';
  const idempotencyKey = 'spooler_failure_job-1_pay-001';
  const basePayment = {
    id: paymentId,
    amount: 100.0,
    currency: 'INR',
    status: 'SUCCESS',
    paymentMethod: 'cashfree_upi',
    paymentGroup: 'upi',
    gatewayOrderId: 'order_001',
    gatewayPaymentId: 'cf_pay_001',
    refunds: [],
    printJobs: [{ id: 'job-1', invoice: null, machine: { id: 'm-1' } }]
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('retry same key with FAILED and retryEligible=true succeeds and claims record', async () => {
    const failedRefund = {
      id: 'ref-failed-1',
      idempotencyKey,
      paymentId,
      amount: 100.0,
      status: 'FAILED',
      retryEligible: true,
      failureReason: 'Temporary network disconnect'
    };

    // Step 1 check
    prisma.refund.findUnique.mockResolvedValueOnce(failedRefund);
    // Step 2 fetch payment
    prisma.payment.findUnique.mockResolvedValueOnce({
      ...basePayment,
      refunds: [failedRefund]
    });

    const claimedRefund = {
      ...failedRefund,
      status: 'PROCESSING',
      retryEligible: false,
      gatewayRefundId: 'ref_order_001_12345'
    };

    const txMock = {
      $executeRawUnsafe: jest.fn().mockResolvedValue(),
      refund: {
        findUnique: jest.fn().mockResolvedValue(failedRefund),
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockImplementation(({ where, data }) => ({
          ...failedRefund,
          ...data
        }))
      },
      transaction: {
        create: jest.fn().mockResolvedValue({ id: 'tx-1' })
      },
      payment: {
        update: jest.fn().mockResolvedValue({ id: paymentId, status: 'REFUNDED' })
      },
      reconciliationRecord: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 })
      }
    };

    // Tx 1: claim
    prisma.$transaction.mockImplementationOnce(async (callback) => callback(txMock));

    // Gateway call
    cashfreeGateway.createRefund.mockResolvedValueOnce({
      success: true,
      status: 'SUCCESS',
      cfRefundId: 'cf_ref_999',
      rawResponse: { refund_id: 'cf_ref_999' }
    });

    // Tx 2: finalize
    prisma.$transaction.mockImplementationOnce(async (callback) => callback(txMock));

    const result = await refundService.createRefund({
      paymentId,
      amount: 100.0,
      reason: 'Automated retry after error',
      idempotencyKey,
      initiatedBy: 'SYSTEM_RETRY'
    });

    expect(result.status).toBe('SUCCESS');
    expect(txMock.refund.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'ref-failed-1' },
      data: expect.objectContaining({
        status: 'PROCESSING',
        retryEligible: false
      })
    }));
    expect(cashfreeGateway.createRefund).toHaveBeenCalledTimes(1);
    expect(txMock.reconciliationRecord.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        OR: [
          { refundId: 'ref-failed-1' },
          { paymentId, discrepancyType: 'FAILED_AUTOMATIC_REFUND' }
        ],
        resolved: false
      }),
      data: expect.objectContaining({
        resolved: true,
        resolvedBy: 'SYSTEM_RETRY'
      })
    }));
  });

  test('rejects retry when retryEligible is false on a FAILED record', async () => {
    const unretriableRefund = {
      id: 'ref-failed-no-retry',
      idempotencyKey,
      paymentId,
      amount: 100.0,
      status: 'FAILED',
      retryEligible: false,
      failureReason: 'Card issuer permanently declined refund'
    };

    prisma.refund.findUnique.mockResolvedValueOnce(unretriableRefund);

    const result = await refundService.createRefund({
      paymentId,
      amount: 100.0,
      idempotencyKey
    });

    expect(result).toBe(unretriableRefund);
    expect(prisma.payment.findUnique).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(cashfreeGateway.createRefund).not.toHaveBeenCalled();
  });

  test('existing SUCCESS returns immediately without gateway call', async () => {
    const successRefund = {
      id: 'ref-success-1',
      idempotencyKey,
      paymentId,
      amount: 100.0,
      status: 'SUCCESS',
      cfRefundId: 'cf_ref_111'
    };

    prisma.refund.findUnique.mockResolvedValueOnce(successRefund);

    const result = await refundService.createRefund({
      paymentId,
      amount: 100.0,
      idempotencyKey
    });

    expect(result).toBe(successRefund);
    expect(prisma.payment.findUnique).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(cashfreeGateway.createRefund).not.toHaveBeenCalled();
  });

  test('existing PROCESSING returns immediately without triggering second gateway dispatch', async () => {
    const inFlightRefund = {
      id: 'ref-inflight-1',
      idempotencyKey,
      paymentId,
      amount: 100.0,
      status: 'PROCESSING',
      gatewayRefundId: 'ref_order_001_existing'
    };

    prisma.refund.findUnique.mockResolvedValueOnce(inFlightRefund);

    const result = await refundService.createRefund({
      paymentId,
      amount: 100.0,
      idempotencyKey
    });

    expect(result).toBe(inFlightRefund);
    expect(prisma.payment.findUnique).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(cashfreeGateway.createRefund).not.toHaveBeenCalled();
  });

  test('gateway timeout marks refund as PROCESSING and retryEligible=false to preserve ambiguity', async () => {
    prisma.refund.findUnique.mockResolvedValueOnce(null);
    prisma.payment.findUnique.mockResolvedValueOnce(basePayment);

    const createdRefund = {
      id: 'ref-new-1',
      idempotencyKey,
      paymentId,
      amount: 100.0,
      status: 'PROCESSING',
      retryEligible: false,
      gatewayRefundId: 'ref_order_001_new'
    };

    const txMock = {
      $executeRawUnsafe: jest.fn().mockResolvedValue(),
      refund: {
        findUnique: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockImplementation(async ({ data }) => ({
          id: 'ref-new-1',
          ...data
        })),
        update: jest.fn().mockImplementation(async ({ data }) => ({
          id: 'ref-new-1',
          ...data
        }))
      },
      transaction: {
        create: jest.fn().mockResolvedValue({ id: 'tx-timeout' })
      }
    };

    // Tx 1: create initial PROCESSING record
    prisma.$transaction.mockImplementationOnce(async (callback) => callback(txMock));

    // Gateway call times out
    cashfreeGateway.createRefund.mockResolvedValueOnce({
      success: false,
      isTimeout: true,
      error: 'Gateway request timed out after 10000ms',
      rawResponse: { error: 'ETIMEDOUT' }
    });

    // Tx 2: finalize with timeout state
    prisma.$transaction.mockImplementationOnce(async (callback) => callback(txMock));

    const result = await refundService.createRefund({
      paymentId,
      amount: 100.0,
      idempotencyKey
    });

    expect(result.status).toBe('PROCESSING');
    expect(result.retryEligible).toBe(false);
    expect(txMock.refund.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'ref-new-1' },
      data: expect.objectContaining({
        status: 'PROCESSING',
        retryEligible: false,
        failureReason: expect.stringContaining('timed out')
      })
    }));
  });

  // =========================================================================
  // Finding 5 — Bind refund idempotency keys to their owning payment
  // =========================================================================
  test('rejects cross-payment idempotency key reuse in pre-check with 409 Conflict and zero mutations', async () => {
    const crossPaymentRefund = {
      id: 'ref-existing-other',
      idempotencyKey: 'cross_payment_key_01',
      paymentId: 'pay-other-tenant',
      amount: 100.0,
      status: 'SUCCESS'
    };

    // Pre-check finds key already bound to a different payment
    prisma.refund.findUnique.mockResolvedValueOnce(crossPaymentRefund);

    let thrownError;
    try {
      await refundService.createRefund({
        paymentId: 'pay-current-tenant',
        amount: 100.0,
        idempotencyKey: 'cross_payment_key_01'
      });
    } catch (err) {
      thrownError = err;
    }

    expect(thrownError).toBeDefined();
    expect(thrownError.statusCode).toBe(409);
    expect(thrownError.message).toMatch(/is already bound to another payment \(pay-other-tenant\)\. Cross-payment key reuse is forbidden/);

    expect(prisma.payment.findUnique).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(cashfreeGateway.createRefund).not.toHaveBeenCalled();
  });

  test('rejects cross-payment idempotency key claimed in concurrent race with 409 Conflict inside transaction', async () => {
    // Step 1: Pre-check returns null (not yet claimed at start)
    prisma.refund.findUnique.mockResolvedValueOnce(null);
    // Step 2: Fetch payment
    prisma.payment.findUnique.mockResolvedValueOnce(basePayment);

    const concurrentClaimedRefund = {
      id: 'ref-raced-by-other',
      idempotencyKey: 'raced_key_01',
      paymentId: 'pay-concurrent-rival',
      amount: 100.0,
      status: 'PROCESSING'
    };

    const txMock = {
      $executeRawUnsafe: jest.fn().mockResolvedValue(),
      refund: {
        findUnique: jest.fn().mockResolvedValue(concurrentClaimedRefund),
        create: jest.fn(),
        update: jest.fn()
      },
      payment: {
        update: jest.fn()
      },
      transaction: {
        create: jest.fn()
      }
    };

    prisma.$transaction.mockImplementationOnce(async (callback) => callback(txMock));

    let thrownError;
    try {
      await refundService.createRefund({
        paymentId,
        amount: 100.0,
        idempotencyKey: 'raced_key_01'
      });
    } catch (err) {
      thrownError = err;
    }

    expect(thrownError).toBeDefined();
    expect(thrownError.statusCode).toBe(409);
    expect(thrownError.message).toMatch(/is already bound to another payment \(pay-concurrent-rival\)\. Cross-payment key reuse is forbidden/);

    expect(txMock.refund.create).not.toHaveBeenCalled();
    expect(txMock.payment.update).not.toHaveBeenCalled();
    expect(cashfreeGateway.createRefund).not.toHaveBeenCalled();
  });
});
