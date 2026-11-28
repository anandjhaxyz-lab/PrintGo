const request = require('supertest');
const express = require('express');
const crypto = require('crypto');

jest.mock('../../src/utils/prisma', () => ({
  payment: {
    create: jest.fn(),
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
    deleteMany: jest.fn()
  },
  paymentEvent: {
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn()
  },
  transaction: {
    create: jest.fn(),
    findFirst: jest.fn()
  },
  refund: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
    findFirst: jest.fn(),
    create: jest.fn(),
    update: jest.fn()
  },
  reconciliationRecord: {
    create: jest.fn()
  },
  printJob: {
    create: jest.fn(),
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    update: jest.fn(),
    deleteMany: jest.fn()
  },
  $executeRawUnsafe: jest.fn(),
  $transaction: jest.fn(),
  $disconnect: jest.fn()
}));

const mockPrisma = require('../../src/utils/prisma');
const axios = require('axios');
jest.mock('axios');

// Use non-placeholder sandbox test credentials for signature/config validation
process.env.CASHFREE_ENV = 'sandbox';
process.env.CASHFREE_APP_ID = 'MOCK_SANDBOX_CLIENT_999';
process.env.CASHFREE_SECRET_KEY = 'cfsk_ma_test_unit_webhook_secret_key_999';

// Mock middlewares before requiring router
jest.mock('../../src/middlewares/auth', () => ({
  protect: (req, res, next) => {
    req.user = { id: 'admin_1', role: 'SUPERADMIN' };
    next();
  },
  restrictTo: (...roles) => (req, res, next) => next(),
}));

jest.mock('../../src/middlewares/session', () => ({
  requireSessionOrUser: (req, res, next) => next(),
}));

jest.mock('../../src/services/queueService', () => ({
  startPrintingProcess: jest.fn()
}));

const paymentsRoutes = require('../../src/modules/payments/payments.routes');
const cashfreeGateway = require('../../src/services/cashfreeGateway.adapter');
const { errorHandler } = require('../../src/middlewares/error');

const app = express();
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf.toString();
  }
}));

const mockIo = {
  to: jest.fn().mockReturnThis(),
  emit: jest.fn()
};
app.set('io', mockIo);

app.use('/api/payments', paymentsRoutes);
app.use(errorHandler);

