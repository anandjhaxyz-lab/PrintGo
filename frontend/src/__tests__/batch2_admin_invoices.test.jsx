import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import axios from 'axios';
import { InvoicesView } from '../components/admin/views/InvoicesView';

vi.mock('axios', () => ({
  default: {
    get: vi.fn(),
  },
}));

describe('S3K Batch 2 - Admin InvoicesView Authenticated PDF Download', () => {
  beforeEach(() => {
    axios.get.mockReset();
    URL.createObjectURL = vi.fn(() => 'blob:http://localhost/admin-invoice-pdf');
    URL.revokeObjectURL = vi.fn();
  });

  it('Downloads invoice PDF using authenticated axios blob request instead of raw unauthenticated link', async () => {
    axios.get.mockResolvedValue({ data: new Uint8Array([37, 80, 68, 70]) });

    const sampleInvoices = [
      {
        id: 'inv-1',
        invoiceNumber: 'INV-2026-0042',
        sellerName: 'Spurti Communications',
        buyerPhone: null,
        subtotal: 8,
        cgstAmount: 0,
        sgstAmount: 0,
        totalTax: 0,
        totalAmount: 8,
        status: 'ISSUED',
        issuedAt: new Date().toISOString(),
        printJob: { shortId: 'job042' },
      },
    ];

    render(<InvoicesView invoices={sampleInvoices} creditNotes={[]} onRefresh={() => {}} />);

    // Must render a button, NOT an <a href=".../invoice/download">
    expect(document.querySelector('a[href*="/invoice/download"]')).toBeNull();
    const pdfBtn = screen.getByRole('button', { name: /PDF/i });
    fireEvent.click(pdfBtn);

    await waitFor(() =>
      expect(axios.get).toHaveBeenCalledWith(
        expect.stringContaining('/api/jobs/job042/invoice/download'),
        { responseType: 'blob' }
      )
    );
  });

  it('Shows clear inline error when authenticated admin invoice download fails', async () => {
    axios.get.mockRejectedValue(new Error('401 Unauthorized'));

    const sampleInvoices = [
      {
        id: 'inv-2',
        invoiceNumber: 'INV-2026-0099',
        sellerName: 'Spurti Communications',
        subtotal: 5,
        cgstAmount: 0,
        sgstAmount: 0,
        totalTax: 0,
        totalAmount: 5,
        status: 'ISSUED',
        issuedAt: new Date().toISOString(),
        printJob: { shortId: 'job099' },
      },
    ];

    render(<InvoicesView invoices={sampleInvoices} creditNotes={[]} onRefresh={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /PDF/i }));

    await waitFor(() =>
      expect(screen.getByText(/Unable to download invoice PDF/i)).toBeInTheDocument()
    );
  });
});
