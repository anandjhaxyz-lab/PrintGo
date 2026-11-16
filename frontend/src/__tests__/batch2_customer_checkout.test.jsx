import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { PDFDocument } from 'pdf-lib';

// Mocks defined cleanly with vi.hoisted before component import
const {
  mockAxios,
  mockSocket,
  mockCashfreeInstance,
  mockCashfreeLoad,
} = vi.hoisted(() => ({
  mockAxios: {
    get: vi.fn(),
    post: vi.fn(),
  },
  mockSocket: {
    on: vi.fn(),
    emit: vi.fn(),
    close: vi.fn(),
  },
  mockCashfreeInstance: {
    checkout: vi.fn(),
  },
  mockCashfreeLoad: vi.fn(),
}));
mockCashfreeLoad.mockImplementation(async () => mockCashfreeInstance);

vi.mock('axios', () => ({ default: mockAxios }));
vi.mock('socket.io-client', () => ({
  io: vi.fn(() => mockSocket),
}));
vi.mock('@cashfreepayments/cashfree-js', () => ({
  load: (...args) => mockCashfreeLoad(...args),
}));

// Keep AdvertisementDisplay quiet & non-fetching in unit tests
vi.mock('../components/AdvertisementDisplay', () => ({
  AdvertisementDisplay: () => null,
}));

import MobileView from '../pages/MobileView';
import { getApiUrl, validateOriginConfig } from '../utils/apiConfig';
import { calculatePrintBreakdown } from '../utils/pricingCalculator';

const makeValidPdfFile = async (pages = 2, name = 'sample.pdf') => {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([200, 200]);
  const bytes = await doc.save();
  const file = new File([bytes], name, { type: 'application/pdf' });
  file.arrayBuffer = async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return file;
};

const renderMobileAt = (initialEntry = '/p/qr_pilot_1') =>
  render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route path="/p/:publicCode" element={<MobileView />} />
        <Route path="/m/:sessionId" element={<MobileView />} />
      </Routes>
    </MemoryRouter>
  );

