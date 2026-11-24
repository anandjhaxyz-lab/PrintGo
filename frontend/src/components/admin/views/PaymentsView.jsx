import React, { useState } from 'react';
import { Search, CreditCard, ShieldCheck, AlertCircle, RefreshCw } from 'lucide-react';

export const PaymentsView = ({ payments, isLoading, onRefresh }) => {
  const [search, setSearch] = useState('');
  const [methodFilter, setMethodFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  const filtered = (payments || []).filter(p => {
    if (search) {
      const q = search.toLowerCase();
      const matchOrder = p.gatewayOrderId?.toLowerCase().includes(q);
      const matchPayId = p.id.toLowerCase().includes(q);
      const matchJob = p.printJobs?.some(j => j.shortId?.toLowerCase().includes(q));
      if (!matchOrder && !matchPayId && !matchJob) return false;
    }
    if (methodFilter) {
      if (methodFilter === 'demo' && !p.isDemo) return false;
      if (methodFilter !== 'demo' && (p.isDemo || p.paymentMethod !== methodFilter)) return false;
    }
    if (statusFilter && p.status !== statusFilter) return false;
    return true;
  });

  return (
    <div>
      <div className="admin-filter-bar">
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flex: 1, minWidth: 200 }}>
          <Search size={16} color="#94a3b8" />
          <input
            type="text"
            className="admin-input"
            placeholder="Search Gateway Order ID, Payment UUID, Job..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ width: '100%' }}
          />
        </div>

        <select className="admin-input" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="">All Statuses</option>
          <option value="SUCCESS">SUCCESS</option>
          <option value="PENDING">PENDING</option>
          <option value="FAILED">FAILED</option>
          <option value="REFUNDED">REFUNDED</option>
          <option value="PARTIALLY_REFUNDED">PARTIALLY_REFUNDED</option>
        </select>

        <select className="admin-input" value={methodFilter} onChange={(e) => setMethodFilter(e.target.value)}>
          <option value="">All Payment Types</option>
          <option value="upi">UPI (Cashfree)</option>
          <option value="card">Card (Cashfree)</option>
          <option value="demo">Service Value</option>
        </select>
      </div>

      <div className="admin-table-container">
        <table className="admin-table">
          <thead>
            <tr>
              <th>Payment ID</th>
              <th>Gateway Order ID</th>
              <th>Amount</th>
              <th>Type / Method</th>
              <th>Status</th>
              <th>Associated Jobs</th>
              <th>Timestamp</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={7} style={{ textAlign: 'center', padding: '3rem', color: '#94a3b8' }}>
                  No payment records found.
                </td>
              </tr>
            ) : (
              filtered.map(p => {
                const timeStr = new Date(p.createdAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
                return (
                  <tr key={p.id}>
                    <td>
                      <span style={{ fontFamily: 'monospace', fontSize: '0.75rem', color: '#475569' }}>
                        {p.id.slice(0, 13)}...
                      </span>
                    </td>
                    <td>
                      <span style={{ fontWeight: 600, color: '#0f172a' }}>{p.gatewayOrderId || 'N/A'}</span>
                    </td>
                    <td>
                      <span style={{ fontWeight: 700, color: p.status === 'SUCCESS' ? '#059669' : '#0f172a' }}>
                        ₹{p.amount}
                      </span>
                    </td>
                    <td>
                      {p.isDemo ? (
                        <span style={{
                          padding: '2px 8px',
                          borderRadius: '4px',
                          fontSize: '0.6875rem',
                          fontWeight: 600,
                          background: '#fffbeb',
                          color: '#d97706',
                          border: '1px solid #fde68a'
                        }}>
                          SERVICE VALUE
                        </span>
                      ) : (
                        <span style={{
                          padding: '2px 8px',
                          borderRadius: '4px',
                          fontSize: '0.6875rem',
                          fontWeight: 600,
                          background: p.paymentMethod === 'cash' ? '#ecfdf5' : '#f0f9ff',
                          color: p.paymentMethod === 'cash' ? '#059669' : '#0284c7',
                          border: p.paymentMethod === 'cash' ? '1px solid #a7f3d0' : '1px solid #bae6fd'
                        }}>
                          {p.paymentMethod === 'cash' ? 'CASH AT COUNTER' : `CASHFREE (${p.paymentMethod || 'UPI'})`}
                        </span>
                      )}
                    </td>
                    <td>
                      <span
                        title={p.isDemo ? 'Service Value is a non-cash print-value record, not actual money collected.' : undefined}
                        style={{
                          padding: '2px 8px',
                          borderRadius: '9999px',
                          fontSize: '0.75rem',
                          fontWeight: 600,
                          background: p.isDemo && p.status === 'SUCCESS' ? '#eef2ff' : (p.status === 'SUCCESS' ? '#ecfdf5' : (p.status === 'REFUNDED' ? '#f5f3ff' : '#f1f5f9')),
                          color: p.isDemo && p.status === 'SUCCESS' ? '#4338ca' : (p.status === 'SUCCESS' ? '#059669' : (p.status === 'REFUNDED' ? '#7c3aed' : '#475569'))
                        }}>
                        {p.isDemo && p.status === 'SUCCESS' ? 'RECORDED' : p.status}
                      </span>
                    </td>
                    <td>
                      {p.printJobs && p.printJobs.length > 0 ? (
                        p.printJobs.map(j => (
                          <span key={j.id} style={{ fontSize: '0.75rem', background: '#f1f5f9', padding: '2px 6px', borderRadius: '4px', marginRight: '4px' }}>
                            #{j.shortId}
                          </span>
                        ))
                      ) : (
                        <span style={{ fontSize: '0.75rem', color: '#94a3b8' }}>None</span>
                      )}
                    </td>
                    <td style={{ fontSize: '0.75rem', color: '#64748b', whiteSpace: 'nowrap' }}>
                      {timeStr}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};
