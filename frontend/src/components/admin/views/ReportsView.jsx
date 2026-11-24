import React, { useState } from 'react';
import { Download, FileText, Calendar, DollarSign, RotateCcw, Receipt, Printer } from 'lucide-react';
import axios from 'axios';

const API_URL = import.meta.env.VITE_API_URL || '';

export const ReportsView = ({ period }) => {
  const [downloading, setDownloading] = useState('');

  const reportCards = [
    { id: 'sales', title: 'Daily Business & Print Value Report', desc: 'Actual collections, non-cash Service Value, completed print value and order count.', icon: DollarSign, color: '#059669', bg: '#ecfdf5' },
    { id: 'jobs', title: 'Complete Print Jobs Register', desc: 'All print jobs with machine names, pages, duplex settings, and status.', icon: FileText, color: '#4f46e5', bg: '#eef2ff' },
    { id: 'payments', title: 'Payments & Service Value Register', desc: 'Actual payment records and separately identified non-cash Service Value entries.', icon: DollarSign, color: '#d97706', bg: '#fffbeb' },
    { id: 'refunds', title: 'Refunds & Recovery Ledger', desc: 'Gateway refund references, refund amounts, reasons, and timestamps.', icon: RotateCcw, color: '#dc2626', bg: '#fef2f2' },
    { id: 'invoices', title: 'Statutory GST Invoices Register', desc: 'Tax invoice numbers, taxable values, CGST, SGST, and total amounts.', icon: Receipt, color: '#7c3aed', bg: '#f5f3ff' },
  ];

  const handleDownload = async (type) => {
    setDownloading(type);
    try {
      const token = localStorage.getItem('adminToken');
      const res = await axios.get(`${API_URL}/api/admin/reports/${type}/export?period=${period}`, {
        responseType: 'blob',
        headers: { Authorization: `Bearer ${token}` }
      });
      const url = window.URL.createObjectURL(new Blob([res.data]));
      const link = document.createElement('a');
      link.href = url;
      link.setAttribute('download', `printgo_${type}_report_${period}_${Date.now()}.csv`);
      document.body.appendChild(link);
      link.click();
      link.remove();
    } catch (e) {
      alert('Failed to generate export: ' + (e.response?.data?.error || e.message));
    } finally {
      setDownloading('');
    }
  };

  return (
    <div>
      <div style={{ marginBottom: '1.5rem' }}>
        <h3 style={{ margin: 0, fontSize: '1.125rem', fontWeight: 700, color: '#0f172a' }}>
          Data Export & Audit Reports Center
        </h3>
        <p style={{ margin: '4px 0 0', fontSize: '0.8125rem', color: '#64748b' }}>
          Download itemized CSV reports showing completed print value separately from actual cash/online collections. Current period filter: <strong>{period}</strong>.
        </p>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '1.25rem' }}>
        {reportCards.map(c => {
          const Icon = c.icon;
          const isBusy = downloading === c.id;
          return (
            <div key={c.id} className="admin-kpi-card" style={{ justifyContent: 'space-between' }}>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.75rem' }}>
                  <div style={{ background: c.bg, padding: '8px', borderRadius: '8px' }}>
                    <Icon size={20} color={c.color} />
                  </div>
                  <h4 style={{ margin: 0, fontSize: '0.9375rem', fontWeight: 600, color: '#0f172a' }}>
                    {c.title}
                  </h4>
                </div>
                <p style={{ fontSize: '0.8125rem', color: '#64748b', margin: '0 0 1rem' }}>
                  {c.desc}
                </p>
              </div>

              <button
                onClick={() => handleDownload(c.id)}
                disabled={isBusy}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '0.5rem',
                  padding: '0.5rem 1rem',
                  background: isBusy ? '#94a3b8' : '#ffffff',
                  color: isBusy ? '#ffffff' : '#0f172a',
                  border: '1px solid #cbd5e1',
                  borderRadius: '6px',
                  fontWeight: 600,
                  fontSize: '0.8125rem',
                  cursor: isBusy ? 'wait' : 'pointer'
                }}
              >
                <Download size={14} />
                {isBusy ? 'Generating CSV...' : 'Export to CSV'}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
};
