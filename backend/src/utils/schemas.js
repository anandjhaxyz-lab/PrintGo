const { z } = require('zod');

// Auth Schemas
const loginSchema = z.object({
  body: z.object({
    email: z.string().email(),
    password: z.string().min(6),
  }).strict(),
  query: z.any(),
  params: z.any(),
});

const activateSchema = z.object({
  body: z.object({
    token: z.string().min(1, 'Token is required'),
    password: z.string().min(6, 'Password must be at least 6 characters'),
  }).strict(),
  query: z.any(),
  params: z.any(),
});

const sessionSchema = z.object({
  body: z.object({
    sessionCode: z.string().min(1).optional(),
    machineId: z.string().uuid().optional(),
  }).strict(),
  query: z.any(),
  params: z.any(),
});

// Jobs Schemas
const createJobSchema = z.object({
  body: z.object({
    file: z.object({
      originalName: z.string(),
      filename: z.string(),
      mimetype: z.string(),
      size: z.number().int().positive(),
      pages: z.number().int().positive().optional(),
    }),
    settings: z.object({
      color: z.enum(['bw', 'color']).default('bw'),
      duplex: z.enum(['single', 'double']).default('single'),
      copies: z.number().int().min(1).max(100).default(1),
      pageRangeType: z.enum(['all', 'custom']).default('all'),
      customRange: z.string().nullable().optional(),
      paperSize: z.string().optional().default('A4'),
      paperType: z.string().optional().default('plain'),
      pagesToPrint: z.number().int().min(1).default(1),
    }).refine(data => {
      if (data.pageRangeType === 'custom') {
        return !!data.customRange && /^[0-9,-]+$/.test(data.customRange);
      }
      return true;
    }, {
      message: "Invalid custom range format",
      path: ["customRange"],
    }),
    encryptedKey: z.string().nullable().optional(),
    iv: z.string().nullable().optional(),
  }).strict(),
  query: z.any(),
  params: z.any(),
});

const updateJobStatusSchema = z.object({
  body: z.object({
    status: z.enum(['PENDING_PAYMENT', 'WAITING', 'PRINTING', 'COMPLETED', 'FAILED', 'CANCELLED']),
    reason: z.string().optional(),
    evidence: z.string().optional(),
    physicalConfirmation: z.boolean().optional(),
    physicalVerificationConfirmed: z.boolean().optional(),
    spoolerEmptyOnly: z.boolean().optional(),
  }).strip(),
  query: z.any(),
  params: z.object({
    id: z.string(),
  }).strip(),
});

const resolveAmbiguitySchema = z.object({
  body: z.object({
    outcome: z.enum(['COMPLETED', 'FAILED']),
    reason: z.string().optional(),
    evidence: z.string().optional(),
    physicalConfirmation: z.boolean().optional(),
    physicalVerificationConfirmed: z.boolean().optional(),
    spoolerEmptyOnly: z.boolean().optional(),
  }).strip(),
  query: z.any(),
  params: z.object({
    id: z.string(),
  }).strip(),
});

// Machines Schemas
const createMachineSchema = z.object({
  body: z.object({
    name: z.string().min(1),
    location: z.string().min(1),
    type: z.enum(['KIOSK', 'COUNTER']).default('KIOSK'),
    companyId: z.string().uuid().optional(),
    printerModel: z.string().optional(),
    connectionType: z.string().optional(),
    paymentMode: z.enum(['CASH_AT_COUNTER', 'DEMO_SIMULATION', 'CASHFREE_ONLINE']).optional(),
  }).strip(),
  query: z.any(),
  params: z.any(),
});

const updateMachineSchema = z.object({
  body: z.object({
    name: z.string().optional(),
    location: z.string().optional(),
    status: z.enum(['ACTIVE', 'INACTIVE', 'SUSPENDED']).optional(),
    printerModel: z.string().optional(),
    connectionType: z.string().optional(),
    paymentMode: z.enum(['CASH_AT_COUNTER', 'DEMO_SIMULATION', 'CASHFREE_ONLINE']).optional(),
  }).strip(),
  query: z.any(),
  params: z.object({
    id: z.string(),
  }).strip(),
});

// Companies Schemas
const createCompanySchema = z.object({
  body: z.object({
    name: z.string().min(1),
    contactPerson: z.string().min(1).optional(),
    email: z.string().email(),
    phone: z.string().min(1).optional(),
  }).strip(),
  query: z.any(),
  params: z.any(),
});

// Subscriptions Schemas
const createSubscriptionSchema = z.object({
  body: z.object({
    machineId: z.string().uuid(),
    planId: z.string().uuid(),
    billingType: z.enum(['MONTHLY', 'YEARLY', 'LIFETIME']),
  }).strip(),
  query: z.any(),
  params: z.any(),
});

const cancelSubscriptionSchema = z.object({
  body: z.any(),
  query: z.any(),
  params: z.object({
    id: z.string().uuid(),
  }).strip(),
});

// Users Schemas
const updateUserSchema = z.object({
  body: z.object({
    name: z.string().min(1).optional(),
    role: z.enum(['SUPERADMIN', 'FRANCHISEE', 'STAFF']).optional(),
    isActive: z.boolean().optional(),
    companyId: z.string().uuid().nullable().optional(),
  }).strict(),
  query: z.any(),
  params: z.object({
    id: z.string().uuid(),
  }).strip(),
});

const toggleUserActiveSchema = z.object({
  body: z.object({
    isActive: z.boolean(),
  }).strict(),
  query: z.any(),
  params: z.object({
    id: z.string().uuid(),
  }).strip(),
});

const deleteUserSchema = z.object({
  body: z.any(),
  query: z.any(),
  params: z.object({
    id: z.string().uuid(),
  }).strip(),
});

module.exports = {
  loginSchema,
  activateSchema,
  sessionSchema,
  createJobSchema,
  updateJobStatusSchema,
  resolveAmbiguitySchema,
  createMachineSchema,
  updateMachineSchema,
  createCompanySchema,
  createSubscriptionSchema,
  cancelSubscriptionSchema,
  updateUserSchema,
  toggleUserActiveSchema,
  deleteUserSchema,
};
