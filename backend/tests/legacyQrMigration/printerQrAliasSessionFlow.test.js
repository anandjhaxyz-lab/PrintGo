jest.mock('../../src/utils/prisma', () => ({
  $transaction: jest.fn(),
  printerQr: { findUnique: jest.fn() },
  legacyPrinterQrBinding: { findUnique: jest.fn() }
}));
jest.mock('../../src/services/pricing.service', () => ({
  getPricingProfile: jest.fn(async () => ({})),
  serializePublicPricingProfile: jest.fn(() => ({ currency: 'INR' }))
}));
jest.mock('../../src/config/cashfree.config', () => ({ resolveCashfreeEnv: jest.fn(() => ({ env: 'sandbox' })) }));
jest.mock('../../src/utils/demoPaymentGuard', () => ({
  isDemoPaymentPermitted: jest.fn(() => false),
  isDemoAccessCodeRequired: jest.fn(() => false)
}));
jest.mock('../../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../../src/services/printerAvailability.service', () => ({
  getMachineAvailability: jest.fn(),
  getPrinterDeviceAvailability: jest.fn(async (_machineId, printerDeviceId) => ({
    printerDeviceId, isReady: true, status: 'ONLINE', statusMessage: 'Printer Ready',
    agentOnline: true, paperStatus: 'OK', tonerStatus: 'OK', jamStatus: false,
    name: 'Shop', location: 'Noida', printerModel: 'Epson L6460'
  }))
}));
const prisma = require('../../src/utils/prisma');
const availability = require('../../src/services/printerAvailability.service');
const { resolvePrinterQr, getPublicPrinterQrInfo } = require('../../src/services/printerQr.service');
const { validateLegacyQrAlias } = require('../../src/services/legacyPrinterQrBinding.service');

const binding = { id:'b1', printerQrId:'q1', machineId:'m1', printerDeviceId:'d1', status:'ACTIVE', approvedAt:new Date(), approvedBy:'root-1' };
const device = { id:'d1', machineId:'m1', displayName:'Counter Epson', printerModel:'Epson L6460', windowsPrinterName:'EPSON L6460 Series', status:'ACTIVE', approvedAt:new Date(), isDefault:false, healthStatus:'UNKNOWN', lastTelemetryAt:new Date() };
const placeholder = { id:'legacy-placeholder', machineId:'m1', status:'DISCOVERY_REQUIRED', approvedAt:null, windowsPrinterName:null, isDefault:true };
const lockedQr = {
  id:'q1', publicCode:'fixture-only-code', status:'ACTIVE', label:'Counter',
  machineId:'m1', printerDeviceId:null, machine_id:'m1', machine_name:'Shop',
  machine_printer_model:'Generic', machine_location:'Noida', machine_status:'ACTIVE',
  machine_payment_mode:'DEMO_SIMULATION'
};
const placeholderLockedQr = {
  ...lockedQr, printerDeviceId:placeholder.id, printer_device_id:placeholder.id,
  printer_device_machine_id:'m1', printer_device_display_name:'Main Shop Printer - Primary Printer (pending discovery)',
  printer_device_model:'Epson L6460 Series', printer_device_windows_printer_name:null,
  printer_device_status:'DISCOVERY_REQUIRED', printer_device_approved_at:null, printer_device_is_default:true
};

