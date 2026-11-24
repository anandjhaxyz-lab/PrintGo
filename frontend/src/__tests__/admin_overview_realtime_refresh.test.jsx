import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import axios from 'axios';
import { io } from 'socket.io-client';
import AdminDashboard from '../pages/AdminDashboard';

// Mock axios
vi.mock('axios', () => {
  const mockAxios = {
    get: vi.fn(),
    post: vi.fn(),
    defaults: {
      headers: {
        common: {},
      },
    },
  };
  return { default: mockAxios };
});

// Mock socket.io-client
const socketListeners = {};
const mockSocket = {
  on: vi.fn((event, cb) => {
    socketListeners[event] = cb;
  }),
  disconnect: vi.fn(),
};

vi.mock('socket.io-client', () => ({
  io: vi.fn(() => mockSocket),
}));

describe('Phase 3.12 — Admin Dashboard Real-Time Overview Refresh & Debounce', () => {
  const initialOverviewData = {
    success: true,
    data: {
      orders: { total: 10, completed: 8, printing: 1, failed: 1, pendingPayment: 0 },
      financials: {
        grossCollections: 500,
        demoCollections: 0,
        totalRefunds: 0,
        netCollections: 500,
        successfulPayments: 8,
        pendingPayments: 0,
        averageOrderValue: 62.5,
        currency: 'INR',
      },
      hardware: {
        totalMachines: 1,
        activePrinters: 0,
        offlinePrinters: 1,
      },
    },
  };

  const updatedOverviewData = {
    success: true,
    data: {
      orders: { total: 10, completed: 8, printing: 1, failed: 1, pendingPayment: 0 },
      financials: {
        grossCollections: 500,
        demoCollections: 0,
        totalRefunds: 0,
        netCollections: 500,
        successfulPayments: 8,
        pendingPayments: 0,
        averageOrderValue: 62.5,
        currency: 'INR',
      },
      hardware: {
        totalMachines: 1,
        activePrinters: 1,
        offlinePrinters: 0,
      },
    },
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    for (const key of Object.keys(socketListeners)) {
      delete socketListeners[key];
    }
    localStorage.setItem('adminToken', 'mock-admin-jwt-token');

    // Default API mocks for login verification & dashboard loaders
    axios.get.mockImplementation((url) => {
      if (url.includes('/api/auth/me')) {
        return Promise.resolve({
          data: {
            success: true,
            user: { id: 'u1', name: 'Super Admin', role: 'SUPERADMIN', email: 'admin@printgo.in' },
          },
        });
      }
      if (url.includes('/api/admin/analytics/overview')) {
        return Promise.resolve({ data: initialOverviewData });
      }
      return Promise.resolve({ data: { success: true, data: [] } });
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
  });

  it('Refreshes GET /api/admin/analytics/overview and updates Overview stats on printer_status_update with machineId', async () => {
    render(<AdminDashboard />);

    // Fast-forward auth verification and initial dashboard load
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });

    // Check that socket listener was registered
    expect(mockSocket.on).toHaveBeenCalledWith('printer_status_update', expect.any(Function));

    // Initially 0 / 1 online
    expect(screen.getByText(/\/ 1 online/i)).toBeInTheDocument();
    expect(screen.getByText(/1 offline \/ error/i)).toBeInTheDocument();

    // Prepare updated mock for subsequent overview call
    axios.get.mockImplementation((url) => {
      if (url.includes('/api/admin/analytics/overview')) {
        return Promise.resolve({ data: updatedOverviewData });
      }
      return Promise.resolve({ data: { success: true, data: [] } });
    });

    const callsBeforeUpdate = axios.get.mock.calls.filter((c) =>
      c[0].includes('/api/admin/analytics/overview')
    ).length;

    // Simulate incoming socket event with machineId
    act(() => {
      socketListeners['printer_status_update']({
        machineId: 'm-001',
        name: 'Main Shop Printer',
        isReady: true,
        isOnline: true,
        hardwareStatus: 'ONLINE',
      });
    });

    // Overview refresh should NOT fire immediately (debounce timer active)
    const callsDuringDebounce = axios.get.mock.calls.filter((c) =>
      c[0].includes('/api/admin/analytics/overview')
    ).length;
    expect(callsDuringDebounce).toBe(callsBeforeUpdate);

    // Fast-forward timer past 400ms debounce
    await act(async () => {
      await vi.advanceTimersByTimeAsync(450);
    });

    // Verify GET /api/admin/analytics/overview was requested
    const callsAfterDebounce = axios.get.mock.calls.filter((c) =>
      c[0].includes('/api/admin/analytics/overview')
    ).length;
    expect(callsAfterDebounce).toBe(callsBeforeUpdate + 1);

    // Verify UI reflects authoritative updated stats: 1 / 1 online, 0 offline
    expect(screen.getByText(/\/ 1 online/i)).toBeInTheDocument();
    expect(screen.getByText(/0 offline \/ error/i)).toBeInTheDocument();
  });

  it('Coalesces multiple rapid printer_status_update bursts into a single overview refresh', async () => {
    render(<AdminDashboard />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });

    const callsBeforeBursts = axios.get.mock.calls.filter((c) =>
      c[0].includes('/api/admin/analytics/overview')
    ).length;

    // Fire 5 rapid updates within 100ms
    act(() => {
      for (let i = 0; i < 5; i++) {
        socketListeners['printer_status_update']({
          machineId: 'm-001',
          hardwareStatus: 'ONLINE',
          isReady: true,
        });
        vi.advanceTimersByTime(20);
      }
    });

    // Still in debounce window
    expect(
      axios.get.mock.calls.filter((c) => c[0].includes('/api/admin/analytics/overview')).length
    ).toBe(callsBeforeBursts);

    // Fast-forward past the final debounce expiration
    await act(async () => {
      await vi.advanceTimersByTimeAsync(450);
    });

    // Should have only triggered ONE additional overview call
    const callsAfterBursts = axios.get.mock.calls.filter((c) =>
      c[0].includes('/api/admin/analytics/overview')
    ).length;
    expect(callsAfterBursts).toBe(callsBeforeBursts + 1);
  });

  it('Clears pending debounce timer on component unmount before disconnect', async () => {
    const { unmount } = render(<AdminDashboard />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });

    const callsBefore = axios.get.mock.calls.filter((c) =>
      c[0].includes('/api/admin/analytics/overview')
    ).length;

    // Trigger update to schedule timer
    act(() => {
      socketListeners['printer_status_update']({
        machineId: 'm-001',
        isReady: true,
      });
    });

    // Unmount while timer is pending
    unmount();

    expect(mockSocket.disconnect).toHaveBeenCalled();

    // Advance timer past debounce window
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    // No additional overview calls should have fired after unmount
    const callsAfter = axios.get.mock.calls.filter((c) =>
      c[0].includes('/api/admin/analytics/overview')
    ).length;
    expect(callsAfter).toBe(callsBefore);
  });

  it('Does not schedule overview refresh if printer_status_update lacks machineId', async () => {
    render(<AdminDashboard />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });

    const callsBefore = axios.get.mock.calls.filter((c) =>
      c[0].includes('/api/admin/analytics/overview')
    ).length;

    // Trigger update without machineId
    act(() => {
      socketListeners['printer_status_update']({
        isError: false,
        message: 'Online',
      });
    });

    // Advance timer
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    // No overview calls should have fired
    const callsAfter = axios.get.mock.calls.filter((c) =>
      c[0].includes('/api/admin/analytics/overview')
    ).length;
    expect(callsAfter).toBe(callsBefore);
  });
});
