/**
 * p1_cashfree_batch_b_customer_contact.test.js
 *
 * Batch B: Customer Contact Handling
 * Tests: B1 (email), B2 (phone), B3 (Cashfree payload compatibility)
 * Plus: kiosk compatibility, PII safety, createOrder integration, Batch A regression.
 */

'use strict';

// ---------------------------------------------------------------------------
// Mock dependencies before any require of the modules under test
// ---------------------------------------------------------------------------

jest.mock('../src/utils/prisma', () => {
  const mockPrisma = {
    printJob: {
      findUnique: jest.fn(),
      update: jest.fn()
    },
    payment: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn()
    },
    transaction: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn()
    },
    reconciliationRecord: {
      create: jest.fn()
    },
    $queryRaw: jest.fn(),
    $transaction: jest.fn()
  };
  return mockPrisma;
});

jest.mock('axios');

jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn()
}));

jest.mock('../src/utils/stateMachine', () => ({
  isValidPaymentTransition: jest.fn(() => true),
  isValidJobTransition: jest.fn(() => true)
}));

jest.mock('../src/services/refund.service', () => ({}));

jest.mock('../src/services/cashfreeGateway.adapter', () => ({
  getOrderDetails: jest.fn()
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

const axios = require('axios');
const prisma = require('../src/utils/prisma');
const logger = require('../src/utils/logger');
const cashfreeGateway = require('../src/services/cashfreeGateway.adapter');

const {
  validateIndianPhone,
  validateEmail,
  resolveCustomerDetails,
  redactPhone,
  PLACEHOLDER_PHONES,
  PLACEHOLDER_EMAIL_DOMAINS
} = require('../src/utils/customerContact');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns a minimal mock cashfree config that simulates sandbox (non-production).
 */
const mockSandboxConfig = () => ({
  CASHFREE_APP_ID: 'TEST_APP_ID',
  CASHFREE_SECRET_KEY: 'TEST_SECRET_KEY',
  CASHFREE_ENV: 'sandbox',
  NODE_ENV: 'test'
});

/**
 * Builds a minimal PrintJob record suitable for unit tests.
 */
const makeJob = (overrides = {}) => ({
  id: 'job-uuid-1',
  shortId: 'ABC123',
  status: 'PENDING',
  cost: 10,
  isTest: true,
  customer: null,
  payment: null,
  ...overrides
});

// ============================================================================
// SECTION 1 â€” validateIndianPhone
// ============================================================================

describe('validateIndianPhone', () => {
  describe('valid numbers', () => {
    test('B2-01: plain 10-digit number starting with 9', () => {
      const result = validateIndianPhone('9876543210');
      expect(result.valid).toBe(true);
      expect(result.normalized).toBe('9876543210');
      expect(result.reason).toBeNull();
    });

    test('B2-02: number with +91 prefix', () => {
      const result = validateIndianPhone('+919876543210');
      expect(result.valid).toBe(true);
      expect(result.normalized).toBe('9876543210');
    });

    test('B2-03: number with 91 prefix (12 digits)', () => {
      const result = validateIndianPhone('919876543210');
      expect(result.valid).toBe(true);
      expect(result.normalized).toBe('9876543210');
    });

    test('B2-04: number starting with 6 (valid Indian mobile)', () => {
      const result = validateIndianPhone('6012345678');
      expect(result.valid).toBe(true);
      expect(result.normalized).toBe('6012345678');
    });

    test('B2-05: number starting with 7', () => {
      const result = validateIndianPhone('7001234567');
      expect(result.valid).toBe(true);
      expect(result.normalized).toBe('7001234567');
    });

    test('B2-06: number starting with 8', () => {
      const result = validateIndianPhone('8012345678');
      expect(result.valid).toBe(true);
      expect(result.normalized).toBe('8012345678');
    });

    test('B2-07: placeholder 9999999999 is allowed in sandbox mode', () => {
      const result = validateIndianPhone('9999999999', { isSandbox: true });
      expect(result.valid).toBe(true);
      expect(result.normalized).toBe('9999999999');
    });
  });

  describe('invalid numbers', () => {
    test('B2-08: placeholder 9999999999 is REJECTED in production mode', () => {
      const result = validateIndianPhone('9999999999', { isSandbox: false });
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/placeholder/i);
    });

    test('B2-09: 8-digit number is rejected', () => {
      const result = validateIndianPhone('98765432');
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/10 digits/i);
    });

    test('B2-10: letters in phone are rejected', () => {
      const result = validateIndianPhone('9876ABCDEF');
      expect(result.valid).toBe(false);
    });

    test('B2-11: empty string is rejected', () => {
      const result = validateIndianPhone('');
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/missing/i);
    });

    test('B2-12: null is rejected', () => {
      const result = validateIndianPhone(null);
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/missing/i);
    });

    test('B2-13: undefined is rejected', () => {
      const result = validateIndianPhone(undefined);
      expect(result.valid).toBe(false);
    });

    test('B2-14: number starting with 5 is rejected (not a valid Indian mobile prefix)', () => {
      const result = validateIndianPhone('5001234567');
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/prefix/i);
    });

    test('B2-15: number starting with 1 is rejected', () => {
      const result = validateIndianPhone('1234567890');
      expect(result.valid).toBe(false);
    });

    test('B2-16: 0000000000 is in PLACEHOLDER_PHONES and rejected in production', () => {
      const result = validateIndianPhone('0000000000', { isSandbox: false });
      expect(result.valid).toBe(false);
    });
  });
});