describe('S3K Batch 2 - Customer Mobile Checkout, Pricing, Security & Recovery', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    window.history.replaceState({}, '', '/p/qr_pilot_1');
    mockAxios.get.mockReset();
    mockAxios.post.mockReset();
    mockSocket.on.mockReset();
    mockSocket.emit.mockReset();
    mockSocket.close.mockReset();
    mockCashfreeLoad.mockClear();
    mockCashfreeInstance.checkout.mockReset();
    URL.createObjectURL = vi.fn(() => 'blob:http://localhost/preview-clean');
    URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    cleanup();
  });

  it('T1 + P1: Preserves split-origin HTTPS VITE_API_URL and computes full dynamic pricing breakdown', () => {
    const resolved = getApiUrl({
      envApiUrl: 'https://api.printgo.example.com/',
      locationObj: { protocol: 'https:', hostname: 'mobile.vercel.app', port: '', origin: 'https://mobile.vercel.app' },
    });
    expect(resolved).toBe('https://api.printgo.example.com');

    const validation = validateOriginConfig({
      envApiUrl: 'https://api.printgo.example.com',
      locationObj: { protocol: 'https:', origin: 'https://mobile.vercel.app' },
    });
    expect(validation.isSplitOrigin).toBe(true);
    expect(validation.warnings).toEqual([]);

    const bd = calculatePrintBreakdown(
      { color: 'color', duplex: 'double', copies: 2 },
      3,
      { colorDuplexRate: 20, convenienceFee: 2, minOrderAmount: 10, gstEnabled: true, gstRatePercent: 18, isTaxInclusive: false }
    );
    // Math.ceil(3/2)=2 sheets * 2 copies * 20 = 80 + 2 fee = 82; + 18% excl GST = 96.76 -> rounded 97
    expect(bd.sheetsCount).toBe(4);
    expect(bd.basePrintCharge).toBe(80);
    expect(bd.convenienceFee).toBe(2);
    expect(bd.totalAmount).toBe(97);
  });

  it('T2 + T3: QR scan -> PDF upload -> dynamic pricing -> Cashfree Sandbox checkout + duplicate-click guard + server verify unlock + Step 4 receipt download', async () => {
    mockAxios.post.mockImplementation(async (url) => {
      if (url.endsWith('/api/auth/session/from-printer-qr')) {
        return {
          data: {
            success: true,
            sessionCode: 'sess_abc123',
            sessionToken: 'tok_abc123',
            expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
            cashfreeEnv: 'sandbox',
            pricingProfile: {
              bwSingleRate: 4,
              bwDuplexRate: 6,
              colorSingleRate: 12,
              colorDuplexRate: 20,
              convenienceFee: 1,
              minOrderAmount: 1,
              gstEnabled: false,
              gstRatePercent: 18,
              isTaxInclusive: true,
            },
            printer: { name: 'Epson L6460 Pilot', location: 'Front Desk', isOnline: true },
          },
        };
      }
      if (url.endsWith('/api/upload')) {
        return {
          data: {
            success: true,
            file: { filename: '/uploads/sample.pdf', originalName: 'sample.pdf', size: 2048, pages: 2 },
          },
        };
      }
      if (url.endsWith('/api/jobs')) {
        return {
          data: {
            success: true,
            job: { shortId: 'job777', cost: 9, status: 'PENDING_PAYMENT' },
          },
        };
      }
      if (url.endsWith('/api/payments/order/job777')) {
        // Hold briefly to verify duplicate-click guard
        await new Promise((r) => setTimeout(r, 40));
        return {
          data: {
            success: true,
            paymentSessionId: 'cf_sess_777',
            orderId: 'order_job777_1',
            environment: 'sandbox',
          },
        };
      }
      throw new Error(`Unexpected POST ${url}`);
    });

    mockCashfreeInstance.checkout.mockResolvedValue({ paymentDetails: { paymentMessage: 'Success in modal' } });

    mockAxios.get.mockImplementation(async (url) => {
      if (url.includes('/api/payments/verify/order_job777_1')) {
        return {
          data: {
            success: true,
            status: 'WAITING',
            job: { shortId: 'job777', status: 'WAITING', cost: 9 },
          },
        };
      }
      if (url.endsWith('/api/jobs/job777')) {
        return { data: { success: true, job: { shortId: 'job777', status: 'COMPLETED', cost: 9 } } };
      }
      if (url.endsWith('/api/jobs/job777/invoice')) {
        return {
          data: {
            success: true,
            invoice: { invoiceNumber: 'INV-2026-0001', totalAmount: 9, cgstAmount: 0, sgstAmount: 0, totalTax: 0 },
          },
        };
      }
      if (url.endsWith('/api/jobs/job777/invoice/download')) {
        return { data: new Uint8Array([37, 80, 68, 70]) };
      }
      return { data: { success: true } };
    });

    const { container } = renderMobileAt('/p/qr_pilot_1');

    // Step 1: Wait for printer card, then upload PDF
    await waitFor(() => expect(screen.getByText('Epson L6460 Pilot')).toBeInTheDocument());
    const fileInput = container.querySelector('input[type="file"]');
    const pdfFile = await makeValidPdfFile(2, 'sample.pdf');
    fireEvent.change(fileInput, { target: { files: [pdfFile] } });

    // Step 2: Shows dynamic profile rate ₹4 / page & total 2*4 + 1 fee = ₹9.00
    await waitFor(() => expect(screen.getByText('₹4 / page')).toBeInTheDocument());
    expect(screen.getByText('₹9.00')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Proceed to Payment/i }));

    // Step 3: Cashfree Sandbox checkout card visible; no demo button
    await waitFor(() => expect(screen.getByText(/Cashfree Sandbox Test Mode/i)).toBeInTheDocument());
    expect(screen.queryByText(/Self-Service Live Mode/i)).toBeNull();

    const payBtn = screen.getByRole('button', { name: /Pay ₹9\.00 via Cashfree/i });
    // Rapid double click -> must only create ONE Cashfree order
    fireEvent.click(payBtn);
    fireEvent.click(payBtn);

    await waitFor(() => expect(mockCashfreeLoad).toHaveBeenCalledWith({ mode: 'sandbox' }));
    const orderCalls = mockAxios.post.mock.calls.filter((c) => c[0].includes('/api/payments/order/'));
    expect(orderCalls.length).toBe(1);

    // Must NEVER emit payment_success from frontend socket
    const paymentSuccessEmits = mockSocket.emit.mock.calls.filter((c) => c[0] === 'payment_success');
    expect(paymentSuccessEmits.length).toBe(0);

    // Step 4: Confirmed + Receipt card + authenticated Blob download
    await waitFor(() => expect(screen.getByText('INV-2026-0001')).toBeInTheDocument());
    expect(screen.getAllByText('SPURTI COMMUNICATIONS').length).toBeGreaterThanOrEqual(2);

    const downloadBtn = screen.getByRole('button', { name: /Download PDF Receipt/i });
    fireEvent.click(downloadBtn);
    await waitFor(() =>
      expect(mockAxios.get).toHaveBeenCalledWith(
        expect.stringContaining('/api/jobs/job777/invoice/download'),
        expect.objectContaining({ responseType: 'blob' })
      )
    );
  });

  it('T4 + T5 + T9: Handles Cashfree error/drop without advancing to Step 4; rejects socket event until server confirms', async () => {
    mockAxios.post.mockImplementation(async (url) => {
      if (url.endsWith('/api/auth/session/from-printer-qr')) {
        return {
          data: {
            success: true,
            sessionCode: 'sess_fail',
            sessionToken: 'tok_fail',
            expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
            cashfreeEnv: 'sandbox',
            printer: { name: 'Epson L6460 Pilot', location: 'Desk', isOnline: true },
          },
        };
      }
      if (url.endsWith('/api/upload')) {
        return { data: { success: true, file: { filename: '/uploads/a.pdf', originalName: 'a.pdf', size: 512, pages: 1 } } };
      }
      if (url.endsWith('/api/jobs')) {
        return { data: { success: true, job: { shortId: 'jobFail1', cost: 2, status: 'PENDING_PAYMENT' } } };
      }
      if (url.endsWith('/api/payments/order/jobFail1')) {
        return { data: { success: true, paymentSessionId: 'cf_fail_1', orderId: 'order_fail_1', environment: 'sandbox' } };
      }
      throw new Error(`Unexpected POST ${url}`);
    });

    mockCashfreeInstance.checkout.mockResolvedValue({ error: { message: 'User cancelled UPI popup' } });
    mockAxios.get.mockResolvedValue({
      data: { success: false, status: 'USER_DROPPED' },
    });

    const { container } = renderMobileAt('/p/qr_pilot_1');
    await waitFor(() => expect(screen.getByText('Epson L6460 Pilot')).toBeInTheDocument());

    const pdfFile = await makeValidPdfFile(1, 'a.pdf');
    fireEvent.change(container.querySelector('input[type="file"]'), { target: { files: [pdfFile] } });
    await waitFor(() => expect(screen.getByRole('button', { name: /Proceed to Payment/i })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /Proceed to Payment/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Pay ₹2\.00 via Cashfree/i })).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Pay ₹2\.00 via Cashfree/i }));

    await waitFor(() => expect(screen.getByText(/Retry Payment/i)).toBeInTheDocument());
    expect(screen.queryByText(/Printing Complete/i)).toBeNull();

    // Even if forged socket kiosk_payment_success fires, frontend verifies server & stays in Step 3!
    const socketCall = mockSocket.on.mock.calls.find((c) => c[0] === 'kiosk_payment_success');
    expect(socketCall).toBeDefined();
    await socketCall[1]({ jobId: 'jobFail1' });
    expect(screen.getByText(/Cashfree Checkout/i)).toBeInTheDocument();
  });

  it('T6 + T7: Redirect return (?job_id=...&order_id=...) preserves existing sessionToken without creating duplicate QR session or job', async () => {
    window.sessionStorage.setItem(
      'printgo_pilot_session_qr:qr_pilot_1',
      JSON.stringify({
        scopeKey: 'qr:qr_pilot_1',
        publicCode: 'qr_pilot_1',
        sessionCode: 'sess_saved_99',
        sessionToken: 'tok_saved_99',
        jobId: 'jobSaved99',
        orderId: 'order_saved_99',
        price: 10,
        cashfreeEnv: 'sandbox',
        expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
        printerInfo: { name: 'Epson L6460 Pilot', location: 'Counter' },
      })
    );
    window.history.replaceState({}, '', '/p/qr_pilot_1?job_id=jobSaved99&order_id=order_saved_99');

    mockAxios.get.mockImplementation(async (url) => {
      if (url.includes('/api/auth/pricing')) {
        return { data: { success: true, cashfreeEnv: 'sandbox' } };
      }
      if (url.includes('/api/payments/verify/order_saved_99')) {
        return {
          data: {
            success: true,
            status: 'WAITING',
            job: { shortId: 'jobSaved99', status: 'WAITING', cost: 10 },
          },
        };
      }
      if (url.endsWith('/api/jobs/jobSaved99')) {
        return { data: { success: true, job: { shortId: 'jobSaved99', status: 'WAITING', cost: 10 } } };
      }
      if (url.endsWith('/api/jobs/jobSaved99/invoice')) {
        return { data: { success: true, invoice: { invoiceNumber: 'INV-SAVED-99', totalAmount: 10 } } };
      }
      return { data: { success: true } };
    });

    renderMobileAt('/p/qr_pilot_1');

    await waitFor(() => expect(screen.getByText('INV-SAVED-99')).toBeInTheDocument());
    // Crucially: did NOT call POST /api/auth/session/from-printer-qr OR POST /api/jobs!
    expect(mockAxios.post).not.toHaveBeenCalled();
    expect(mockAxios.get).toHaveBeenCalledWith(
      expect.stringContaining('/api/payments/verify/order_saved_99'),
      expect.objectContaining({ headers: { Authorization: 'Bearer tok_saved_99' } })
    );
  });

  it('U1 + U2: Rejects unsupported files (.docx) without uploading, and builds preview URL BEFORE E2E AES-GCM encryption', async () => {
    const createObjectUrls = [];
    URL.createObjectURL = vi.fn((blob) => {
      createObjectUrls.push(blob);
      return 'blob:http://localhost/unencrypted-pdf-preview';
    });

    mockAxios.post.mockImplementation(async (url) => {
      if (url.endsWith('/api/auth/session/join')) {
        return {
          data: {
            success: true,
            sessionToken: 'tok_e2e_1',
            machineId: 'mach_e2e_1',
            cashfreeEnv: 'sandbox',
            expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
          },
        };
      }
      if (url.endsWith('/api/upload')) {
        return { data: { success: true, file: { filename: '/uploads/e2e.pdf', originalName: 'e2e.pdf', size: 1200, pages: 1 } } };
      }
      throw new Error(`Unexpected POST ${url}`);
    });

    // Generate transient test RSA 1024-bit public key (supports SHA-256 RSA-OAEP on 32-byte AES key)
    const forge = (await import('node-forge')).default;
    const keypair = forge.pki.rsa.generateKeyPair({ bits: 1024 });
    const pubPem = forge.pki.publicKeyToPem(keypair.publicKey);
    mockAxios.get.mockResolvedValue({ data: { success: true, publicKey: pubPem } });

    const { container } = renderMobileAt('/m/legacy_sid_1');
    await waitFor(() => expect(mockAxios.get).toHaveBeenCalledWith(expect.stringContaining('/public-key')));

    const input = container.querySelector('input[type="file"]');

    // 1. Unsupported .docx must be rejected immediately with zero POST /api/upload call
    const badFile = new File(['hello'], 'notes.docx', {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    fireEvent.change(input, { target: { files: [badFile] } });
    await waitFor(() => expect(screen.getByText(/Unsupported file format/i)).toBeInTheDocument());
    expect(mockAxios.post.mock.calls.filter((c) => c[0].includes('/api/upload')).length).toBe(0);

    // 2. Valid PDF with E2E active: upload uses isEncrypted=true, while preview blob retains application/pdf!
    const pdfFile = await makeValidPdfFile(1, 'e2e.pdf');
    fireEvent.change(input, { target: { files: [pdfFile] } });
    await waitFor(() => expect(screen.getByRole('button', { name: /Proceed to Payment/i })).toBeInTheDocument());

    expect(createObjectUrls.length).toBe(1);
    expect(createObjectUrls[0].type).toBe('application/pdf');
    const uploadCall = mockAxios.post.mock.calls.find((c) => c[0].includes('/api/upload'));
    expect(uploadCall[1].get('isEncrypted')).toBe('true');
  });

  it('T8: Pending verification & browser refresh / back recovery without duplicate PrintJob', async () => {
    window.sessionStorage.setItem(
      'printgo_pilot_session_qr:qr_pilot_1',
      JSON.stringify({
        scopeKey: 'qr:qr_pilot_1',
        publicCode: 'qr_pilot_1',
        sessionCode: 'sess_back_1',
        sessionToken: 'tok_back_1',
        jobId: 'jobBack1',
        orderId: 'order_back_1',
        price: 6,
        cashfreeEnv: 'sandbox',
        expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
        printerInfo: { name: 'Epson L6460 Pilot', location: 'Counter' },
      })
    );
    window.history.replaceState({}, '', '/p/qr_pilot_1');

    let verifiedOnSecondPoll = false;
    mockAxios.get.mockImplementation(async (url) => {
      if (url.includes('/api/auth/pricing')) {
        return { data: { success: true, cashfreeEnv: 'sandbox' } };
      }
      if (url.endsWith('/api/jobs/jobBack1')) {
        return {
          data: {
            success: true,
            job: { shortId: 'jobBack1', status: verifiedOnSecondPoll ? 'WAITING' : 'PENDING_PAYMENT', cost: 6 },
          },
        };
      }
      if (url.includes('/api/payments/verify/order_back_1')) {
        if (!verifiedOnSecondPoll) {
          return { data: { success: false, status: 'PENDING' } };
        }
        return {
          data: {
            success: true,
            status: 'WAITING',
            job: { shortId: 'jobBack1', status: 'WAITING', cost: 6 },
          },
        };
      }
      if (url.endsWith('/api/jobs/jobBack1/invoice')) {
        return { data: { success: true, invoice: { invoiceNumber: 'INV-BACK-1', totalAmount: 6 } } };
      }
      return { data: { success: true } };
    });

    renderMobileAt('/p/qr_pilot_1');

    // Recovers cleanly at Step 3 with existing jobId & orderId and zero POST /api/jobs calls!
    await waitFor(() => expect(screen.getByRole('button', { name: /Already paid\? Check server status/i })).toBeInTheDocument());
    expect(mockAxios.post).not.toHaveBeenCalled();

    // Once Cashfree settles on backend, manual re-verify advances cleanly to Step 4
    verifiedOnSecondPoll = true;
    fireEvent.click(screen.getByRole('button', { name: /Already paid\? Check server status/i }));
    await waitFor(() => expect(screen.getByText('INV-BACK-1')).toBeInTheDocument());
  });

  it('T10: Renders SIMULATE DEMO PAYMENT — STAGING ONLY button & warning only when enableDemoPayment=true, and dispatches to Step 4', async () => {
    mockAxios.post.mockImplementation(async (url) => {
      if (url.endsWith('/api/auth/session/from-printer-qr')) {
        return {
          data: {
            success: true,
            sessionCode: 'sess_demo_ui',
            sessionToken: 'tok_demo_ui',
            expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
            cashfreeEnv: 'sandbox',
            enableDemoPayment: true, // EXPLICITLY PERMITTED BY BACKEND STAGING
            pricingProfile: {
              bwSingleRate: 5,
              bwDuplexRate: 8,
              convenienceFee: 0,
              minOrderAmount: 1,
              gstEnabled: false,
              isTaxInclusive: true,
            },
            printer: { name: 'EPSON L6460 Pilot', location: 'Staging Counter', isOnline: true },
          },
        };
      }
      if (url.endsWith('/api/upload')) {
        return {
          data: {
            success: true,
            file: { filename: '/uploads/demo.pdf', originalName: 'demo.pdf', size: 1024, pages: 1 },
          },
        };
      }
      if (url.endsWith('/api/jobs')) {
        return {
          data: {
            success: true,
            job: { shortId: 'jobDemo77', cost: 5, status: 'PENDING_PAYMENT' },
          },
        };
      }
      if (url.includes('/api/payments/demo-pay/jobDemo77')) {
        return {
          data: {
            success: true,
            message: 'Demo payment confirmed and dispatched to printer',
            job: { shortId: 'jobDemo77', cost: 5, status: 'WAITING' },
            payment: { gatewayOrderId: 'demo_order_jobDemo77_123', status: 'SUCCESS' }
          },
        };
      }
      throw new Error(`Unexpected POST ${url}`);
    });

    mockAxios.get.mockImplementation(async (url) => {
      if (url.endsWith('/api/jobs/jobDemo77')) {
        return { data: { success: true, job: { shortId: 'jobDemo77', status: 'WAITING', cost: 5 } } };
      }
      if (url.endsWith('/api/jobs/jobDemo77/invoice')) {
        return { data: { success: true, invoice: { invoiceNumber: 'INV-DEMO-77', totalAmount: 5 } } };
      }
      return { data: { success: true } };
    });

    const { container } = renderMobileAt('/p/qr_pilot_1');

    await waitFor(() => expect(screen.getByText('EPSON L6460 Pilot')).toBeInTheDocument());
    const fileInput = container.querySelector('input[type="file"]');
    const pdfFile = await makeValidPdfFile(1, 'demo.pdf');
    fireEvent.change(fileInput, { target: { files: [pdfFile] } });

    await waitFor(() => expect(screen.getByRole('button', { name: /Proceed to Payment/i })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /Proceed to Payment/i }));

    // Step 3 Checkout: Verify both Cashfree button AND Staging Demo Payment button + Warning exist!
    await waitFor(() => expect(screen.getByRole('button', { name: /SIMULATE DEMO PAYMENT — STAGING ONLY/i })).toBeInTheDocument());
    expect(screen.getByText(/NO REAL PAYMENT WILL BE CHARGED\./i)).toBeInTheDocument();
    expect(screen.getByText(/A REAL PHYSICAL PRINT WILL BE PRODUCED\./i)).toBeInTheDocument();

    // Click Demo Payment
    fireEvent.click(screen.getByRole('button', { name: /SIMULATE DEMO PAYMENT — STAGING ONLY/i }));

    // Dispatches POST /api/payments/demo-pay/jobDemo77 and transitions to Step 4
    await waitFor(() => {
      const demoPostCalls = mockAxios.post.mock.calls.filter((c) => c[0].includes('/api/payments/demo-pay/jobDemo77'));
      expect(demoPostCalls.length).toBe(1);
    });

    await waitFor(() => expect(screen.getByText('INV-DEMO-77')).toBeInTheDocument());
  });
});
