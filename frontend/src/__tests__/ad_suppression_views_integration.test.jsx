import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { PDFDocument } from 'pdf-lib';

// Hoisted mocks for Axios, Sockets, and Cashfree
const {
  mockAxios,
  mockSocket,
  mockCashfreeInstance,
  mockCashfreeLoad,
} = vi.hoisted(() => {
  const listeners = {};
  return {
    mockAxios: {
      get: vi.fn(),
      post: vi.fn(),
    },
    mockSocket: {
      listeners,
      on: vi.fn((event, cb) => {
        listeners[event] = cb;
      }),
      emit: vi.fn(),
      close: vi.fn(),
    },
    mockCashfreeInstance: {
      checkout: vi.fn(),
    },
    mockCashfreeLoad: vi.fn(),
  };
});

mockCashfreeLoad.mockImplementation(async () => mockCashfreeInstance);

vi.mock('axios', () => ({ default: mockAxios }));
vi.mock('socket.io-client', () => ({
  io: vi.fn(() => mockSocket),
}));
vi.mock('@cashfreepayments/cashfree-js', () => ({
  load: (...args) => mockCashfreeLoad(...args),
}));

// We intentionally do NOT mock AdvertisementDisplay.
// Real AdvertisementDisplay mounts and executes fetch against our mocked global.fetch.

import KioskView from '../pages/KioskView';
import MobileView from '../pages/MobileView';

const makeValidPdfFile = async (pages = 2, name = 'integration_sample.pdf') => {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([200, 200]);
  const bytes = await doc.save();
  const file = new File([bytes], name, { type: 'application/pdf' });
  file.arrayBuffer = async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return file;
};

