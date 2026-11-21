const mockPrisma = {
  refund: {
    findUnique: jest.fn(),
    findMany: jest.fn().mockResolvedValue([]),
    findFirst: jest.fn(),
    create: jest.fn(),
    update: jest.fn()
  },
  payment: {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn().mockResolvedValue([]),
    update: jest.fn()
  },
  transaction: {
    create: jest.fn()
  },
  reconciliationRecord: {
    findFirst: jest.fn(),
    create: jest.fn().mockResolvedValue({ id: 'rec-1' }),
    updateMany: jest.fn().mockResolvedValue({ count: 1 })
  },
  paymentEvent: {
    groupBy: jest.fn().mockResolvedValue([])
  },
  $transaction: jest.fn((cb) => cb(mockPrisma)),
  $executeRawUnsafe: jest.fn().mockResolvedValue(1)
};

jest.mock('../src/utils/prisma', () => mockPrisma);

jest.mock('../src/services/cashfreeGateway.adapter', () => ({
  createRefund: jest.fn(),
  getRefundDetails: jest.fn(),
  getOrderPayments: jest.fn().mockResolvedValue({ success: true, payments: [] }),
  setMockMode: jest.fn()
}));

jest.mock('../src/services/invoice.service', () => ({
  issueCreditNoteForInvoice: jest.fn().mockResolvedValue({})
}));

const AppError = require('../src/utils/AppError');
const cashfreeGateway = require('../src/services/cashfreeGateway.adapter');
const refundService = require('../src/services/refund.service');
const reconciliationService = require('../src/services/reconciliation.service');

const prisma = require('../src/utils/prisma');