describe('legacy alias customer session and public metadata flow (mocked Prisma)', () => {
  const oldFlag = process.env.ENABLE_MULTI_PRINTER_DISPATCH;
  const oldSecret = process.env.JWT_SECRET;
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ENABLE_MULTI_PRINTER_DISPATCH = 'true';
    process.env.JWT_SECRET = 'isolated-test-secret';
  });
  afterAll(() => {
    if (oldFlag === undefined) delete process.env.ENABLE_MULTI_PRINTER_DISPATCH; else process.env.ENABLE_MULTI_PRINTER_DISPATCH = oldFlag;
    if (oldSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = oldSecret;
  });

  const runSessionResolution = async (qrFixture) => {
    const sessionCreate = jest.fn(async ({ data }) => ({ ...data, code:'session-fixture', expiresAt:new Date(Date.now()+3600000) }));
    const tx = {
      $queryRawUnsafe: jest.fn(async (sql) => {
        if (sql.includes('FROM "PrinterQr"')) return [qrFixture];
        if (sql.includes('FROM "LegacyPrinterQrBinding"') && sql.includes('AND status')) return [binding];
        if (sql.includes('FROM "LegacyPrinterQrBinding"')) return [binding];
        if (sql.includes('FROM "PrinterDevice"')) return [device];
        return [];
      }),
      session: { create: sessionCreate }
    };
    prisma.$transaction.mockImplementation((fn) => fn(tx));
    const result = await resolvePrinterQr('fixture-only-code');
    expect(sessionCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ machineId:'m1', printerQrId:'q1', printerDeviceId:'d1' }) }));
    expect(availability.getPrinterDeviceAvailability).toHaveBeenCalledWith('m1','d1',prisma);
    expect(result.printer).toMatchObject({ name:'Counter Epson', model:'Epson L6460', isOnline:true, hardwareStatus:'ONLINE' });
  };

  test('machine-level legacy QR session is bound to the approved child device', async () => {
    await runSessionResolution(lockedQr);
  });

  test('historical QR attached to the pending placeholder resolves to the approved Epson device', async () => {
    await runSessionResolution(placeholderLockedQr);
  });

  test('legacy alias validator refuses to override an already approved device-bound QR', () => {
    const directlyBoundQr = {
      id:'q1', machineId:'m1', status:'ACTIVE', printerDeviceId:'other-device',
      printerDevice:{ id:'other-device', machineId:'m1', status:'ACTIVE', approvedAt:new Date(), windowsPrinterName:'HP Queue', isDefault:false }
    };
    expect(() => validateLegacyQrAlias({ qr:directlyBoundQr, binding, device })).toThrow(/cannot override/i);
  });

  test('public pre-scan metadata resolves alias display data and device-specific availability for placeholder QR', async () => {
    prisma.printerQr.findUnique.mockResolvedValue({
      id:'q1', publicCode:'fixture-only-code', status:'ACTIVE', label:'Counter',
      machineId:'m1', printerDeviceId:placeholder.id,
      machine:{ id:'m1', name:'Shop', location:'Noida', status:'ACTIVE', printerModel:'Generic', paymentMode:'DEMO_SIMULATION' },
      printerDevice:placeholder
    });
    prisma.legacyPrinterQrBinding.findUnique.mockResolvedValue({ ...binding, printerDevice:device });
    const result = await getPublicPrinterQrInfo('fixture-only-code');
    expect(availability.getPrinterDeviceAvailability).toHaveBeenCalledWith('m1','d1',prisma);
    expect(availability.getMachineAvailability).not.toHaveBeenCalled();
    expect(result.printer).toMatchObject({ name:'Counter Epson', model:'Epson L6460', printerDeviceId:'d1', isOnline:true, hardwareStatus:'ONLINE' });
  });

  test('revoked alias metadata fails closed instead of falling back to machine QR', async () => {
    prisma.printerQr.findUnique.mockResolvedValue({
      id:'q1', publicCode:'fixture-only-code', status:'ACTIVE', label:'Counter',
      machineId:'m1', printerDeviceId:null,
      machine:{ id:'m1', name:'Shop', location:'Noida', status:'ACTIVE', printerModel:'Generic', paymentMode:'DEMO_SIMULATION' },
      printerDevice:null
    });
    prisma.legacyPrinterQrBinding.findUnique.mockResolvedValue({ ...binding, status:'REVOKED', printerDevice:device });
    await expect(getPublicPrinterQrInfo('fixture-only-code')).rejects.toThrow(/not active/);
    expect(availability.getMachineAvailability).not.toHaveBeenCalled();
  });
});