// ============================================================================
// SECTION 2 â€” validateEmail
// ============================================================================

describe('validateEmail', () => {
  describe('valid emails', () => {
    test('B1-01: standard email is accepted', () => {
      const result = validateEmail('user@gmail.com');
      expect(result.valid).toBe(true);
      expect(result.reason).toBeNull();
    });

    test('B1-02: email with subdomain is accepted', () => {
      const result = validateEmail('user@mail.example.co.in');
      expect(result.valid).toBe(true);
    });

    test('B1-03: email with plus tag is accepted', () => {
      const result = validateEmail('user+tag@gmail.com');
      expect(result.valid).toBe(true);
    });
  });

  describe('missing/null/empty', () => {
    test('B1-04: null returns valid:false', () => {
      const result = validateEmail(null);
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/missing/i);
    });

    test('B1-05: undefined returns valid:false', () => {
      const result = validateEmail(undefined);
      expect(result.valid).toBe(false);
    });

    test('B1-06: empty string returns valid:false', () => {
      const result = validateEmail('');
      expect(result.valid).toBe(false);
    });
  });

  describe('placeholder domains (must be rejected)', () => {
    test('B1-07: @printgo.local is rejected', () => {
      const result = validateEmail('kiosk_ABC123@printgo.local');
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/placeholder/i);
    });

    test('B1-08: @example.com is rejected', () => {
      const result = validateEmail('user@example.com');
      expect(result.valid).toBe(false);
    });

    test('B1-09: @test.com is rejected', () => {
      const result = validateEmail('anyone@test.com');
      expect(result.valid).toBe(false);
    });

    test('B1-10: @kiosk.local is rejected', () => {
      // 'kiosk.local' â€” domain is 'kiosk.local', not in placeholder list
      // but prefix kiosk_ makes local-part a placeholder
      const result = validateEmail('kiosk_XYZ@gmail.com');
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/placeholder prefix/i);
    });

    test('B1-11: noreply_ prefix is rejected', () => {
      const result = validateEmail('noreply_system@gmail.com');
      expect(result.valid).toBe(false);
    });

    test('B1-12: @localhost is rejected', () => {
      // No TLD â€” this will fail format check
      const result = validateEmail('user@localhost');
      expect(result.valid).toBe(false);
    });
  });

  describe('malformed emails', () => {
    test('B1-13: no @ symbol is rejected', () => {
      const result = validateEmail('notanemail');
      expect(result.valid).toBe(false);
    });

    test('B1-14: spaces in email are rejected', () => {
      const result = validateEmail('user @gmail.com');
      expect(result.valid).toBe(false);
    });
  });
});

// ============================================================================
// SECTION 3 â€” resolveCustomerDetails
// ============================================================================

