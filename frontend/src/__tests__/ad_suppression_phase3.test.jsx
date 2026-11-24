import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import axios from 'axios';
import { AdvertisementDisplay } from '../components/AdvertisementDisplay';
import { PrinterAdSuppressionModal } from '../components/admin/views/PrinterAdSuppressionModal';
import { PrintersView } from '../components/admin/views/PrintersView';
import { AdvertisementsView } from '../components/admin/views/AdvertisementsView';

// Mock axios
vi.mock('axios', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn()
  }
}));

describe('PrintGo Advertisement System — Phase 3 Frontend Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn();
  });

  // =========================================================================
  // 1. ADVERTISEMENT DISPLAY COMPONENT
  // =========================================================================
  describe('1. AdvertisementDisplay Component', () => {
    it('1.1 Renders image advertisement correctly with title and media URL', () => {
      const mockAds = [
        {
          id: 'ad-1',
          title: 'Color Prints Promo',
          type: 'IMAGE',
          mediaUrl: '/uploads/ads/promo.jpg',
          displayDuration: 5,
          scope: 'GLOBAL',
          placement: 'ALL'
        }
      ];

      render(<AdvertisementDisplay ads={mockAds} />);

      expect(screen.getByText('Color Prints Promo')).toBeInTheDocument();
      const img = screen.getByRole('img');
      expect(img).toHaveAttribute('src', expect.stringContaining('/uploads/ads/promo.jpg'));
    });

    it('1.2 Renders null when advertisement list is empty', () => {
      const { container } = render(<AdvertisementDisplay ads={[]} />);
      expect(container.firstChild).toBeNull();
    });

    it('1.3 Respects suppression: clears ads and triggers onSuppressed callback when backend returns suppressed: true', async () => {
      const onSuppressedMock = vi.fn();
      global.fetch.mockResolvedValue({
        json: async () => ({
          success: true,
          count: 0,
          advertisements: [],
          suppressed: true,
          reason: 'Store meeting'
        })
      });

      const { container } = render(
        <AdvertisementDisplay
          sessionToken="valid-session-jwt"
          placement="KIOSK_ONLY"
          onSuppressed={onSuppressedMock}
        />
      );

      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledWith(
          expect.stringContaining('/api/advertisements/active?placement=KIOSK_ONLY'),
          expect.objectContaining({
            headers: expect.objectContaining({
              Authorization: 'Bearer valid-session-jwt'
            })
          })
        );
      });

      await waitFor(() => {
        expect(onSuppressedMock).toHaveBeenCalledWith('Store meeting');
      });
      expect(container.firstChild).toBeNull();
    });

    it('1.4 Handles fetch network errors gracefully without crashing or throwing', async () => {
      global.fetch.mockRejectedValue(new Error('Network error'));

      const { container } = render(<AdvertisementDisplay placement="MOBILE_ONLY" />);

      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalled();
      });
      expect(container.firstChild).toBeNull();
    });
  });

  // =========================================================================
  // 2. PRINTER AD SUPPRESSION MODAL
  // =========================================================================
  describe('2. PrinterAdSuppressionModal', () => {
    const mockMachine = {
      id: 'm-1',
      name: 'Main Counter Kiosk',
      location: 'Ground Floor Lobby',
      adSuppressionMode: 'ENABLED'
    };

    it('2.1 Renders machine details and modal title', () => {
      render(
        <PrinterAdSuppressionModal
          machine={mockMachine}
          isOpen={true}
          onClose={() => {}}
          onSuccess={() => {}}
        />
      );

      expect(screen.getByText(/Silence Machine Advertisements/i)).toBeInTheDocument();
      expect(screen.getByText(/Main Counter Kiosk/i)).toBeInTheDocument();
    });

    it('2.2 Blocks submission if mandatory operator reason is missing', async () => {
      render(
        <PrinterAdSuppressionModal
          machine={mockMachine}
          isOpen={true}
          onClose={() => {}}
          onSuccess={() => {}}
        />
      );

      const submitBtn = screen.getByRole('button', { name: /Silence Ads/i });
      fireEvent.click(submitBtn);

      expect(screen.getByText(/Operator reason is required/i)).toBeInTheDocument();
      expect(axios.post).not.toHaveBeenCalled();
    });

    it('2.3 Submits temporary suppression with selected preset duration and operator reason', async () => {
      axios.post.mockResolvedValue({
        data: {
          success: true,
          machineId: 'm-1',
          adSuppressionMode: 'TEMPORARY',
          adSuppressionUntil: new Date(Date.now() + 6 * 3600000).toISOString()
        }
      });

      const onSuccessMock = vi.fn();
      const onCloseMock = vi.fn();

      render(
        <PrinterAdSuppressionModal
          machine={mockMachine}
          isOpen={true}
          onClose={onCloseMock}
          onSuccess={onSuccessMock}
        />
      );

      // Select 6 Hours preset
      const preset6hBtn = screen.getByRole('button', { name: /6 Hours/i });
      fireEvent.click(preset6hBtn);

      // Enter operator reason
      const reasonInput = screen.getByPlaceholderText(/Store request for quiet hours/i);
      fireEvent.change(reasonInput, { target: { value: 'Private client presentation' } });

      // Click submit
      const submitBtn = screen.getByRole('button', { name: /Silence Ads/i });
      fireEvent.click(submitBtn);

      await waitFor(() => {
        expect(axios.post).toHaveBeenCalledWith(
          expect.stringContaining('/api/machines/m-1/ad-suppression'),
          expect.objectContaining({
            mode: 'TEMPORARY',
            durationHours: 6,
            reason: 'Private client presentation'
          })
        );
        expect(onSuccessMock).toHaveBeenCalled();
        expect(onCloseMock).toHaveBeenCalled();
      });
    });

    it('2.4 Displays clear error message when ADMIN_READ_ONLY=true blocks mutation', async () => {
      axios.post.mockRejectedValue({
        response: {
          status: 403,
          data: {
            success: false,
            error: 'Forbidden: Cloud Admin Dashboard is operating in Read-Only Monitoring Mode. Remote mutations are disabled.'
          }
        }
      });

      render(
        <PrinterAdSuppressionModal
          machine={mockMachine}
          isOpen={true}
          onClose={() => {}}
          onSuccess={() => {}}
        />
      );

      const reasonInput = screen.getByPlaceholderText(/Store request for quiet hours/i);
      fireEvent.change(reasonInput, { target: { value: 'Attempting silence' } });

      const submitBtn = screen.getByRole('button', { name: /Silence Ads/i });
      fireEvent.click(submitBtn);

      await waitFor(() => {
        expect(screen.getByText(/operating in Read-Only Monitoring Mode/i)).toBeInTheDocument();
      });
    });

    it('2.5 In Permanent mode, enforces explicit confirmation checkbox before submitting', async () => {
      render(
        <PrinterAdSuppressionModal
          machine={mockMachine}
          isOpen={true}
          onClose={() => {}}
          onSuccess={() => {}}
        />
      );

      // Switch to Permanent tab
      const permTab = screen.getByRole('button', { name: /Permanent Silence/i });
      fireEvent.click(permTab);

      // Enter reason
      const reasonInput = screen.getByPlaceholderText(/Store request for quiet hours/i);
      fireEvent.change(reasonInput, { target: { value: 'Store owner policy' } });

      // Attempt submit without checking confirmation box
      const submitBtn = screen.getByRole('button', { name: /Silence Permanently/i });
      fireEvent.click(submitBtn);

      expect(screen.getByText(/Please check the confirmation box to permanently disable advertisements/i)).toBeInTheDocument();
      expect(axios.post).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // 3. PRINTERS VIEW ADVERTISEMENT STATUS & RESUME CONTROLS
  // =========================================================================
  describe('3. PrintersView Advertisement Controls', () => {
    it('3.1 Displays "ADS ACTIVE" badge when machine advertisement suppression is ENABLED', () => {
      const machines = [
        {
          id: 'm-enabled',
          name: 'Front Kiosk',
          adSuppressionMode: 'ENABLED',
          companyId: 'comp-1'
        }
      ];

      render(
        <PrintersView
          machines={machines}
          currentUser={{ id: 'admin-1', role: 'SUPERADMIN' }}
        />
      );

      expect(screen.getByText(/ADS ACTIVE/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Silence Advertisements/i })).toBeInTheDocument();
    });

    it('3.2 Displays "TEMPORARILY SILENCED" and remaining countdown for temporary suppression', () => {
      const future = new Date(Date.now() + 7200000).toISOString(); // 2 hours
      const machines = [
        {
          id: 'm-temp',
          name: 'Conference Kiosk',
          adSuppressionMode: 'TEMPORARY',
          adSuppressionUntil: future,
          adSuppressionReason: 'Client meeting',
          companyId: 'comp-1'
        }
      ];

      render(
        <PrintersView
          machines={machines}
          currentUser={{ id: 'admin-1', role: 'SUPERADMIN' }}
        />
      );

      expect(screen.getByText(/TEMPORARILY SILENCED/i)).toBeInTheDocument();
      expect(screen.getByText(/Countdown:/i)).toBeInTheDocument();
      expect(screen.getByText(/Reason: Client meeting/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Resume Advertisements/i })).toBeInTheDocument();
    });

    it('3.3 Calls DELETE /api/machines/:id/ad-suppression when Resume Advertisements is clicked and confirmed', async () => {
      window.confirm = vi.fn(() => true);
      axios.delete.mockResolvedValue({
        data: {
          success: true,
          message: 'Advertisements resumed successfully'
        }
      });

      const onRefreshMock = vi.fn();
      const machines = [
        {
          id: 'm-resume',
          name: 'Quiet Kiosk',
          adSuppressionMode: 'PERMANENT',
          adSuppressionReason: 'Store quiet hours',
          companyId: 'comp-1'
        }
      ];

      render(
        <PrintersView
          machines={machines}
          currentUser={{ id: 'admin-1', role: 'SUPERADMIN' }}
          onRefresh={onRefreshMock}
        />
      );

      const resumeBtn = screen.getByRole('button', { name: /Resume Advertisements/i });
      fireEvent.click(resumeBtn);

      expect(window.confirm).toHaveBeenCalled();
      await waitFor(() => {
        expect(axios.delete).toHaveBeenCalledWith(
          expect.stringContaining('/api/machines/m-resume/ad-suppression')
        );
        expect(onRefreshMock).toHaveBeenCalled();
      });
    });
  });

  // =========================================================================
  // 4. ADVERTISEMENTS VIEW (MANAGEMENT UI & SCOPE RESTRICTIONS)
  // =========================================================================
  describe('4. AdvertisementsView Management & Authorization', () => {
    it('4.1 Allows SUPERADMIN to choose between Fleet Global and Machine-Specific scope', async () => {
      axios.get.mockImplementation((url) => {
        if (url.includes('/api/advertisements/admin/all')) {
          return Promise.resolve({ data: { success: true, advertisements: [] } });
        }
        if (url.includes('/api/machines')) {
          return Promise.resolve({
            data: {
              success: true,
              machines: [{ id: 'm-1', name: 'Kiosk 1', location: 'Hall' }]
            }
          });
        }
        return Promise.resolve({ data: {} });
      });

      render(<AdvertisementsView isSuperadmin={true} />);

      const addBtn = screen.getByRole('button', { name: /Add Advertisement/i });
      fireEvent.click(addBtn);

      const globalBtn = screen.getByRole('button', { name: /Fleet Global/i });
      const machineBtn = screen.getByRole('button', { name: /Machine-Specific/i });

      expect(globalBtn).not.toBeDisabled();
      expect(machineBtn).not.toBeDisabled();
    });

    it('4.2 Restricts FRANCHISEE from selecting Global scope (locked to Machine-Specific)', async () => {
      axios.get.mockImplementation((url) => {
        if (url.includes('/api/advertisements/admin/all')) {
          return Promise.resolve({ data: { success: true, advertisements: [] } });
        }
        if (url.includes('/api/machines/my-machines')) {
          return Promise.resolve({
            data: {
              success: true,
              machines: [{ id: 'm-own', name: 'My Franchise Kiosk', location: 'Branch A' }]
            }
          });
        }
        return Promise.resolve({ data: {} });
      });

      render(<AdvertisementsView isSuperadmin={false} />);

      const addBtn = screen.getByRole('button', { name: /Add Advertisement/i });
      fireEvent.click(addBtn);

      const globalBtn = screen.getByRole('button', { name: /Fleet Global/i });
      expect(globalBtn).toBeDisabled();
      expect(screen.getByText(/Franchisees manage advertisements targeted to their assigned kiosks/i)).toBeInTheDocument();
    });

    it('4.3 Displays Scope and Placement badges in the advertisements table', async () => {
      const mockAds = [
        {
          id: 'ad-glob',
          title: 'Mega Summer Sale',
          type: 'IMAGE',
          mediaUrl: '/uploads/ads/sale.jpg',
          scope: 'GLOBAL',
          placement: 'ALL',
          isActive: true
        },
        {
          id: 'ad-mach',
          title: 'Campus Printing Deal',
          type: 'VIDEO',
          mediaUrl: '/uploads/ads/campus.mp4',
          scope: 'MACHINE_SPECIFIC',
          placement: 'KIOSK_ONLY',
          machineId: 'm-1',
          machine: { id: 'm-1', name: 'Library Kiosk' },
          isActive: true
        }
      ];

      axios.get.mockImplementation((url) => {
        if (url.includes('/api/advertisements/admin/all')) {
          return Promise.resolve({ data: { success: true, advertisements: mockAds } });
        }
        return Promise.resolve({ data: { success: true, machines: [] } });
      });

      render(<AdvertisementsView isSuperadmin={true} />);

      await waitFor(() => {
        expect(screen.getByText('Mega Summer Sale')).toBeInTheDocument();
        expect(screen.getByText('Campus Printing Deal')).toBeInTheDocument();
      });

      // Scope badges
      expect(screen.getByText(/Fleet Global/i)).toBeInTheDocument();
      expect(screen.getByText(/Library Kiosk/i)).toBeInTheDocument();

      // Placement badges
      expect(screen.getAllByText(/All Screens/i).length).toBeGreaterThan(0);
      expect(screen.getAllByText(/Kiosk Only/i).length).toBeGreaterThan(0);
    });
  });
});