describe('PR #19 Safety Followup: Cashfree Refund Uncertain-Outcome & Idempotency Protection', () => {
  const paymentId = 'pay-cashfree-001';
  const idempotencyKey = 'idemp_refund_test_001';
  const basePayment = {
    id: paymentId,
    amount: 100.0,
    currency: 'INR',
    status: 'SUCCESS',
    paymentMethod: 'cashfree_upi',
    paymentGroup: 'upi',
    gatewayOrderId: 'order_cf_001',
    gatewayPaymentId: 'cf_pay_001',
    refunds: [],
    printJobs: [{ id: 'job-cf-1', invoice: null, machine: { id: 'm-1' } }]
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // Scenario 1: Same refund intent never generates a second provider refund identity
  test('1. Same refund intent never generates a second provider refund identity on retry', async () => {
    const existingFailed = {
      id: 'ref-failed-001',
      idempotencyKey,
      paymentId,
      amount: 100.0,
      status: 'FAILED',
      retryEligible: true,
      gatewayRefundId: 'ref_stable_identity_123',
      payment: basePayment
    };

    // First find inside pre-check
    prisma.refund.findUnique.mockResolvedValueOnce(existingFailed);
    prisma.payment.findUnique.mockResolvedValueOnce(basePayment);

    const txMock = {
      $executeRawUnsafe: jest.fn().mockResolvedValue(1),
      refund: {
        findUnique: jest.fn().mockResolvedValueOnce(existingFailed),
        findMany: jest.fn().mockResolvedValueOnce([]),
        update: jest.fn().mockImplementation(({ where, data }) => ({
          ...existingFailed,
          ...data,
          id: where.id
        }))
      },
      payment: {
        update: jest.fn().mockResolvedValue(basePayment)
      },
      transaction: {
        create: jest.fn().mockResolvedValue({ id: 'tx-1' })
      },
      reconciliationRecord: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 })
      }
    };

    prisma.$transaction.mockImplementation(async (cb) => cb(txMock));

    // Gateway mock returns SUCCESS
    cashfreeGateway.createRefund.mockResolvedValueOnce({
      success: true,
      cfRefundId: 'cf_ref_success_999',
      status: 'SUCCESS',
      rawResponse: { refund_status: 'SUCCESS' }
    });

    const result = await refundService.createRefund({
      paymentId,
      amount: 100.0,
      idempotencyKey
    });

    // Check that gateway was called with the EXACT original gatewayRefundId, not a newly generated one!
    expect(cashfreeGateway.createRefund).toHaveBeenCalledWith(expect.objectContaining({
      orderId: 'order_cf_001',
      refundId: 'ref_stable_identity_123',
      amount: 100.0
    }));

    expect(result.gatewayRefundId).toBe('ref_stable_identity_123');
  });

  // Scenario 2: HTTP 409 duplicate response does not create a new gateway request ID and reconciles
  test('2. HTTP 409 duplicate response does not create a new gateway request ID and reconciles existing', async () => {
    prisma.refund.findUnique.mockResolvedValueOnce(null);
    prisma.payment.findUnique.mockResolvedValueOnce(basePayment);

    const initialRefundRecord = {
      id: 'ref-dup-1',
      idempotencyKey,
      paymentId,
      gatewayRefundId: 'ref_original_dup_456',
      amount: 100.0,
      status: 'PROCESSING',
      retryEligible: false
    };

    const txMock = {
      $executeRawUnsafe: jest.fn().mockResolvedValue(1),
      refund: {
        findUnique: jest.fn().mockResolvedValueOnce(null),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockResolvedValueOnce(initialRefundRecord),
        update: jest.fn().mockImplementation(({ where, data }) => ({
          ...initialRefundRecord,
          ...data
        }))
      },
      payment: {
        update: jest.fn().mockResolvedValue(basePayment)
      },
      transaction: {
        create: jest.fn().mockResolvedValue({ id: 'tx-dup' })
      },
      reconciliationRecord: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 })
      }
    };

    prisma.$transaction.mockImplementation(async (cb) => cb(txMock));

    // Gateway reports 409 / refund_already_exists
    cashfreeGateway.createRefund.mockResolvedValueOnce({
      success: false,
      isDuplicate: true,
      statusCode: 409,
      error: 'refund_already_exists'
    });

    // Reconciliation call confirms the existing refund was indeed successful at Cashfree
    cashfreeGateway.getRefundDetails.mockResolvedValueOnce({
      success: true,
      status: 'SUCCESS',
      cfRefundId: 'cf_ref_reconciled_456',
      rawResponse: { refund_status: 'SUCCESS' }
    });

    const result = await refundService.createRefund({
      paymentId,
      amount: 100.0,
      idempotencyKey
    });

    // Reconciled using existing ID
    expect(cashfreeGateway.getRefundDetails).toHaveBeenCalledWith('order_cf_001', 'ref_original_dup_456');
    expect(result.status).toBe('SUCCESS');
    expect(result.cfRefundId).toBe('cf_ref_reconciled_456');
  });

  // Scenario 3: HTTP 500 after possible provider execution remains PROCESSING
  test('3. HTTP 500 after possible provider execution remains PROCESSING and non-retryable', async () => {
    prisma.refund.findUnique.mockResolvedValueOnce(null);
    prisma.payment.findUnique.mockResolvedValueOnce(basePayment);

    const initialRefundRecord = {
      id: 'ref-500-1',
      idempotencyKey,
      paymentId,
      gatewayRefundId: 'ref_500_request_789',
      amount: 100.0,
      status: 'PROCESSING',
      retryEligible: false
    };

    const txMock = {
      $executeRawUnsafe: jest.fn().mockResolvedValue(1),
      refund: {
        findUnique: jest.fn().mockResolvedValueOnce(null),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockResolvedValueOnce(initialRefundRecord),
        update: jest.fn().mockImplementation(({ where, data }) => ({
          ...initialRefundRecord,
          ...data
        }))
      },
      payment: {
        update: jest.fn().mockResolvedValue(basePayment)
      },
      transaction: {
        create: jest.fn().mockResolvedValue({ id: 'tx-500' })
      },
      reconciliationRecord: {
        create: jest.fn().mockResolvedValue({ id: 'rec-500' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 })
      }
    };

    prisma.$transaction.mockImplementation(async (cb) => cb(txMock));

    // Gateway throws HTTP 500 internal server error
    cashfreeGateway.createRefund.mockResolvedValueOnce({
      success: false,
      isServerError: true,
      isUncertainOutcome: true,
      statusCode: 500,
      error: 'Internal Server Error from Cashfree API'
    });

    const result = await refundService.createRefund({
      paymentId,
      amount: 100.0,
      idempotencyKey
    });

    // FAIL-CLOSED ASSERTION: Record must remain in PROCESSING, retryEligible must remain false
    expect(result.status).toBe('PROCESSING');
    expect(result.retryEligible).toBe(false);
    expect(result.gatewayRefundId).toBe('ref_500_request_789');

    // Structured reconciliation record created
    expect(txMock.reconciliationRecord.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        paymentId,
        status: 'PENDING_RECONCILIATION',
        discrepancyType: 'UNCERTAIN_GATEWAY_REFUND_OUTCOME'
      })
    }));
  });

  // Scenario 4: Connection reset / read timeout remains unresolved and non-retryable
  test('4. Connection reset / read timeout remains unresolved and non-retryable', async () => {
    prisma.refund.findUnique.mockResolvedValueOnce(null);
    prisma.payment.findUnique.mockResolvedValueOnce(basePayment);

    const initialRefundRecord = {
      id: 'ref-reset-1',
      idempotencyKey,
      paymentId,
      gatewayRefundId: 'ref_reset_req_101',
      amount: 100.0,
      status: 'PROCESSING',
      retryEligible: false
    };

    const txMock = {
      $executeRawUnsafe: jest.fn().mockResolvedValue(1),
      refund: {
        findUnique: jest.fn().mockResolvedValueOnce(null),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockResolvedValueOnce(initialRefundRecord),
        update: jest.fn().mockImplementation(({ where, data }) => ({
          ...initialRefundRecord,
          ...data
        }))
      },
      payment: {
        update: jest.fn().mockResolvedValue(basePayment)
      },
      transaction: {
        create: jest.fn().mockResolvedValue({ id: 'tx-reset' })
      },
      reconciliationRecord: {
        create: jest.fn().mockResolvedValue({ id: 'rec-reset' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 })
      }
    };

    prisma.$transaction.mockImplementation(async (cb) => cb(txMock));

    // Gateway encounters ECONNRESET after dispatch
    cashfreeGateway.createRefund.mockResolvedValueOnce({
      success: false,
      isConnectionReset: true,
      isUncertainOutcome: true,
      error: 'read ECONNRESET'
    });

    const result = await refundService.createRefund({
      paymentId,
      amount: 100.0,
      idempotencyKey
    });

    expect(result.status).toBe('PROCESSING');
    expect(result.retryEligible).toBe(false);
  });

  // Scenario 5: Reconciliation uses exactly the same persisted gatewayRefundId
  test('5. Reconciliation uses exactly the same persisted gatewayRefundId', async () => {
    const processingRefund = {
      id: 'ref-rec-test-1',
      gatewayRefundId: 'ref_exact_persisted_gateway_id_888',
      amount: 50.0,
      status: 'PROCESSING',
      paymentId: 'pay-001',
      payment: {
        id: 'pay-001',
        amount: 50.0,
        gatewayOrderId: 'order_gw_888',
        printJobs: []
      },
      creditNotes: []
    };

    prisma.payment.findMany.mockResolvedValueOnce([]);
    prisma.refund.findMany.mockResolvedValueOnce([processingRefund]);

    // Cashfree returns SUCCESS for this exact refundId
    cashfreeGateway.getRefundDetails.mockResolvedValueOnce({
      success: true,
      status: 'SUCCESS',
      cfRefundId: 'cf_ref_verified_888',
      rawResponse: { refund_status: 'SUCCESS' }
    });

    await reconciliationService.runReconciliation({ limit: 10 });

    expect(cashfreeGateway.getRefundDetails).toHaveBeenCalledWith(
      'order_gw_888',
      'ref_exact_persisted_gateway_id_888'
    );
  });

  // Scenario 6: Definitive safe rejection follows the explicitly documented retry policy
  test('6. Definitive provider rejection follows fail-closed non-retryable policy by default', async () => {
    prisma.refund.findUnique.mockResolvedValueOnce(null);
    prisma.payment.findUnique.mockResolvedValueOnce(basePayment);

    const initialRefundRecord = {
      id: 'ref-def-1',
      idempotencyKey,
      paymentId,
      gatewayRefundId: 'ref_def_rejection_202',
      amount: 100.0,
      status: 'PROCESSING',
      retryEligible: false
    };

    const txMock = {
      $executeRawUnsafe: jest.fn().mockResolvedValue(1),
      refund: {
        findUnique: jest.fn().mockResolvedValueOnce(null),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockResolvedValueOnce(initialRefundRecord),
        update: jest.fn().mockImplementation(({ where, data }) => ({
          ...initialRefundRecord,
          ...data
        }))
      },
      payment: {
        update: jest.fn().mockResolvedValue(basePayment)
      },
      transaction: {
        create: jest.fn().mockResolvedValue({ id: 'tx-def' })
      }
    };

    prisma.$transaction.mockImplementation(async (cb) => cb(txMock));

    // Gateway returns HTTP 400 with definitive rejection code
    cashfreeGateway.createRefund.mockResolvedValueOnce({
      success: false,
      isDefinitiveFailure: true,
      statusCode: 400,
      error: 'order_already_fully_refunded'
    });

    const result = await refundService.createRefund({
      paymentId,
      amount: 100.0,
      idempotencyKey
    });

    expect(result.status).toBe('FAILED');
    expect(result.retryEligible).toBe(false);
  });

  // Scenario 7: Concurrent retries cannot create duplicate external refund operations
  test('7. Concurrent retries cannot create duplicate external refund operations', async () => {
    // If an existing refund is in PROCESSING, any concurrent call returns the existing record immediately
    const inFlightRefund = {
      id: 'ref-inflight-1',
      idempotencyKey,
      paymentId,
      status: 'PROCESSING',
      amount: 100.0,
      gatewayRefundId: 'ref_inflight_999'
    };

    prisma.refund.findUnique.mockResolvedValue(inFlightRefund);

    const result1 = await refundService.createRefund({ paymentId, amount: 100.0, idempotencyKey });
    const result2 = await refundService.createRefund({ paymentId, amount: 100.0, idempotencyKey });

    expect(result1.status).toBe('PROCESSING');
    expect(result2.status).toBe('PROCESSING');
    expect(cashfreeGateway.createRefund).not.toHaveBeenCalled();
  });

  // Scenario 8: Cumulative refunds cannot exceed captured payment amount
  test('8. Cumulative refunds cannot exceed captured payment amount', async () => {
    const paymentWithExistingRefunds = {
      ...basePayment,
      amount: 100.0,
      refunds: [
        { id: 'ref-prior-1', status: 'SUCCESS', amount: 80.0 }
      ]
    };

    prisma.refund.findUnique.mockResolvedValueOnce(null);
    prisma.payment.findUnique.mockResolvedValueOnce(paymentWithExistingRefunds);

    // Requesting Rs 50 when only Rs 20 remains must reject before transaction or gateway
    await expect(refundService.createRefund({
      paymentId,
      amount: 50.0, // 80 + 50 = 130 > 100
      idempotencyKey: 'idemp_over_refund'
    })).rejects.toThrow(/exceeds remaining refundable balance/);

    expect(cashfreeGateway.createRefund).not.toHaveBeenCalled();
  });
});