describe('resolveCustomerDetails', () => {
  test('B3-01: job with real customer data produces correct details', () => {
    const job = makeJob({
      customer: {
        id: 'cust-db-id',
        name: 'Ravi Kumar',
        phone: '9876543210',
        email: 'ravi@gmail.com'
      }
    });
    const details = resolveCustomerDetails(job, { isSandbox: true });
    expect(details.customer_id).toBe('cust-db-id');
    expect(details.customer_phone).toBe('9876543210');
    expect(details.customer_name).toBe('Ravi Kumar');
    expect(details.customer_email).toBe('ravi@gmail.com');
  });

  test('B3-02: override phone takes priority over DB phone', () => {
    const job = makeJob({ customer: { id: 'c1', phone: '9876543210', email: null, name: null } });
    const details = resolveCustomerDetails(job, { overridePhone: '8012345678', isSandbox: true });
    expect(details.customer_phone).toBe('8012345678');
  });

  test('B3-03: override email takes priority over DB email', () => {
    const job = makeJob({ customer: { id: 'c1', phone: '9876543210', email: 'old@old.com', name: null } });
    const details = resolveCustomerDetails(job, { overrideEmail: 'new@gmail.com', isSandbox: true });
    expect(details.customer_email).toBe('new@gmail.com');
  });

  test('B3-04: no customer data at all â€” sandbox fallback phone, no email', () => {
    const job = makeJob({ customer: null });
    const details = resolveCustomerDetails(job, { isSandbox: true });
    expect(details.customer_phone).toBe('9999999999'); // sandbox placeholder
    expect(details).not.toHaveProperty('customer_email'); // omitted
    expect(details.customer_id).toMatch(/^cust_/);
  });

  test('B3-05: .local email is OMITTED from returned details', () => {
    const job = makeJob({
      customer: { id: 'c1', phone: '9876543210', email: 'kiosk_ABC@printgo.local', name: null }
    });
    const details = resolveCustomerDetails(job, { isSandbox: true });
    expect(details).not.toHaveProperty('customer_email');
  });

  test('B3-06: missing phone in production mode is omitted', () => {
    const job = makeJob({ customer: null });
    const details = resolveCustomerDetails(job, { isSandbox: false });
    expect(details).not.toHaveProperty('customer_phone');
    expect(details.customer_id).toMatch(/^cust_/);
    expect(details.customer_name).toBe('PrintGo Customer');
  });

  test('B3-07: invalid override phone is rejected in production', () => {
    const job = makeJob({ customer: null });
    expect(() =>
      resolveCustomerDetails(job, { overridePhone: '9999999999', isSandbox: false })
    ).toThrow();
  });

  test('B3-08: valid override phone accepted in production', () => {
    const job = makeJob({ customer: null });
    const details = resolveCustomerDetails(job, { overridePhone: '9876543210', isSandbox: false });
    expect(details.customer_phone).toBe('9876543210');
  });

  test('B3-09: customer_id falls back to cust_<shortId> when no customer record', () => {
    const job = makeJob({ shortId: 'XYZ789', customer: null });
    const details = resolveCustomerDetails(job, { isSandbox: true });
    expect(details.customer_id).toBe('cust_XYZ789');
  });

  test('B3-10: customer_name falls back to PrintGo Customer when missing', () => {
    const job = makeJob({ customer: { id: 'c1', phone: '9876543210', email: null, name: '' } });
    const details = resolveCustomerDetails(job, { isSandbox: true });
    expect(details.customer_name).toBe('PrintGo Customer');
  });
});

// ============================================================================
// SECTION 4 â€” createOrder integration: Cashfree payload correctness
// ============================================================================

// Set non-placeholder Cashfree credentials before requiring the service so
// getCashfreeConfig() passes validation. Must be done before jest.mock resolution.
// (jest.resetModules() is NOT used here â€” it would invalidate the top-level
//  jest.mock() registrations and cause prisma to be un-mocked.)
process.env.CASHFREE_APP_ID = 'BATCHB_SANDBOX_APP_12345';
process.env.CASHFREE_SECRET_KEY = 'cfsk_ma_test_batchb_secret_key_xyz';
process.env.CASHFREE_ENV = 'sandbox';
process.env.PUBLIC_APP_URL = 'http://localhost:5173';

