import React, { useState } from 'react';
import axios from 'axios';
import { FileText, Receipt, Download, Search, CheckCircle, RotateCcw } from 'lucide-react';
import { getApiUrl } from '../../../utils/apiConfig';

const API_URL = getApiUrl();

export const InvoicesView = ({ invoices, creditNotes, onRefresh }) => {
  const [activeTab, setActiveTab] = useState('invoices'); // 'invoices' | 'creditNotes'
  const [search, setSearch] = useState('');
  const [downloadingId, setDownloadingId] = useState(null);
  const [downloadError, setDownloadError] = useState('');

  const handleDownloadInvoicePdf = async (shortId, invoiceNumber) => {
    if (!shortId || downloadingId) return;
    setDownloadingId(shortId);
    setDownloadError('');
    try {
      const response = await axios.get(
        `${API_URL}/api/jobs/${encodeURIComponent(shortId)}/invoice/download`,
        { responseType: 'blob' }
      );
      const blob = new Blob([response.data], { type: 'application/pdf' });
      const blobUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = blobUrl;
      link.download = `${invoiceNumber || `Invoice_${shortId}`}.pdf`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
    } catch (err) {
      console.error('Admin invoice PDF download failed:', err);
      setDownloadError('Unable to download invoice PDF. Please verify you are signed in and try again.');
    } finally {
      setDownloadingId(null);
    }
  };

  const filteredInvoices = (invoices || []).filter(inv => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      inv.invoiceNumber.toLowerCase().includes(q) ||
      (inv.sellerName && inv.sellerName.toLowerCase().includes(q)) ||
      (inv.buyerPhone && inv.buyerPhone.includes(q)) ||
      (inv.printJob?.shortId && inv.printJob.shortId.toLowerCase().includes(q))
    );
  });

  const filteredCreditNotes = (creditNotes || []).filter(cn => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      cn.creditNoteNumber.toLowerCase().includes(q) ||
      (cn.invoice?.invoiceNumber && cn.invoice.invoiceNumber.toLowerCase().includes(q)) ||
      (cn.reason && cn.reason.toLowerCase().includes(q))
    );
  });

  return (
    <div>
      {downloadError && (
        <div style={{ marginBottom: '0.75rem', padding: '0.6rem 0.9rem', borderRadius: '8px', background: '#fef2f2', color: '#dc2626', fontSize: '0.82rem', border: '1px solid #fecaca' }}>
          {downloadError}
        </div>
      )}
      {/* Tab Selector */}
      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem', borderBottom: '1px solid #e2e8f0', paddingBottom: '0.5rem' }}>
        <button
          onClick={() => setActiveTab('invoices')}
          style={{
            padding: '0.5rem 1rem',
            border: 'none',
            borderRadius: '6px',
            fontWeight: 600,
            fontSize: '0.875rem',
            cursor: 'pointer',
            background: activeTab === 'invoices' ? '#4f46e5' : 'transparent',
            color: activeTab === 'invoices' ? '#ffffff' : '#64748b'
          }}
        >
          📄 Tax Invoices ({invoices?.length || 0})
        </button>
        <button
          onClick={() => setActiveTab('creditNotes')}
          style={{
            padding: '0.5rem 1rem',
            border: 'none',
            borderRadius: '6px',
            fontWeight: 600,
            fontSize: '0.875rem',
            cursor: 'pointer',
            background: activeTab === 'creditNotes' ? '#4f46e5' : 'transparent',
            color: activeTab === 'creditNotes' ? '#ffffff' : '#64748b'
          }}
        >
          🔄 Statutory Credit Notes ({creditNotes?.length || 0})
        </button>
      </div>

      <div className="admin-filter-bar">
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flex: 1, maxWidth: 400 }}>
          <Search size={16} color="#94a3b8" />
          <input
            type="text"
            className="admin-input"
            placeholder={activeTab === 'invoices' ? "Search Invoice Number, Phone, Job ID..." : "Search Credit Note Number, Invoice..."}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ width: '100%' }}
          />
        </div>
      </div>

      {activeTab === 'invoices' ? (
        <div className="admin-table-container">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Invoice Number</th>
                <th>Job ID</th>
                <th>Customer / Phone</th>
                <th>Taxable (₹)</th>
                <th>GST (₹)</th>
                <th>Total Amount</th>
                <th>Status</th>
                <th>Issued Date</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {filteredInvoices.length === 0 ? (
                <tr>
                  <td colSpan={9} style={{ textAlign: 'center', padding: '3rem', color: '#94a3b8' }}>
                    No tax invoices found.
                  </td>
                </tr>
              ) : (
                filteredInvoices.map(inv => (
                  <tr key={inv.id}>
                    <td>
                      <span style={{ fontWeight: 600, color: '#0f172a' }}>{inv.invoiceNumber}</span>
                      {inv.isDemo && (
                        <span style={{ display: 'block', fontSize: '0.625rem', color: '#d97706', fontWeight: 600 }}>
                          SIMULATED RECEIPT
                        </span>
                      )}
                    </td>
                    <td>
                      <span style={{ fontFamily: 'monospace', color: '#4f46e5' }}>
                        #{inv.printJob?.shortId || 'N/A'}
                      </span>
                    </td>
                    <td style={{ fontSize: '0.8125rem', color: '#475569' }}>
                      {inv.buyerPhone || inv.buyerName || 'Walk-in Customer'}
                    </td>
                    <td>₹{inv.taxableAmount}</td>
                    <td>
                      <span style={{ fontSize: '0.75rem', color: '#64748b' }}>
                        CGST: ₹{inv.cgstAmount} | SGST: ₹{inv.sgstAmount}
                      </span>
                    </td>
                    <td>
                      <span style={{ fontWeight: 700, color: '#0f172a' }}>₹{inv.totalAmount}</span>
                    </td>
                    <td>
                      <span style={{
                        padding: '2px 8px',
                        borderRadius: '9999px',
                        fontSize: '0.75rem',
                        fontWeight: 600,
                        background: inv.status === 'ISSUED' ? '#ecfdf5' : '#fef2f2',
                        color: inv.status === 'ISSUED' ? '#059669' : '#dc2626'
                      }}>
                        {inv.status}
                      </span>
                    </td>
                    <td style={{ fontSize: '0.75rem', color: '#64748b', whiteSpace: 'nowrap' }}>
                      {new Date(inv.issuedAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}
                    </td>
                    <td>
                      {inv.printJob?.shortId && (
                        <button
                          type="button"
                          onClick={() => handleDownloadInvoicePdf(inv.printJob.shortId, inv.invoiceNumber)}
                          disabled={downloadingId === inv.printJob.shortId}
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '4px',
                            padding: '4px 8px',
                            background: '#f1f5f9',
                            border: '1px solid #cbd5e1',
                            borderRadius: '6px',
                            color: '#334155',
                            fontSize: '0.75rem',
                            fontWeight: 500,
                            cursor: downloadingId === inv.printJob.shortId ? 'wait' : 'pointer',
                            opacity: downloadingId === inv.printJob.shortId ? 0.6 : 1,
                          }}
                        >
                          <Download size={12} /> {downloadingId === inv.printJob.shortId ? 'Downloading...' : 'PDF'}
                        </button>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="admin-table-container">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Credit Note Number</th>
                <th>Original Invoice</th>
                <th>Refund Reference</th>
                <th>Credit Amount</th>
                <th>Tax Adjusted</th>
                <th>Reason</th>
                <th>Issued At</th>
              </tr>
            </thead>
            <tbody>
              {filteredCreditNotes.length === 0 ? (
                <tr>
                  <td colSpan={7} style={{ textAlign: 'center', padding: '3rem', color: '#94a3b8' }}>
                    No statutory credit notes found.
                  </td>
                </tr>
              ) : (
                filteredCreditNotes.map(cn => (
                  <tr key={cn.id}>
                    <td>
                      <span style={{ fontWeight: 600, color: '#dc2626' }}>{cn.creditNoteNumber}</span>
                    </td>
                    <td>
                      <span style={{ fontWeight: 600, color: '#4f46e5' }}>
                        {cn.invoice?.invoiceNumber || 'N/A'}
                      </span>
                    </td>
                    <td>
                      <span style={{ fontFamily: 'monospace', fontSize: '0.75rem', color: '#475569' }}>
                        {cn.refund?.gatewayRefundId || cn.refundId || 'N/A'}
                      </span>
                    </td>
                    <td>
                      <span style={{ fontWeight: 700, color: '#dc2626' }}>-₹{cn.totalAmount}</span>
                    </td>
                    <td style={{ fontSize: '0.75rem', color: '#64748b' }}>
                      CGST: -₹{cn.cgstAmount} | SGST: -₹{cn.sgstAmount}
                    </td>
                    <td style={{ fontSize: '0.8125rem', color: '#475569' }}>
                      {cn.reason}
                    </td>
                    <td style={{ fontSize: '0.75rem', color: '#64748b', whiteSpace: 'nowrap' }}>
                      {new Date(cn.issuedAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
