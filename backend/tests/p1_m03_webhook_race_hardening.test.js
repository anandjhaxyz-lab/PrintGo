/**
 * p1_m03_webhook_race_hardening.test.js
 *
 * Targeted tests for M-03: Cashfree Webhook Duplicate Event Race Hardening.
 * Covers:
 *  - Normal webhook event processing
 *  - Sequential duplicate event delivery
 *  - Concurrent delivery race resulting in Prisma P2002 on eventId
 *  - Unrelated Prisma P2002 (must rethrow and not be swallowed)
 *  - Duplicate event must not trigger duplicate print dispatch
 *  - Processing failure must not be marked successful
 *  - Signature and replay protections intact
 */

'use strict';

jest.mock('../src/utils/prisma', () => {
  return {
    paymentEvent: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn()
    },
    payment: {
      findUnique: jest.fn(),
      updateMany: jest.fn()
    },
    transaction: {
      create: jest.fn()
    },
    $transaction: jest.fn()
  };
});

jest.mock('../src/modules/payments/payments.service', () => ({
  verifyPayment: jest.fn(),
  createOrder: jest.fn(),
  refundPayment: jest.fn(),
  resolvePrintJobForPayment: jest.fn()
}));

jest.mock('../src/services/queueService', () => ({
  startPrintingProcess: jest.fn()
}));

jest.mock('../src/services/cashfreeGateway.adapter', () => ({
  verifyWebhookSignature: jest.fn()
}));

const prisma = require('../src/utils/prisma');
const paymentsService = require('../src/modules/payments/payments.service');
const queueService = require('../src/services/queueService');
const cashfreeGateway = require('../src/services/cashfreeGateway.adapter');
const paymentsController = require('../src/modules/payments/payments.controller');