describe('PrintGo Phase 3 — KioskView & MobileView Advertisement Integration Tests', () => {
  let originalFetch;
  let mockFetch;

  beforeEach(() => {
    window.sessionStorage.clear();
    mockAxios.get.mockReset();
    mockAxios.post.mockReset();
    mockAxios.get.mockResolvedValue({ data: { success: false } });
    mockSocket.emit.mockReset();
    mockSocket.close.mockReset();
    mockCashfreeLoad.mockClear();
    mockCashfreeInstance.checkout.mockReset();

    for (const key in mockSocket.listeners) {
      delete mockSocket.listeners[key];
    }

    originalFetch = globalThis.fetch;
    mockFetch = vi.fn();
    globalThis.fetch = mockFetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe('1. KioskView Advertisement Integration', () => {
    it('1.1 Asynchronously acquires session and passes authoritative sessionToken to AdvertisementDisplay with KIOSK_ONLY placement', async () => {
      mockAxios.post.mockImplementation((url) => {
        if (url.includes('/api/auth/session/create')) {
          return Promise.resolve({
            data: {
              success: true,
              sessionCode: 'KIOSK-AUTH-01',
              sessionToken: 'jwt_kiosk_authoritative_session_token',
            },
          });
        }
        return Promise.reject(new Error(`Unhandled URL: ${url}`));
      });

      mockFetch.mockResolvedValue({
        json: async () => ({
          success: true,
          advertisements: [
            {
              id: 'ad-kiosk-test-1',
              title: 'Campus Printing Special',
              mediaUrl: 'https://cdn.example.com/ads/campus.jpg',
              mediaType: 'IMAGE',
              displayDuration: 15,
            },
          ],
        }),
      });

      render(
        <MemoryRouter>
          <KioskView />
        </MemoryRouter>
      );

      // Verify session creation was requested
      await waitFor(() => {
        expect(mockAxios.post).toHaveBeenCalledWith(
          expect.stringContaining('/api/auth/session/create'),
          {}
        );
      });

      // Verify AdvertisementDisplay received the authoritative token and placement
      await waitFor(() => {
        const fetchCalls = mockFetch.mock.calls;
        const authorizedCall = fetchCalls.find(([url, options]) =>
          url.includes('placement=KIOSK_ONLY') &&
          options?.headers?.Authorization === 'Bearer jwt_kiosk_authoritative_session_token'
        );
        expect(authorizedCall).toBeDefined();
      });

      // Verify the advertisement content is displayed
      await waitFor(() => {
        expect(screen.getByText('Campus Printing Special')).toBeInTheDocument();
      });
    });

    it('1.2 Renders active advertisement without disturbing Step 1 QR scan display', async () => {
      mockAxios.post.mockResolvedValue({
        data: {
          success: true,
          sessionCode: 'KIOSK-QR-99',
          sessionToken: 'jwt_kiosk_token_99',
        },
      });

      mockFetch.mockResolvedValue({
        json: async () => ({
          success: true,
          advertisements: [
            {
              id: 'ad-kiosk-banner',
              title: 'Print Double-Sided & Save',
              mediaUrl: 'https://cdn.example.com/ads/save.jpg',
              mediaType: 'IMAGE',
              displayDuration: 10,
            },
          ],
        }),
      });

      render(
        <MemoryRouter>
          <KioskView />
        </MemoryRouter>
      );

      // Verify Step 1 is rendered alongside the active ad
      await waitFor(() => {
        expect(screen.getByText('Print Double-Sided & Save')).toBeInTheDocument();
      });

      // Step 1 QR heading is rendered
      expect(screen.getByText(/Scan to/i)).toBeInTheDocument();
      expect(screen.getByText(/Point your phone's camera at the QR code/i)).toBeInTheDocument();
    });

    it('1.3 Suppressed advertisement cleanly hides ad slot and preserves kiosk session transitions', async () => {
      mockAxios.post.mockResolvedValue({
        data: {
          success: true,
          sessionCode: 'KIOSK-SUPP-77',
          sessionToken: 'jwt_kiosk_token_77',
        },
      });

      mockFetch.mockResolvedValue({
        json: async () => ({
          success: true,
          suppressed: true,
          reason: 'STORE_MANAGER_OVERRIDE',
        }),
      });

      render(
        <MemoryRouter>
          <KioskView />
        </MemoryRouter>
      );

      // Verify session created
      await waitFor(() => {
        expect(mockAxios.post).toHaveBeenCalled();
      });

      // Ad should be suppressed (no ad title rendered)
      await waitFor(() => {
        expect(screen.queryByText('Sponsored')).not.toBeInTheDocument();
      });

      // Simulate customer mobile connection event from socket inside act()
      await act(async () => {
        if (mockSocket.listeners['kiosk_user_connected']) {
          mockSocket.listeners['kiosk_user_connected']();
        }
      });

      // Kiosk transitions to Step 2
      await waitFor(() => {
        expect(screen.getByText('Device Connected')).toBeInTheDocument();
      });
    });

    it('1.4 Handles advertisement API network error gracefully without crashing kiosk', async () => {
      mockAxios.post.mockResolvedValue({
        data: {
          success: true,
          sessionCode: 'KIOSK-ERR-01',
          sessionToken: 'jwt_kiosk_err_token',
        },
      });

      mockFetch.mockRejectedValue(new Error('Network error on ad service'));

      render(
        <MemoryRouter>
          <KioskView />
        </MemoryRouter>
      );

      // Kiosk still renders Step 1 QR scan cleanly
      await waitFor(() => {
        expect(screen.getByText(/Point your phone's camera at the QR code/i)).toBeInTheDocument();
      });
    });
  });

  describe('2. MobileView Advertisement Integration (QR Route /p/:publicCode)', () => {
    const mockMachineQrData = {
      success: true,
      sessionCode: 'SESS-MOB-QR-01',
      sessionToken: 'jwt_mobile_authoritative_token_01',
      printer: {
        id: 'mach_alpha_01',
        name: 'HP LaserJet Managed MFP E82650',
        isOnline: true,
        status: 'ONLINE',
      },
      pricingProfile: {
        bwSinglePrice: 2.0,
        bwDoublePrice: 3.5,
        colorSinglePrice: 10.0,
        colorDoublePrice: 18.0,
      },
      cashfreeEnv: 'sandbox',
    };

    it('2.1 Passes publicCode, sessionToken, and MOBILE_ONLY placement to AdvertisementDisplay in Step 1', async () => {
      mockAxios.post.mockImplementation((url, data) => {
        if (url.includes('/api/auth/session/from-printer-qr')) {
          expect(data.publicCode).toBe('qr_store_front');
          return Promise.resolve({ data: mockMachineQrData });
        }
        return Promise.reject(new Error(`Unhandled POST: ${url}`));
      });

      mockFetch.mockResolvedValue({
        json: async () => ({
          success: true,
          advertisements: [
            {
              id: 'ad-mobile-01',
              title: 'Mobile Fast Upload Promo',
              mediaUrl: 'https://cdn.example.com/mobile-promo.jpg',
              mediaType: 'IMAGE',
              displayDuration: 12,
            },
          ],
        }),
      });

      render(
        <MemoryRouter initialEntries={['/p/qr_store_front']}>
          <Routes>
            <Route path="/p/:publicCode" element={<MobileView />} />
          </Routes>
        </MemoryRouter>
      );

      // Verify QR resolution
      await waitFor(() => {
        expect(mockAxios.post).toHaveBeenCalledWith(
          expect.stringContaining('/api/auth/session/from-printer-qr'),
          { publicCode: 'qr_store_front' }
        );
      });

      // Verify AdvertisementDisplay fetched with MOBILE_ONLY and publicCode
      await waitFor(() => {
        const fetchCalls = mockFetch.mock.calls;
        const authorizedCall = fetchCalls.find(([url, options]) =>
          url.includes('placement=MOBILE_ONLY') &&
          url.includes('publicCode=qr_store_front') &&
          options?.headers?.Authorization === 'Bearer jwt_mobile_authoritative_token_01'
        );
        expect(authorizedCall).toBeDefined();
      });

      // Verify ad title rendered in Step 1
      await waitFor(() => {
        expect(screen.getByText('Mobile Fast Upload Promo')).toBeInTheDocument();
      });

      // Upload controls remain functional in Step 1
      expect(screen.getByText(/Upload Your Document/i)).toBeInTheDocument();
    });

    it('2.2 Preserves AdvertisementDisplay in Step 2 after document upload', async () => {
      mockAxios.post.mockImplementation((url, data) => {
        if (url.includes('/api/auth/session/from-printer-qr')) {
          return Promise.resolve({ data: mockMachineQrData });
        }
        if (url.includes('/api/upload')) {
          return Promise.resolve({
            data: {
              success: true,
              file: {
                filename: 'integration_sample.pdf',
                originalName: 'integration_sample.pdf',
                pages: 2,
                size: 2048,
                url: 'http://localhost:5000/uploads/integration_sample.pdf',
              },
            },
          });
        }
        return Promise.reject(new Error(`Unhandled POST: ${url}`));
      });

      mockFetch.mockResolvedValue({
        json: async () => ({
          success: true,
          advertisements: [
            {
              id: 'ad-mobile-02',
              title: 'Discount on Color Prints',
              mediaUrl: 'https://cdn.example.com/discount.jpg',
              mediaType: 'IMAGE',
              displayDuration: 10,
            },
          ],
        }),
      });

      const { container } = render(
        <MemoryRouter initialEntries={['/p/qr_store_front']}>
          <Routes>
            <Route path="/p/:publicCode" element={<MobileView />} />
          </Routes>
        </MemoryRouter>
      );

      await waitFor(() => {
        expect(screen.getByText('Discount on Color Prints')).toBeInTheDocument();
      });

      // Simulate PDF upload to advance to Step 2
      const file = await makeValidPdfFile(2, 'integration_sample.pdf');
      const fileInput = container.querySelector('input[type="file"]');
      expect(fileInput).toBeTruthy();

      await act(async () => {
        fireEvent.change(fileInput, { target: { files: [file] } });
      });

      // Step 2 print settings should become visible
      await waitFor(() => {
        expect(screen.getByText(/Color Mode/i)).toBeInTheDocument();
      });

      // AdvertisementDisplay should still be present in Step 2
      expect(screen.getByText('Discount on Color Prints')).toBeInTheDocument();

      // Proceed to Payment button should be available
      expect(screen.getByText(/Proceed to Payment/i)).toBeInTheDocument();
    });

    it('2.3 Suppressed advertisements do not block file upload, print options, or checkout', async () => {
      mockAxios.post.mockImplementation((url) => {
        if (url.includes('/api/auth/session/from-printer-qr')) {
          return Promise.resolve({ data: mockMachineQrData });
        }
        if (url.includes('/api/upload')) {
          return Promise.resolve({
            data: {
              success: true,
              file: {
                filename: 'integration_sample.pdf',
                originalName: 'integration_sample.pdf',
                pages: 1,
                size: 1024,
                url: 'http://localhost:5000/uploads/integration_sample.pdf',
              },
            },
          });
        }
        return Promise.reject(new Error(`Unhandled POST: ${url}`));
      });

      mockFetch.mockResolvedValue({
        json: async () => ({
          success: true,
          suppressed: true,
          reason: 'TEMPORARY_MAINTENANCE',
        }),
      });

      const { container } = render(
        <MemoryRouter initialEntries={['/p/qr_store_front']}>
          <Routes>
            <Route path="/p/:publicCode" element={<MobileView />} />
          </Routes>
        </MemoryRouter>
      );

      await waitFor(() => {
        expect(screen.getByText(/Upload Your Document/i)).toBeInTheDocument();
      });

      // Ad should be cleanly hidden
      expect(screen.queryByText('Sponsored')).not.toBeInTheDocument();

      // Upload file
      const file = await makeValidPdfFile(1, 'integration_sample.pdf');
      const fileInput = container.querySelector('input[type="file"]');
      await act(async () => {
        fireEvent.change(fileInput, { target: { files: [file] } });
      });

      // Print options and Proceed to Pay should function completely
      await waitFor(() => {
        expect(screen.getByText(/Color Mode/i)).toBeInTheDocument();
      });
      expect(screen.getByText(/Proceed to Payment/i)).toBeInTheDocument();
    });

    it('2.4 Advertisement API failure does not break upload or checkout operations', async () => {
      mockAxios.post.mockImplementation((url) => {
        if (url.includes('/api/auth/session/from-printer-qr')) {
          return Promise.resolve({ data: mockMachineQrData });
        }
        if (url.includes('/api/upload')) {
          return Promise.resolve({
            data: {
              success: true,
              file: {
                filename: 'integration_sample.pdf',
                originalName: 'integration_sample.pdf',
                pages: 3,
                size: 3072,
                url: 'http://localhost:5000/uploads/integration_sample.pdf',
              },
            },
          });
        }
        return Promise.reject(new Error(`Unhandled POST: ${url}`));
      });

      mockFetch.mockRejectedValue(new Error('503 Service Unavailable'));

      const { container } = render(
        <MemoryRouter initialEntries={['/p/qr_store_front']}>
          <Routes>
            <Route path="/p/:publicCode" element={<MobileView />} />
          </Routes>
        </MemoryRouter>
      );

      await waitFor(() => {
        expect(screen.getByText(/Upload Your Document/i)).toBeInTheDocument();
      });

      const file = await makeValidPdfFile(3, 'integration_sample.pdf');
      const fileInput = container.querySelector('input[type="file"]');
      await act(async () => {
        fireEvent.change(fileInput, { target: { files: [file] } });
      });

      await waitFor(() => {
        expect(screen.getByText(/Color Mode/i)).toBeInTheDocument();
      });
      expect(screen.getByText(/Proceed to Payment/i)).toBeInTheDocument();
    });
  });

  describe('3. MobileView Advertisement Integration (Direct Session Route /m/:sessionId)', () => {
    it('3.1 Resolves direct session and passes sessionToken to AdvertisementDisplay with MOBILE_ONLY placement', async () => {
      mockAxios.post.mockImplementation((url, data) => {
        if (url.includes('/api/auth/session/join')) {
          expect(data.sessionCode).toBe('sess_direct_88');
          return Promise.resolve({
            data: {
              success: true,
              sessionToken: 'jwt_direct_session_token_88',
              machineId: 'mach_beta_02',
              pricingProfile: {
                bwSinglePrice: 2.5,
                bwDoublePrice: 4.0,
                colorSinglePrice: 12.0,
                colorDoublePrice: 20.0,
              },
              cashfreeEnv: 'sandbox',
            },
          });
        }
        return Promise.reject(new Error(`Unhandled POST: ${url}`));
      });

      mockFetch.mockResolvedValue({
        json: async () => ({
          success: true,
          advertisements: [
            {
              id: 'ad-direct-sess-01',
              title: 'Express Mobile Print',
              mediaUrl: 'https://cdn.example.com/express.jpg',
              mediaType: 'IMAGE',
              displayDuration: 8,
            },
          ],
        }),
      });

      render(
        <MemoryRouter initialEntries={['/m/sess_direct_88']}>
          <Routes>
            <Route path="/m/:sessionId" element={<MobileView />} />
          </Routes>
        </MemoryRouter>
      );

      // Verify session resolution
      await waitFor(() => {
        expect(mockAxios.post).toHaveBeenCalledWith(
          expect.stringContaining('/api/auth/session/join'),
          { sessionCode: 'sess_direct_88' }
        );
      });

      // Verify AdvertisementDisplay fetch
      await waitFor(() => {
        const fetchCalls = mockFetch.mock.calls;
        const authorizedCall = fetchCalls.find(([url, options]) =>
          url.includes('placement=MOBILE_ONLY') &&
          options?.headers?.Authorization === 'Bearer jwt_direct_session_token_88'
        );
        expect(authorizedCall).toBeDefined();
      });

      // Verify ad title is displayed
      await waitFor(() => {
        expect(screen.getByText('Express Mobile Print')).toBeInTheDocument();
      });
    });
  });
});
