/**
 * Automated Test Suite: Batch A — Cashfree Order Idempotency, Concurrency & Recovery
 *
 * Verifies that:
 * A1. Reuses existing active Cashfree order within TTL without creating a 2nd gateway order.
 * A2.1. Stale order (>15m) confirmed EXPIRED at gateway marks old FAILED and creates new attempt.
 * A2.2. Stale order confirmed PAID at gateway triggers capture pipeline and throws 409.
 * A3. Three concurrent createOrder requests serialize and return identical session.
 * A4. Rejects order creation with 409 Conflict if job already has a SUCCESS payment.
 * A5. Crash recovery: Recovers session from Cashfree if worker died before saving session ID.
 * A6. Ambiguous timeout recovery: Reconciles order via GET when POST times out.
 */

const axios = require('axios');
const prisma = require('../src/utils/prisma');
const paymentsService = require('../src/modules/payments/payments.service');
const cashfreeGateway = require('../src/services/cashfreeGateway.adapter');
const { getCashfreeConfig } = require('../src/config/cashfree.config');

// Setup Prisma in-memory mocks
jest.mock('../src/utils/prisma', () => {
  return {
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
    customer: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({
        id: 'cust-mock-1',
        phone: '9876543210',
        email: 'test@printgo.in'
      }),
      update: jest.fn().mockResolvedValue({
        id: 'cust-mock-1',
        phone: '9876543210',
        email: 'test@printgo.in'
      })
    },
    $queryRawUnsafe: jest.fn().mockResolvedValue([]),
    $transaction: jest.fn()
  };
});