describe('M-03: Cashfree Webhook Duplicate Event Race Hardening', () => {
  const ORDER_ID = 'order_JOB001_att1';
  const EVENT_ID = 'evt_test_123456';
  const TIMESTAMP = String(Math.floor(Date.now() / 1000));
  const SIGNATURE = 'valid_mock_signature_hex';

  const mockWebhookPayload = (overrides = {}) => ({
    event_id: EVENT_ID,
    type: 'PAYMENT_SUCCESS_WEBHOOK',
    data: {
      order: {
        order_id: ORDER_ID,
        order_amount: 25.0
      },
      payment: {
        cf_payment_id: 'cf_pay_9999',
        payment_status: 'SUCCESS'
      }
    },
    ...overrides
  });

  const mockRequest = (bodyOverrides = {}, headerOverrides = {}) => ({
    headers: {
      'x-webhook-signature': SIGNATURE,
      'x-webhook-timestamp': TIMESTAMP,
      ...headerOverrides
    },
    rawBody: JSON.stringify(mockWebhookPayload(bodyOverrides)),
    body: mockWebhookPayload(bodyOverrides),
    ip: '127.0.0.1',
    connection: { remoteAddress: '127.0.0.1' },
    app: {
      get: jest.fn().mockReturnValue({}) // mock socket io
    }
  });

  const mockResponse = () => {
    const res = {};
    res.status = jest.fn().mockReturnValue(res);
    res.send = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    return res;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CASHFREE_SECRET_KEY = 'mock_secret_key_for_webhook_tests';
    cashfreeGateway.verifyWebhookSignature.mockReturnValue(true);
  });

  afterEach(() => {
    delete process.env.CASHFREE_SECRET_KEY;
  });

  test('1. Normal webhook event: records event, verifies payment, updates event to processed', async () => {
    prisma.paymentEvent.findUnique.mockResolvedValue(null);
    prisma.paymentEvent.create.mockResolvedValue({
      id: 'pe-uuid-1',
      eventId: EVENT_ID,
      processed: false
    });
    paymentsService.verifyPayment.mockResolvedValue({
      updatedJob: { shortId: 'JOB001', status: 'WAITING' },
      wasJustUpdated: true
    });
    prisma.paymentEvent.update.mockResolvedValue({
      id: 'pe-uuid-1',
      processed: true
    });

    const req = mockRequest();
    const res = mockResponse();
    const next = jest.fn();

    await paymentsController.cashfreeWebhook(req, res, next);

    expect(prisma.paymentEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventId: EVENT_ID,
          processed: false
        })
      })
    );
    expect(paymentsService.verifyPayment).toHaveBeenCalledWith(
      ORDER_ID,
      expect.objectContaining({ source: 'WEBHOOK' })
    );
    expect(prisma.paymentEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'pe-uuid-1' },
        data: expect.objectContaining({ processed: true })
      })
    );
    expect(queueService.startPrintingProcess).toHaveBeenCalledWith('JOB001', expect.anything());
  });

  test('2. Sequential duplicate event delivery: returns 200 "Already processed" and skips verify/dispatch', async () => {
    prisma.paymentEvent.findUnique.mockResolvedValue({
      id: 'pe-uuid-1',
      eventId: EVENT_ID,
      processed: true
    });

    const req = mockRequest();
    const res = mockResponse();
    const next = jest.fn();

    await paymentsController.cashfreeWebhook(req, res, next);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.send).toHaveBeenCalledWith('Already processed');
    expect(prisma.paymentEvent.create).not.toHaveBeenCalled();
    expect(paymentsService.verifyPayment).not.toHaveBeenCalled();
    expect(queueService.startPrintingProcess).not.toHaveBeenCalled();
  });

  test('3. Concurrent duplicate delivery race: P2002 on eventId returns 200 "Already processing"', async () => {
    // Worker 2 finds no event in DB initially (raced before Worker 1 committed)
    prisma.paymentEvent.findUnique.mockResolvedValue(null);

    // Worker 2 tries to insert, but Worker 1 already committed: Prisma throws P2002 on eventId
    const p2002Error = new Error('Unique constraint failed on the fields: (`eventId`)');
    p2002Error.code = 'P2002';
    p2002Error.meta = { target: ['eventId'] };
    prisma.paymentEvent.create.mockRejectedValue(p2002Error);

    const req = mockRequest();
    const res = mockResponse();
    const next = jest.fn();

    await paymentsController.cashfreeWebhook(req, res, next);

    // Must return 200 to gateway so it does not retry
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.send).toHaveBeenCalledWith('Already processing');

    // Worker 2 must NOT execute payment verification or print dispatch
    expect(paymentsService.verifyPayment).not.toHaveBeenCalled();
    expect(queueService.startPrintingProcess).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  test('4. P2002 on an UNRELATED unique constraint must log error and return 200 "Error logged"', async () => {
    prisma.paymentEvent.findUnique.mockResolvedValue(null);

    // Unrelated constraint violation (e.g. some other model/field)
    const unrelatedError = new Error('Unique constraint failed on the fields: (`unrelatedField`)');
    unrelatedError.code = 'P2002';
    unrelatedError.meta = { target: ['unrelatedField'] };
    prisma.paymentEvent.create.mockRejectedValue(unrelatedError);

    const req = mockRequest();
    const res = mockResponse();
    const next = jest.fn();

    await paymentsController.cashfreeWebhook(req, res, next);

    // Outer try-catch logs error and sends 200 'Error logged' to gateway
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.send).toHaveBeenCalledWith('Error logged');
    expect(res.send).not.toHaveBeenCalledWith('Already processing');
    expect(paymentsService.verifyPayment).not.toHaveBeenCalled();
  });

  test('5. Non-P2002 database error logs error and returns 200 "Error logged"', async () => {
    prisma.paymentEvent.findUnique.mockResolvedValue(null);

    const connectionError = new Error('Database connection failed');
    connectionError.code = 'P1001';
    prisma.paymentEvent.create.mockRejectedValue(connectionError);

    const req = mockRequest();
    const res = mockResponse();
    const next = jest.fn();

    await paymentsController.cashfreeWebhook(req, res, next);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.send).toHaveBeenCalledWith('Error logged');
    expect(res.send).not.toHaveBeenCalledWith('Already processing');
  });

  test('6. Duplicate event does not trigger print dispatch when wasJustUpdated is false', async () => {
    prisma.paymentEvent.findUnique.mockResolvedValue(null);
    prisma.paymentEvent.create.mockResolvedValue({
      id: 'pe-uuid-1',
      eventId: EVENT_ID,
      processed: false
    });
    // verifyPayment reports wasJustUpdated: false (payment was already transitioned by poll)
    paymentsService.verifyPayment.mockResolvedValue({
      updatedJob: { shortId: 'JOB001', status: 'WAITING' },
      wasJustUpdated: false
    });

    const req = mockRequest();
    const res = mockResponse();
    const next = jest.fn();

    await paymentsController.cashfreeWebhook(req, res, next);

    expect(paymentsService.verifyPayment).toHaveBeenCalled();
    // startPrintingProcess must NOT be called if wasJustUpdated is false
    expect(queueService.startPrintingProcess).not.toHaveBeenCalled();
  });

  test('7. First processing failure does not mark event as processed', async () => {
    prisma.paymentEvent.findUnique.mockResolvedValue(null);
    prisma.paymentEvent.create.mockResolvedValue({
      id: 'pe-uuid-fail',
      eventId: EVENT_ID,
      processed: false
    });

    // verifyPayment fails unexpectedly
    const verifyErr = new Error('Gateway verification API timeout');
    paymentsService.verifyPayment.mockRejectedValue(verifyErr);

    const req = mockRequest();
    const res = mockResponse();
    const next = jest.fn();

    await paymentsController.cashfreeWebhook(req, res, next);

    // Controller handles exception in outer catch, returns 200 'Error logged'
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.send).toHaveBeenCalledWith('Error logged');
    // paymentEvent.update must NOT have been called to mark processed: true
    expect(prisma.paymentEvent.update).not.toHaveBeenCalled();
  });

  test('8. Missing signature header returns 401', async () => {
    const req = mockRequest({}, { 'x-webhook-signature': '' });
    const res = mockResponse();
    const next = jest.fn();

    await paymentsController.cashfreeWebhook(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.send).toHaveBeenCalledWith('Missing signature headers');
    expect(prisma.paymentEvent.findUnique).not.toHaveBeenCalled();
  });

  test('9. Expired timestamp returns 401', async () => {
    // 20 minutes ago (> 900 seconds)
    const oldTimestamp = String(Math.floor(Date.now() / 1000) - 1200);
    const req = mockRequest({}, { 'x-webhook-timestamp': oldTimestamp });
    const res = mockResponse();
    const next = jest.fn();

    await paymentsController.cashfreeWebhook(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.send).toHaveBeenCalledWith('Webhook timestamp expired');
  });

  test('10. Invalid HMAC signature returns 401', async () => {
    cashfreeGateway.verifyWebhookSignature.mockReturnValue(false);

    const req = mockRequest();
    const res = mockResponse();
    const next = jest.fn();

    await paymentsController.cashfreeWebhook(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.send).toHaveBeenCalledWith('Invalid webhook signature');
  });
});
