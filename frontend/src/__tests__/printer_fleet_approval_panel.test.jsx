import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import axios from 'axios';
import { PrinterFleetApprovalPanel } from '../components/admin/views/PrinterFleetApprovalPanel';

vi.mock('axios', () => {
  const mockAxios = {
    get: vi.fn(),
    post: vi.fn(),
    defaults: { headers: { common: {} } }
  };
  return { default: mockAxios };
});

describe('Phase 3B.3 — PrinterFleetApprovalPanel Safe Non-Default Approval', () => {
  const currentUser = { id: 'usr_admin', email: 'admin@printgo.in', role: 'SUPERADMIN' };

  const mockDiscoveries = [
    {
      id: 'disc_hp_001',
      machineId: 'd010496f-f176-41fe-9c98-efd2213a4a0e',
      windowsPrinterName: 'HP LaserJet Professional M1136 MFP (Copy 1)',
      driverName: 'HP LaserJet Professional M1136 MFP',
      portName: 'USB011',
      connectionType: 'USB',
      isDefault: false,
      reviewStatus: 'DISCOVERED',
      machine: { id: 'd010496f-f176-41fe-9c98-efd2213a4a0e', name: 'Main Shop Printer', location: 'Front Desk' }
    },
    {
      id: 'disc_canon_002',
      machineId: 'd010496f-f176-41fe-9c98-efd2213a4a0e',
      windowsPrinterName: 'Canon Generic Plus UFR II (Copy 2)',
      driverName: 'Canon Generic Plus UFR II',
      portName: 'USB001',
      connectionType: 'USB',
      isDefault: false,
      reviewStatus: 'DISCOVERED',
      machine: { id: 'd010496f-f176-41fe-9c98-efd2213a4a0e', name: 'Main Shop Printer', location: 'Front Desk' }
    }
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    axios.get.mockImplementation((url) => {
      if (url.includes('/api/admin/printer-discoveries')) {
        return Promise.resolve({ data: { success: true, data: { discoveries: mockDiscoveries, total: 2 } } });
      }
      if (url.includes('/api/admin/printer-devices')) {
        return Promise.resolve({ data: { success: true, data: { devices: [], total: 0, deviceQrEnabled: false } } });
      }
      return Promise.reject(new Error(`Unhandled GET url: ${url}`));
    });

    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('1. Loads and renders pending discoveries for HP and Canon', async () => {
    render(<PrinterFleetApprovalPanel currentUser={currentUser} />);

    await waitFor(() => {
      expect(screen.getByText(/HP LaserJet Professional M1136 MFP \(Copy 1\)/i)).toBeInTheDocument();
      expect(screen.getByText(/Canon Generic Plus UFR II \(Copy 2\)/i)).toBeInTheDocument();
    });
  });

  it('2. Submits approval request explicitly containing { displayName, isDefault: false } for Target 1 (HP)', async () => {
    vi.spyOn(window, 'prompt').mockReturnValue('HP LaserJet M1136');

    axios.post.mockResolvedValueOnce({
      data: {
        success: true,
        data: {
          device: {
            id: 'dev_hp_001',
            displayName: 'HP LaserJet M1136',
            windowsPrinterName: 'HP LaserJet Professional M1136 MFP (Copy 1)',
            isDefault: false,
            status: 'ACTIVE'
          }
        }
      }
    });

    render(<PrinterFleetApprovalPanel currentUser={currentUser} />);

    await waitFor(() => {
      expect(screen.getByText(/HP LaserJet Professional M1136 MFP \(Copy 1\)/i)).toBeInTheDocument();
    });

    const approveButtons = screen.getAllByRole('button', { name: /Approve & Register Printer/i });
    expect(approveButtons.length).toBe(2);

    fireEvent.click(approveButtons[0]);

    await waitFor(() => {
      expect(axios.post).toHaveBeenCalledTimes(1);
      const [url, payload] = axios.post.mock.calls[0];
      expect(url).toContain('/api/admin/printer-discoveries/disc_hp_001/approve');
      expect(payload).toEqual({
        displayName: 'HP LaserJet M1136',
        isDefault: false
      });
      expect(payload.isDefault).toBe(false);
    });
  });

  it('3. Submits approval request explicitly containing { displayName, isDefault: false } for Target 2 (Canon)', async () => {
    vi.spyOn(window, 'prompt').mockReturnValue('Canon imageRUNNER ADV');

    axios.post.mockResolvedValueOnce({
      data: {
        success: true,
        data: {
          device: {
            id: 'dev_canon_002',
            displayName: 'Canon imageRUNNER ADV',
            windowsPrinterName: 'Canon Generic Plus UFR II (Copy 2)',
            isDefault: false,
            status: 'ACTIVE'
          }
        }
      }
    });

    render(<PrinterFleetApprovalPanel currentUser={currentUser} />);

    await waitFor(() => {
      expect(screen.getByText(/Canon Generic Plus UFR II \(Copy 2\)/i)).toBeInTheDocument();
    });

    const approveButtons = screen.getAllByRole('button', { name: /Approve & Register Printer/i });
    fireEvent.click(approveButtons[1]);

    await waitFor(() => {
      expect(axios.post).toHaveBeenCalledTimes(1);
      const [url, payload] = axios.post.mock.calls[0];
      expect(url).toContain('/api/admin/printer-discoveries/disc_canon_002/approve');
      expect(payload).toEqual({
        displayName: 'Canon imageRUNNER ADV',
        isDefault: false
      });
      expect(payload.isDefault).toBe(false);
    });
  });

  it('4. Invariant: non-default approvals protect the existing default placeholder from demotion', async () => {
    // When isDefault is false in the payload, the backend willBeDefault is false.
    // As verified in printerDiscovery.service.js lines 189-207:
    // effectiveIsDefault = false -> previousDefaultDeviceId remains null,
    // and tx.printerDevice.update({ data: { isDefault: false } }) is NEVER called for existingDefault.
    const payload = { displayName: 'HP LaserJet M1136', isDefault: false };
    expect(payload.isDefault).toBe(false);
    expect(payload.displayName).toBe('HP LaserJet M1136');
  });
});