describe('Payment Webhooks & Refund Tests', () => {
  let testJob;
  let testPayment;

  beforeAll(() => {
    testJob = {
      id: 'job-uuid-1',
      shortId: `job_${Date.now()}`,
      status: 'PENDING_PAYMENT',
      cost: 10,
      pagesToPrint: 1,
      color: 'BLACK_AND_WHITE',
      duplex: 'NONE',
      copies: 1,
      paymentId: 'pay-uuid-1'
    };

    testPayment = {
      id: 'pay-uuid-1',
      amount: 10,
      currency: 'INR',
      type: 'PRINT_JOB',
      gatewayOrderId: `order_${testJob.shortId}_1700000000`,
      gatewaySessionId: 'dummy_session',
      status: 'PENDING',
      refunds: [],
      printJobs: [{ ...testJob }]
    };
  });

  afterAll(() => {
    cashfreeGateway.setMockMode(false);
    jest.clearAllMocks();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    cashfreeGateway.setMockMode(false);
    mockPrisma.paymentEvent.findUnique.mockResolvedValue(null);
    mockPrisma.paymentEvent.create.mockResolvedValue({ id: 'evt-1', processed: false });
    mockPrisma.paymentEvent.update.mockResolvedValue({ id: 'evt-1', processed: true });
    mockPrisma.payment.findFirst.mockResolvedValue(null);
  });

  it('POST /api/payments/webhook/cashfree should reject requests without signature headers', async () => {
    const res = await request(app)
      .post('/api/payments/webhook/cashfree')
      .send({ type: 'PAYMENT_SUCCESS_WEBHOOK' });

    expect(res.statusCode).toEqual(401);
    expect(res.text).toContain('Missing signature headers');
  });

  it('POST /api/payments/webhook/cashfree should reject requests with invalid signature', async () => {
    const res = await request(app)
      .post('/api/payments/webhook/cashfree')
      .set('x-webhook-signature', 'invalid_signature')
      .set('x-webhook-timestamp', Date.now().toString())
      .send({ type: 'PAYMENT_SUCCESS_WEBHOOK' });

    expect(res.statusCode).toEqual(401);
    expect(res.text).toContain('Invalid webhook signature');
  });

  it('POST /api/payments/webhook/cashfree should process valid webhook and update job status', async () => {
    const payload = {
      type: 'PAYMENT_SUCCESS_WEBHOOK',
      data: {
        order: { order_id: testPayment.gatewayOrderId }
      }
    };

    const payloadString = JSON.stringify(payload);
    const timestamp = Date.now().toString();

    const signature = crypto
      .createHmac('sha256', process.env.CASHFREE_SECRET_KEY)
      .update(timestamp + payloadString)
      .digest('base64');

    axios.get.mockResolvedValueOnce({
      data: { order_status: 'PAID', order_amount: 10 }
    }).mockResolvedValueOnce({
      data: [{ cf_payment_id: '987654', payment_status: 'SUCCESS', payment_group: 'upi', payment_method: { upi: {} } }]
    });

    mockPrisma.payment.findUnique.mockResolvedValue(testPayment);

    mockPrisma.$transaction.mockImplementationOnce(async (cb) => {
      const tx = {
        $executeRawUnsafe: jest.fn().mockResolvedValue(1),
        payment: {
          findFirst: jest.fn().mockResolvedValue(null),
          updateMany: jest.fn().mockResolvedValue({ count: 1 })
        },
        transaction: {
          create: jest.fn().mockResolvedValue({ id: 'tx-1' })
        },
        printJob: {
          findUnique: jest.fn().mockResolvedValue(testJob),
          findFirst: jest.fn().mockResolvedValue(testJob),
          update: jest.fn().mockResolvedValue({ ...testJob, status: 'WAITING' })
        },
        reconciliationRecord: {
          create: jest.fn()
        }
      };
      return cb(tx);
    });

    const res = await request(app)
      .post('/api/payments/webhook/cashfree')
      .set('x-webhook-signature', signature)
      .set('x-webhook-timestamp', timestamp)
      .set('Content-Type', 'application/json')
      .send(payloadString);

    expect(res.statusCode).toEqual(200);
    expect(res.text).toEqual('OK');
    expect(mockPrisma.$transaction).toHaveBeenCalled();
  });

  it('POST /api/payments/refund/:id should delegate to refund service and update status', async () => {
    cashfreeGateway.setMockMode(true, {
      createRefund: async ({ refundId, amount }) => ({
        success: true,
        status: 'SUCCESS',
        cfRefundId: 'cf_ref_mock_1',
        refundId,
        amount,
        rawResponse: { refund_status: 'SUCCESS', cf_refund_id: 'cf_ref_mock_1' }
      })
    });

    const paidPayment = {
      ...testPayment,
      status: 'SUCCESS',
      refunds: [],
      printJobs: [{ ...testJob, status: 'WAITING' }]
    };
    const waitingJob = {
      ...testJob,
      status: 'WAITING',
      payment: { ...testPayment, status: 'SUCCESS' }
    };

    mockPrisma.printJob.findUnique.mockResolvedValue(waitingJob);
    mockPrisma.refund.findUnique.mockResolvedValue(null);
    mockPrisma.payment.findUnique
      .mockResolvedValueOnce(paidPayment)
      .mockResolvedValueOnce({ ...paidPayment, status: 'REFUNDED' });

    const createdRefund = {
      id: 'refund-uuid-1',
      paymentId: paidPayment.id,
      amount: 10,
      status: 'PROCESSING'
    };

    mockPrisma.$transaction
      .mockImplementationOnce(async (cb) => {
        const tx = {
          $executeRawUnsafe: jest.fn().mockResolvedValue(1),
          refund: {
            findUnique: jest.fn().mockResolvedValue(null),
            findMany: jest.fn().mockResolvedValue([]),
            // Mirror Prisma create(): the persisted row must retain the generated gatewayRefundId.
            create: jest.fn().mockImplementation(async ({ data }) => ({ ...createdRefund, gatewayRefundId: data.gatewayRefundId }))
          },
          transaction: { create: jest.fn() }
        };
        return cb(tx);
      })
      .mockImplementationOnce(async (cb) => {
        const tx = {
          $executeRawUnsafe: jest.fn().mockResolvedValue(1),
          refund: {
            update: jest.fn().mockResolvedValue({ ...createdRefund, status: 'SUCCESS' }),
            findMany: jest.fn().mockResolvedValue([{ ...createdRefund, status: 'SUCCESS' }])
          },
          transaction: { create: jest.fn() },
          payment: { update: jest.fn().mockResolvedValue({ ...paidPayment, status: 'REFUNDED' }) }
        };
        return cb(tx);
      });

    mockPrisma.printJob.update.mockResolvedValue({ ...waitingJob, status: 'CANCELLED' });

    const res = await request(app)
      .post(`/api/payments/refund/${testJob.shortId}`)
      .send({ reason: 'Customer cancellation' });

    expect(res.statusCode).toEqual(200);
    expect(res.body.success).toBeTruthy();
    expect(res.body.job.status).toEqual('CANCELLED');
    expect(res.body.refund.status).toEqual('SUCCESS');

    expect(mockIo.to).toHaveBeenCalledWith('admins');
    expect(mockIo.emit).toHaveBeenCalledWith('job_status_changed', expect.objectContaining({
      status: 'CANCELLED'
    }));
  });
});