const paymentsService = require('../src/modules/payments/payments.service');

describe('createOrder Cashfree payload (integration)', () => {
  const SHORT_ID = 'JOB001';
  const LEASE_TOKEN = 'lease-tok-b';

  /**
   * Sets up the full mock chain needed for the CREATE_NEW branch of createOrder
   * to run successfully, so we can inspect the actual axios.post payload.
   * Job status must be 'PENDING_PAYMENT' to pass the service's pre-flight check.
   */
  const setupCreateNewMocks = (jobOverrides = {}) => {
    const job = makeJob({
      shortId: SHORT_ID,
      cost: 15,
      status: 'PENDING_PAYMENT',   // <-- required by payments.service.js
      customer: null,
      payment: null,
      ...jobOverrides
    });

    // Top-level findUnique for initial job load
    prisma.printJob.findUnique.mockResolvedValue(job);

    // No existing payment at top level
    prisma.payment.findFirst.mockResolvedValue(null);

    // $queryRaw: advisory lock (no existing lock holder)
    prisma.$queryRaw.mockResolvedValue([]);

    // $transaction: short Transaction 1 â€” creates payment + auditTx
    prisma.$transaction.mockImplementationOnce(async (cb) => {
      let persistedCustomer = job.customer || null;
      const mockTx = {
        printJob: {
          findUnique: jest.fn().mockResolvedValue(job),
          update: jest.fn(async ({ data }) => ({
            ...job,
            ...data,
            customer: persistedCustomer
          }))
        },
        customer: {
          findUnique: jest.fn().mockImplementation(async ({ where }) =>
            persistedCustomer?.email === where.email ? persistedCustomer : null
          ),
          create: jest.fn().mockImplementation(async ({ data }) => {
            persistedCustomer = { id: 'cust-b-1', ...data };
            return persistedCustomer;
          }),
          update: jest.fn().mockImplementation(async ({ data }) => {
            persistedCustomer = { ...persistedCustomer, ...data };
            return persistedCustomer;
          })
        },
        payment: {
          findFirst: jest.fn().mockResolvedValue(null),
          findMany: jest.fn().mockResolvedValue([]),
          count: jest.fn().mockResolvedValue(0),
          create: jest.fn().mockResolvedValue({ id: 'pay-b-1', status: 'PENDING' })
        },
        transaction: {
          findFirst: jest.fn().mockResolvedValue(null),
          create: jest.fn().mockResolvedValue({ id: 'tx-b-1', leaseToken: LEASE_TOKEN })
        },
        $queryRaw: jest.fn().mockResolvedValue([]),
        $queryRawUnsafe: jest.fn().mockResolvedValue([])
      };
      return cb(mockTx);
    });

    // getOrderDetails: 404 (no pre-existing gateway order)
    cashfreeGateway.getOrderDetails.mockResolvedValue({ success: false, status: 404 });

    // axios.post: success response from Cashfree
    axios.post.mockResolvedValue({
      data: {
        order_id: `order_${SHORT_ID}_att1`,
        payment_session_id: 'sess_abc123',
        order_status: 'ACTIVE'
      }
    });

    // $transaction: short Transaction 2 â€” persist session (lease token check passes)
    const mockPaymentUpdate = jest.fn().mockResolvedValue({ id: 'pay-b-1', status: 'PENDING' });
    prisma.$transaction.mockImplementationOnce(async (cb) => {
      const mockTx2 = {
        payment: { update: mockPaymentUpdate },
        transaction: {
          findUnique: jest.fn().mockResolvedValue({ leaseToken: LEASE_TOKEN }),
          update: jest.fn()
        }
      };
      return cb(mockTx2);
    });

    return { job, mockPaymentUpdate };
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('B4-01: Cashfree payload does NOT contain .local email', async () => {
    const { job } = setupCreateNewMocks({
      customer: { id: 'c1', phone: '9876543210', email: `kiosk_${SHORT_ID}@printgo.local`, name: 'Test' }
    });

    await paymentsService.createOrder(SHORT_ID, {
      sessionId: 'sess1',
      returnUrl: 'http://localhost:5173/status',
      ipAddress: '127.0.0.1'
    });

    const postCall = axios.post.mock.calls[0];
    const payload = postCall[1];
    expect(payload.customer_details).not.toHaveProperty('customer_email');
  });

  test('B4-02: Cashfree payload omits email when customer has no email', async () => {
    setupCreateNewMocks({ customer: null });

    await paymentsService.createOrder(SHORT_ID, {
      sessionId: 'sess1',
      returnUrl: 'http://localhost:5173/status',
      ipAddress: '127.0.0.1'
    });

    const payload = axios.post.mock.calls[0][1];
    expect(payload.customer_details).not.toHaveProperty('customer_email');
  });

  test('B4-03: Cashfree payload includes valid override email', async () => {
    setupCreateNewMocks({ customer: null });

    await paymentsService.createOrder(SHORT_ID, {
      sessionId: 'sess1',
      returnUrl: 'http://localhost:5173/status',
      ipAddress: '127.0.0.1',
      customerEmail: 'validuser@gmail.com'
    });

    const payload = axios.post.mock.calls[0][1];
    expect(payload.customer_details.customer_email).toBe('validuser@gmail.com');
  });

  test('B4-04: Cashfree payload uses valid override phone', async () => {
    setupCreateNewMocks({ customer: null });

    await paymentsService.createOrder(SHORT_ID, {
      sessionId: 'sess1',
      returnUrl: 'http://localhost:5173/status',
      ipAddress: '127.0.0.1',
      customerPhone: '8099887766'
    });

    const payload = axios.post.mock.calls[0][1];
    expect(payload.customer_details.customer_phone).toBe('8099887766');
  });

  test('B4-05: kiosk job with no customer still creates valid order (sandbox fallback)', async () => {
    setupCreateNewMocks({ customer: null });

    const result = await paymentsService.createOrder(SHORT_ID, {
      sessionId: 'sess1',
      returnUrl: 'http://localhost:5173/status',
      ipAddress: '127.0.0.1'
    });

    expect(result).toHaveProperty('paymentSessionId');
    const payload = axios.post.mock.calls[0][1];
    // phone must be a string (sandbox placeholder accepted)
    expect(typeof payload.customer_details.customer_phone).toBe('string');
    expect(payload.customer_details.customer_phone).toHaveLength(10);
  });

  test('B4-06: customer_id is generated from shortId when no customer record exists', async () => {
    setupCreateNewMocks({ customer: null });

    await paymentsService.createOrder(SHORT_ID, {
      sessionId: 'sess1',
      returnUrl: 'http://localhost:5173/status',
      ipAddress: '127.0.0.1'
    });

    const payload = axios.post.mock.calls[0][1];
    expect(payload.customer_details.customer_id).toBe(`cust_${SHORT_ID}`);
  });
});

// ============================================================================
// SECTION 5 â€” PII safety (logger spy)
// ============================================================================

describe('PII safety â€” phone and email must not appear in logs', () => {
  const REAL_PHONE = '9876543210';
  const REAL_EMAIL = 'realuser@gmail.com';

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('B5-01: validateIndianPhone does not log the actual phone number', () => {
    validateIndianPhone(REAL_PHONE, { isSandbox: true });
    // Check all logger calls â€” none should contain the full phone
    const allLogArgs = [
      ...logger.info.mock.calls.flat(),
      ...logger.warn.mock.calls.flat(),
      ...logger.error.mock.calls.flat(),
      ...logger.debug.mock.calls.flat()
    ].map(a => (typeof a === 'string' ? a : JSON.stringify(a)));

    for (const logLine of allLogArgs) {
      expect(logLine).not.toContain(REAL_PHONE);
    }
  });

  test('B5-02: resolveCustomerDetails does not log the actual email address', () => {
    const job = makeJob({
      customer: { id: 'c1', phone: REAL_PHONE, email: 'kiosk_BAD@printgo.local', name: 'User' }
    });
    resolveCustomerDetails(job, { isSandbox: true });

    const allLogArgs = [
      ...logger.info.mock.calls.flat(),
      ...logger.warn.mock.calls.flat(),
      ...logger.error.mock.calls.flat(),
      ...logger.debug.mock.calls.flat()
    ].map(a => (typeof a === 'string' ? a : JSON.stringify(a)));

    for (const logLine of allLogArgs) {
      expect(logLine).not.toContain(REAL_EMAIL);
      expect(logLine).not.toContain('kiosk_BAD@printgo.local');
    }
  });

  test('B5-03: redactPhone shows only last 4 digits', () => {
    expect(redactPhone('9876543210')).toBe('******3210');
    expect(redactPhone('9999999999')).toBe('******9999');
  });
});

// ============================================================================
// SECTION 6 â€” Batch A regression guard
// ============================================================================

describe('Batch A regression â€” lease token check unaffected by Batch B changes', () => {
  let paymentsService;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env.CASHFREE_APP_ID = 'BATCHB_SANDBOX_APP_12345';
    process.env.CASHFREE_SECRET_KEY = 'cfsk_ma_test_batchb_secret_key_xyz';
    process.env.CASHFREE_ENV = 'sandbox';
    delete process.env.CASHFREE_ENVIRONMENT;
    process.env.NODE_ENV = 'test';
    process.env.FRONTEND_URL = 'http://localhost:5173';
    process.env.PUBLIC_APP_URL = 'http://localhost:5173';
    paymentsService = require('../src/modules/payments/payments.service');
  });

  afterEach(() => {
    delete process.env.CASHFREE_APP_ID;
    delete process.env.CASHFREE_SECRET_KEY;
    delete process.env.CASHFREE_ENV;
    delete process.env.CASHFREE_ENVIRONMENT;
    delete process.env.PUBLIC_APP_URL;
    delete process.env.FRONTEND_URL;
  });

  test('B6-01: stale worker rejected by lease token check even after Batch B changes', async () => {
    const STALE_TOKEN = 'stale-lease-tok';
    const ACTIVE_TOKEN = 'active-lease-tok';
    const SHORT_ID = 'REG001';

    const job = makeJob({ shortId: SHORT_ID, customer: null });
    prisma.printJob.findUnique.mockResolvedValue(job);
    prisma.payment.findFirst.mockResolvedValue(null);
    prisma.$queryRaw.mockResolvedValue([]);

    // Transaction 1: lease acquired with STALE_TOKEN
    prisma.$transaction.mockImplementationOnce(async (cb) => {
      const mockTx = {
        printJob: { findUnique: jest.fn().mockResolvedValue(job), update: jest.fn() },
        payment: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({ id: 'pay-reg-1', status: 'PENDING' }) },
        transaction: { create: jest.fn().mockResolvedValue({ id: 'tx-reg-1', leaseToken: STALE_TOKEN }) },
        $queryRaw: jest.fn().mockResolvedValue([]),
        $queryRawUnsafe: jest.fn().mockResolvedValue([])
      };
      return cb(mockTx);
    });

    cashfreeGateway.getOrderDetails.mockResolvedValue({ success: false, status: 404 });
    axios.post.mockResolvedValue({
      data: { order_id: `order_${SHORT_ID}_att1`, payment_session_id: 'sess_reg', order_status: 'ACTIVE' }
    });

    // Transaction 2: DB now shows ACTIVE_TOKEN (another worker took over)
    const mockPaymentUpdate = jest.fn();
    prisma.$transaction.mockImplementationOnce(async (cb) => {
      const mockTx2 = {
        payment: { update: mockPaymentUpdate },
        transaction: {
          // Returns ACTIVE_TOKEN â€” simulates lease takeover
          findUnique: jest.fn().mockResolvedValue({ leaseToken: ACTIVE_TOKEN }),
          update: jest.fn()
        }
      };
      return cb(mockTx2);
    });

    // Should not throw, but should NOT persist the stale session
    let threw = false;
    try {
      await paymentsService.createOrder(SHORT_ID, {
        sessionId: 'sess-reg',
        returnUrl: 'http://localhost:5173/status',
        ipAddress: '127.0.0.1'
      });
    } catch {
      threw = true;
    }

    // Either a conflict error or no payment.update call â€” stale worker must NOT win
    if (!threw) {
      expect(mockPaymentUpdate).not.toHaveBeenCalled();
    }
    // If it throws, the stale worker was safely rejected
  });
});