describe('Batch A: Cashfree Order Idempotency, Concurrency & Recovery', () => {
  const mockJob = {
    id: 'job-uuid-123',
    shortId: 'JOB123',
    status: 'PENDING_PAYMENT',
    cost: 25.0,
    machineId: 'machine-1',
    customer: { id: 'cust-1', name: 'Test Customer', phone: '9876543210', email: 'test@printgo.in' }
  };

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.payment.findMany.mockReset().mockResolvedValue([]);
    prisma.payment.updateMany.mockResolvedValue({ count: 1 });
    prisma.transaction.update.mockResolvedValue({ id: 'tx-mock' });
    process.env.CASHFREE_APP_ID = 'MOCK_SANDBOX_APP_12345';
    process.env.CASHFREE_SECRET_KEY = 'cfsk_ma_test_batchA_secret_key';
    process.env.CASHFREE_ENV = 'sandbox';
    delete process.env.CASHFREE_ENVIRONMENT;
    process.env.FRONTEND_URL = 'https://pilot.printgo.local';
    process.env.PUBLIC_APP_URL = 'https://pilot.printgo.local';

    // Default $transaction execution mock
    prisma.$transaction.mockImplementation(async (callback) => {
      if (typeof callback === 'function') {
        return await callback(prisma);
      }
      return callback;
    });
  });

  afterEach(() => {
    cashfreeGateway.setMockMode(false);
  });

  // -------------------------------------------------------------------------
  // TEST A1: Active Pending Order Reuse
  // -------------------------------------------------------------------------
  test('A1: Reuses existing active Cashfree order within TTL without 2nd gateway call', async () => {
    prisma.printJob.findUnique.mockResolvedValue(mockJob);
    prisma.payment.findFirst.mockResolvedValue(null); // No successful payment

    // First call: no existing payment
    prisma.payment.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        id: 'pay-1',
        gatewayOrderId: 'order_JOB123_att1',
        gatewaySessionId: 'session_active_123',
        status: 'PENDING',
        createdAt: new Date()
      }
    ]);
    prisma.payment.count.mockResolvedValue(0);
    prisma.printJob.update.mockResolvedValue({
      ...mockJob,
      paymentId: 'pay-1',
      customerId: mockJob.customer.id,
      customer: mockJob.customer,
      payment: {
        id: 'pay-1',
        gatewayOrderId: 'order_JOB123_att1',
        status: 'PENDING'
      }
    });    prisma.payment.create.mockResolvedValue({
      id: 'pay-1',
      gatewayOrderId: 'order_JOB123_att1',
      status: 'PENDING'
    });
    prisma.transaction.create.mockResolvedValue({ id: 'tx-1' });

    const origPost = axios.post;
    let postCalls = 0;
    axios.post = jest.fn().mockImplementation(async () => {
      postCalls++;
      return {
        data: {
          order_id: 'order_JOB123_att1',
          payment_session_id: 'session_active_123',
          order_status: 'ACTIVE'
        }
      };
    });

    try {
      // First invocation
      const res1 = await paymentsService.createOrder('JOB123');
      expect(res1.paymentSessionId).toBe('session_active_123');

      // Second invocation (simulate existing active payment found in DB)
      prisma.payment.findMany.mockResolvedValue([
        {
          id: 'pay-1',
          gatewayOrderId: 'order_JOB123_att1',
          gatewaySessionId: 'session_active_123',
          status: 'PENDING',
          createdAt: new Date() // Just created
        }
      ]);
      prisma.transaction.findFirst.mockResolvedValue({
        id: 'tx-1',
        gatewayResponse: JSON.stringify({
          leaseToken: 'token-1',
          leaseExpiresAt: new Date(Date.now() + 20000).toISOString()
        })
      });

      const res2 = await paymentsService.createOrder('JOB123');
      expect(res2.paymentSessionId).toBe('session_active_123');
      expect(res2.orderId).toBe('order_JOB123_att1');
      // axios.post must have been called exactly ONCE
      expect(postCalls).toBe(1);
    } finally {
      axios.post = origPost;
    }
  });

  // -------------------------------------------------------------------------
  // TEST A2.1: Stale Order Expired at Gateway -> Mints Fresh Attempt
  // -------------------------------------------------------------------------
  test('A2.1: Stale order (>15m) confirmed EXPIRED at gateway marks old FAILED and creates new attempt', async () => {
    prisma.printJob.findUnique.mockResolvedValue(mockJob);
    prisma.payment.findFirst.mockResolvedValue(null);

    const twentyMinAgo = new Date(Date.now() - 20 * 60 * 1000);
    const stalePayment = {
      id: 'pay-stale',
      gatewayOrderId: 'order_JOB123_att1',
      gatewaySessionId: 'session_stale_1',
      status: 'PENDING',
      createdAt: twentyMinAgo
    };

    // First call finds stale payment
    prisma.payment.findMany
      .mockResolvedValueOnce([stalePayment]) // first check in createOrder
      .mockResolvedValueOnce([]); // recursive check when minting att2

    prisma.transaction.findFirst.mockResolvedValue({
      id: 'tx-stale',
      status: 'SUCCESS'
    });

    cashfreeGateway.setMockMode(true, {
      getOrderDetails: jest.fn().mockResolvedValue({
        success: true,
        orderId: 'order_JOB123_att1',
        order_status: 'EXPIRED'
      })
    });

    prisma.payment.count.mockResolvedValue(1);
    prisma.printJob.update.mockResolvedValue({
      ...mockJob,
      paymentId: 'pay-att2',
      customerId: mockJob.customer.id,
      customer: mockJob.customer,
      payment: {
        id: 'pay-att2',
        gatewayOrderId: 'order_JOB123_att2',
        status: 'PENDING'
      }
    });
    prisma.payment.create.mockResolvedValue({
      id: 'pay-att2',
      gatewayOrderId: 'order_JOB123_att2',
      status: 'PENDING'
    });
    prisma.transaction.create.mockResolvedValue({ id: 'tx-2' });

    const origPost = axios.post;
    axios.post = jest.fn().mockResolvedValue({
      data: {
        order_id: 'order_JOB123_att2',
        payment_session_id: 'session_fresh_2',
        order_status: 'ACTIVE'
      }
    });

    try {
      const res = await paymentsService.createOrder('JOB123');
      expect(res.orderId).toBe('order_JOB123_att2');
      expect(res.paymentSessionId).toBe('session_fresh_2');
      expect(prisma.payment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'pay-stale' },
          data: { status: 'FAILED' }
        })
      );
    } finally {
      axios.post = origPost;
    }
  });

  // -------------------------------------------------------------------------
  // TEST A2.2: Stale Order Already Paid at Gateway -> Captures and Throws 409
  // -------------------------------------------------------------------------
  test('A2.2: Stale order confirmed PAID at gateway triggers capture and throws 409', async () => {
    prisma.printJob.findUnique.mockResolvedValue(mockJob);
    prisma.payment.findFirst.mockResolvedValue(null);

    const twentyMinAgo = new Date(Date.now() - 20 * 60 * 1000);
    const stalePayment = {
      id: 'pay-stale',
      gatewayOrderId: 'order_JOB123_att1',
      gatewaySessionId: 'session_paid_old',
      status: 'PENDING',
      amount: 25.0,
      createdAt: twentyMinAgo
    };

    prisma.payment.findMany.mockResolvedValue([stalePayment]);
    prisma.payment.findUnique.mockResolvedValue(stalePayment);
    prisma.transaction.findFirst.mockResolvedValue({ id: 'tx-stale' });

    cashfreeGateway.setMockMode(true, {
      getOrderDetails: jest.fn().mockResolvedValue({
        success: true,
        orderId: 'order_JOB123_att1',
        order_status: 'PAID',
        order_amount: 25.0
      })
    });

    const origGet = axios.get;
    axios.get = jest.fn().mockImplementation(async (url) => {
      if (url.includes('/orders/order_JOB123_att1')) {
        return {
          data: {
            order_id: 'order_JOB123_att1',
            order_amount: 25.0,
            order_status: 'PAID'
          }
        };
      }
      if (url.includes('/payments')) {
        return { data: [{ cf_payment_id: 9999, payment_status: 'SUCCESS' }] };
      }
      throw new Error(`Unexpected axios.get URL in test: ${url}`);
    });

    try {
      await expect(paymentsService.createOrder('JOB123')).rejects.toThrow(
        'A successful payment already exists for this job'
      );
    } finally {
      axios.get = origGet;
    }
  });

  // -------------------------------------------------------------------------
  // TEST A3: Concurrent createOrder Requests Serialize Cleanly
  // -------------------------------------------------------------------------
  test('A3: Three concurrent createOrder requests serialize and return identical session', async () => {
    prisma.printJob.findUnique.mockResolvedValue(mockJob);
    prisma.payment.findFirst.mockResolvedValue(null);

    let activeDbPayment = null;
    let activeAuditTx = null;
    let postGatewayCalls = 0;

    // Mutex to simulate database lock serialization across concurrent transaction blocks
    let txMutex = Promise.resolve();
    prisma.$transaction.mockImplementation(async (callback) => {
      const release = txMutex;
      let nextResolve;
      txMutex = new Promise((resolve) => { nextResolve = resolve; });
      await release;

      try {
        return await callback({
          ...prisma,
          $executeRawUnsafe: jest.fn().mockResolvedValue(1),
          printJob: {
            findUnique: jest.fn().mockResolvedValue(mockJob),
            update: jest.fn().mockImplementation(async () => ({
              ...mockJob,
              paymentId: activeDbPayment?.id || 'pay-concurrent',
              customerId: mockJob.customerId || null,
              payment: activeDbPayment
            }))
          },
          payment: {
            findFirst: jest.fn().mockResolvedValue(null),
            findMany: jest.fn().mockImplementation(async () => {
              return activeDbPayment ? [activeDbPayment] : [];
            }),
            count: jest.fn().mockResolvedValue(0),
            create: jest.fn().mockImplementation(async (args) => {
              activeDbPayment = {
                id: 'pay-concurrent',
                gatewayOrderId: args.data.gatewayOrderId,
                status: 'PENDING',
                gatewaySessionId: null,
                createdAt: new Date()
              };
              return activeDbPayment;
            }),
            update: jest.fn().mockImplementation(async (args) => {
              if (activeDbPayment && activeDbPayment.id === args.where.id) {
                activeDbPayment.gatewaySessionId = args.data.gatewaySessionId;
              }
              return activeDbPayment;
            })
          },
          transaction: {
            findFirst: jest.fn().mockImplementation(async () => activeAuditTx),
            findUnique: jest.fn().mockImplementation(async () => activeAuditTx),
            create: jest.fn().mockImplementation(async (args) => {
              activeAuditTx = {
                id: 'tx-concurrent',
                paymentId: args.data.paymentId,
                status: 'PENDING',
                gatewayResponse: args.data.gatewayResponse
              };
              return activeAuditTx;
            }),
            update: jest.fn()
          }
        });
      } finally {
        nextResolve();
      }
    });

    // Mock prisma.payment.findUnique for the polling loop in IN_FLIGHT_WAIT
    prisma.payment.findUnique.mockImplementation(async () => activeDbPayment);

    const origPost = axios.post;
    axios.post = jest.fn().mockImplementation(async (url, data) => {
      postGatewayCalls++;
      // Simulate network roundtrip
      await new Promise((r) => setTimeout(r, 60));
      return {
        data: {
          order_id: data.order_id,
          payment_session_id: 'session_concurrent_123',
          order_status: 'ACTIVE'
        }
      };
    });

    try {
      const results = await Promise.all([
        paymentsService.createOrder('JOB123'),
        paymentsService.createOrder('JOB123'),
        paymentsService.createOrder('JOB123')
      ]);

      expect(postGatewayCalls).toBe(1);
      expect(results[0].paymentSessionId).toBe('session_concurrent_123');
      expect(results[1].paymentSessionId).toBe('session_concurrent_123');
      expect(results[2].paymentSessionId).toBe('session_concurrent_123');
    } finally {
      axios.post = origPost;
    }
  });

  // -------------------------------------------------------------------------
  // TEST A4: Block Order Creation on SUCCESS Payment
  // -------------------------------------------------------------------------
  test('A4: Rejects order creation with 409 Conflict if job already has a SUCCESS payment', async () => {
    prisma.printJob.findUnique.mockResolvedValue({
      ...mockJob,
      payment: { id: 'pay-success', status: 'SUCCESS' }
    });
    prisma.payment.findFirst.mockResolvedValue({ id: 'pay-success', status: 'SUCCESS' });

    await expect(paymentsService.createOrder('JOB123')).rejects.toThrow(
      'A successful payment already exists for this job'
    );
  });

  // -------------------------------------------------------------------------
  // TEST CRASH RECOVERY: Worker dies before saving payment_session_id
  // -------------------------------------------------------------------------
  test('Crash Recovery: Recovers session from Cashfree if worker died before saving session ID', async () => {
    prisma.printJob.findUnique.mockResolvedValue(mockJob);
    prisma.payment.findFirst.mockResolvedValue(null);

    // Stale attempt with null session ID and expired lease
    const crashedPayment = {
      id: 'pay-crashed',
      gatewayOrderId: 'order_JOB123_att1',
      gatewaySessionId: null, // died before saving!
      status: 'PENDING',
      createdAt: new Date(Date.now() - 40000)
    };

    prisma.payment.findMany.mockResolvedValue([crashedPayment]);
    prisma.transaction.findFirst.mockResolvedValue({
      id: 'tx-crashed',
      status: 'PENDING',
      gatewayResponse: JSON.stringify({
        leaseToken: 'old-token',
        leaseExpiresAt: new Date(Date.now() - 10000).toISOString() // Expired lease
      })
    });

    cashfreeGateway.setMockMode(true, {
      getOrderDetails: jest.fn().mockResolvedValue({
        success: true,
        orderId: 'order_JOB123_att1',
        order_status: 'ACTIVE',
        payment_session_id: 'session_recovered_123'
      })
    });

    const res = await paymentsService.createOrder('JOB123');
    expect(res.paymentSessionId).toBe('session_recovered_123');
    expect(res.orderId).toBe('order_JOB123_att1');
    expect(prisma.payment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'pay-crashed' },
        data: { gatewaySessionId: 'session_recovered_123' }
      })
    );
  });

  // -------------------------------------------------------------------------
  // TEST AMBIGUOUS TIMEOUT RECOVERY: Network timeout on POST recovers via GET
  // -------------------------------------------------------------------------
  test('Ambiguous Timeout Recovery: Reconciles order via GET when POST times out', async () => {
    prisma.printJob.findUnique.mockResolvedValue(mockJob);
    prisma.printJob.update.mockResolvedValue({
      ...mockJob,
      paymentId: 'pay-timeout',
      customerId: mockJob.customer?.id || null
    });
    prisma.payment.findFirst.mockResolvedValue(null);
    prisma.payment.findMany.mockResolvedValue([]);
    prisma.payment.count.mockResolvedValue(0);
    prisma.payment.create.mockResolvedValue({
      id: 'pay-timeout',
      gatewayOrderId: 'order_JOB123_att1',
      status: 'PENDING'
    });
    prisma.transaction.create.mockResolvedValue({ id: 'tx-timeout' });

    const origPost = axios.post;
    axios.post = jest.fn().mockImplementation(async () => {
      const err = new Error('connect ECONNABORTED timeout');
      err.code = 'ECONNABORTED';
      throw err;
    });

    cashfreeGateway.setMockMode(true, {
      getOrderDetails: jest.fn().mockResolvedValue({
        success: true,
        orderId: 'order_JOB123_att1',
        order_status: 'ACTIVE',
        payment_session_id: 'session_reconciled_after_timeout'
      })
    });

    try {
      const res = await paymentsService.createOrder('JOB123');
      expect(res.paymentSessionId).toBe('session_reconciled_after_timeout');
    } finally {
      axios.post = origPost;
    }
  });

  // -------------------------------------------------------------------------
  // TARGETED REV-A-01 TESTS: Lease Ownership & Stale Worker Rejection
  // -------------------------------------------------------------------------
  test('REV-A-01: Stale Worker A whose lease was taken over by Worker B cannot overwrite Worker B session', async () => {
    prisma.printJob.findUnique.mockResolvedValue(mockJob);
    prisma.payment.findFirst.mockResolvedValue(null);
    prisma.payment.findMany.mockResolvedValue([]);
    prisma.payment.count.mockResolvedValue(0);

    const stalePayment = {
      id: 'pay-takeover',
      gatewayOrderId: 'order_JOB123_att1',
      status: 'PENDING',
      gatewaySessionId: null
    };
    prisma.payment.create.mockResolvedValue(stalePayment);
    prisma.transaction.create.mockResolvedValue({ id: 'tx-takeover' });

    // Mock Cashfree post returning a session for Worker A
    const origPost = axios.post;
    axios.post = jest.fn().mockResolvedValue({
      data: {
        order_id: 'order_JOB123_att1',
        payment_session_id: 'session_from_stale_worker_A',
        order_status: 'ACTIVE'
      }
    });

    // Simulate Worker B taking over the lease during Worker A's Cashfree network I/O
    prisma.$transaction.mockImplementation(async (callback) => {
      return await callback({
        ...prisma,
        $executeRawUnsafe: jest.fn().mockResolvedValue(1),
        printJob: {
          findUnique: jest.fn().mockResolvedValue(mockJob),
          update: jest.fn().mockResolvedValue({
            ...mockJob,
            paymentId: stalePayment.id,
            customerId: mockJob.customerId || null,
            payment: stalePayment
          })
        },
        payment: {
          findMany: jest.fn().mockResolvedValue([]),
          count: jest.fn().mockResolvedValue(0),
          create: jest.fn().mockResolvedValue(stalePayment),
          findUnique: jest.fn().mockResolvedValue({
            ...stalePayment,
            gatewaySessionId: 'session_persisted_by_newer_worker_B' // Worker B already succeeded!
          }),
          update: jest.fn()
        },
        transaction: {
          create: jest.fn().mockResolvedValue({ id: 'tx-takeover' }),
          findUnique: jest.fn().mockResolvedValue({
            id: 'tx-takeover',
            // Lease token was replaced by Worker B!
            gatewayResponse: JSON.stringify({
              leaseToken: 'newer-worker-B-token',
              leaseExpiresAt: new Date(Date.now() + 30000).toISOString()
            })
          }),
          update: jest.fn()
        }
      });
    });

    try {
      // Worker A attempts to create and commit
      const res = await paymentsService.createOrder('JOB123');

      // Worker A must yield to Worker B's session and NOT overwrite it with session_from_stale_worker_A
      expect(res.paymentSessionId).toBe('session_persisted_by_newer_worker_B');
      expect(prisma.payment.update).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            gatewaySessionId: 'session_from_stale_worker_A'
          })
        })
      );
    } finally {
      axios.post = origPost;
    }
  });

  test('REV-A-01: Normal active lease owner with matching leaseToken commits successfully', async () => {
    prisma.printJob.findUnique.mockResolvedValue(mockJob);
    prisma.payment.findFirst.mockResolvedValue(null);
    prisma.payment.findMany.mockResolvedValue([]);
    prisma.payment.count.mockResolvedValue(0);

    const normalPayment = {
      id: 'pay-normal',
      gatewayOrderId: 'order_JOB123_att1',
      status: 'PENDING',
      gatewaySessionId: null
    };
    prisma.payment.create.mockResolvedValue(normalPayment);
    prisma.transaction.create.mockResolvedValue({ id: 'tx-normal' });

    let savedLeaseToken = null;

    const mockPaymentUpdate = jest.fn().mockResolvedValue({
      ...normalPayment,
      gatewaySessionId: 'session_normal_valid'
    });

    prisma.$transaction.mockImplementation(async (callback) => {
      return await callback({
        ...prisma,
        $executeRawUnsafe: jest.fn().mockResolvedValue(1),
        printJob: {
          findUnique: jest.fn().mockResolvedValue(mockJob),
          update: jest.fn().mockResolvedValue({
            ...mockJob,
            paymentId: normalPayment.id,
            customerId: mockJob.customerId || null,
            payment: normalPayment
          })
        },
        payment: {
          findMany: jest.fn().mockResolvedValue([]),
          count: jest.fn().mockResolvedValue(0),
          create: jest.fn().mockResolvedValue(normalPayment),
          update: mockPaymentUpdate
        },
        transaction: {
          create: jest.fn().mockImplementation(async (args) => {
            const meta = JSON.parse(args.data.gatewayResponse);
            savedLeaseToken = meta.leaseToken;
            return { id: 'tx-normal' };
          }),
          findUnique: jest.fn().mockImplementation(async () => ({
            id: 'tx-normal',
            gatewayResponse: JSON.stringify({
              leaseToken: savedLeaseToken,
              leaseExpiresAt: new Date(Date.now() + 30000).toISOString()
            })
          })),
          update: jest.fn()
        }
      });
    });

    const origPost = axios.post;
    axios.post = jest.fn().mockResolvedValue({
      data: {
        order_id: 'order_JOB123_att1',
        payment_session_id: 'session_normal_valid',
        order_status: 'ACTIVE'
      }
    });

    try {
      const res = await paymentsService.createOrder('JOB123');
      expect(res.paymentSessionId).toBe('session_normal_valid');
      expect(mockPaymentUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'pay-normal' },
          data: expect.objectContaining({
            gatewaySessionId: 'session_normal_valid'
          })
        })
      );
    } finally {
      axios.post = origPost;
    }
  });
});
