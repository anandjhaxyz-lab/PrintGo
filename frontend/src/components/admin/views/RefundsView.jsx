import React, { useState } from 'react';
import { RotateCcw, AlertTriangle, CheckCircle2, Search, PlusCircle, X, ShieldAlert } from 'lucide-react';

export const RefundsView = ({ refunds, onInitiateRefund, isSuperadmin }) => {
  const [search, setSearch] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [paymentId, setPaymentId] = useState('');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [successMsg, setSuccessMsg] = useState('');

  const filtered = (refunds || []).filter(r => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      r.id.toLowerCase().includes(q) ||
      (r.gatewayRefundId && r.gatewayRefundId.toLowerCase().includes(q)) ||
      r.paymentId.toLowerCase().includes(q) ||
      (r.reason && r.reason.toLowerCase().includes(q))
    );
  });

  const handleRefundSubmit = async (e) => {
    e.preventDefault();
    setErrorMsg('');
    setSuccessMsg('');

    if (!paymentId) return setErrorMsg('Payment ID is required');
    if (!amount || Number(amount) <= 0) return setErrorMsg('A valid refund amount > 0 is required');
    if (!reason || reason.trim().length < 3) return setErrorMsg('Please provide a reason for the refund (minimum 3 characters)');
    if (!confirmed) return setErrorMsg('Please check the confirmation box to authorize this financial refund');

    setIsSubmitting(true);
    try {
      await onInitiateRefund({
        paymentId: paymentId.trim(),
        amount: Number(amount),
        reason: reason.trim(),
        idempotencyKey: `idem_ref_${Date.now()}`
      });
      setSuccessMsg('Refund initiated and processed successfully!');
      setTimeout(() => {
        setShowModal(false);
        setPaymentId('');
        setAmount('');
        setReason('');
        setConfirmed(false);
        setSuccessMsg('');
      }, 1500);
    } catch (err) {
      setErrorMsg(err.response?.data?.error || err.message || 'Refund processing failed');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div>
      <div className="admin-filter-bar" style={{ justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flex: 1, maxWidth: 400 }}>
          <Search size={16} color="#94a3b8" />
          <input
            type="text"
            className="admin-input"
            placeholder="Search Refund ID, Payment UUID, Reason..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ width: '100%' }}
          />
        </div>

        {isSuperadmin && (
          <button
            onClick={() => setShowModal(true)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.375rem',
              padding: '0.5rem 1rem',
              background: '#4f46e5',
              color: '#ffffff',
              borderRadius: '8px',
              border: 'none',
              fontWeight: 600,
              fontSize: '0.8125rem',
              cursor: 'pointer'
            }}
          >
            <PlusCircle size={16} /> Initiate Customer Refund
          </button>
        )}
      </div>

      <div className="admin-table-container">
        <table className="admin-table">
          <thead>
            <tr>
              <th>Refund ID</th>
              <th>Gateway Ref</th>
              <th>Payment ID</th>
              <th>Amount</th>
              <th>Status</th>
              <th>Reason</th>
              <th>Issued At</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={7} style={{ textAlign: 'center', padding: '3rem', color: '#94a3b8' }}>
                  No refund transactions recorded.
                </td>
              </tr>
            ) : (
              filtered.map(r => (
                <tr key={r.id}>
                  <td>
                    <span style={{ fontFamily: 'monospace', fontSize: '0.75rem', color: '#475569' }}>
                      {r.id.slice(0, 13)}...
                    </span>
                  </td>
                  <td>
                    <span style={{ fontWeight: 600, color: '#0f172a' }}>{r.gatewayRefundId || r.cfRefundId || 'N/A'}</span>
                  </td>
                  <td>
                    <span style={{ fontFamily: 'monospace', fontSize: '0.75rem', color: '#64748b' }}>
                      {r.paymentId.slice(0, 13)}...
                    </span>
                  </td>
                  <td>
                    <span style={{ fontWeight: 700, color: '#dc2626' }}>-₹{r.amount}</span>
                  </td>
                  <td>
                    <span style={{
                      padding: '2px 8px',
                      borderRadius: '9999px',
                      fontSize: '0.75rem',
                      fontWeight: 600,
                      background: r.status === 'SUCCESS' ? '#ecfdf5' : (r.status === 'PROCESSING' ? '#fef3c7' : '#fef2f2'),
                      color: r.status === 'SUCCESS' ? '#059669' : (r.status === 'PROCESSING' ? '#d97706' : '#dc2626')
                    }}>
                      {r.status}
                    </span>
                  </td>
                  <td style={{ fontSize: '0.8125rem', color: '#475569' }}>
                    {r.reason || 'Customer requested'}
                  </td>
                  <td style={{ fontSize: '0.75rem', color: '#64748b', whiteSpace: 'nowrap' }}>
                    {new Date(r.createdAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Initiate Refund Modal */}
      {showModal && (
        <div className="admin-modal-backdrop" onClick={() => setShowModal(false)}>
          <div className="admin-modal-card" onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem', borderBottom: '1px solid #e2e8f0', paddingBottom: '0.75rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <RotateCcw size={20} color="#dc2626" />
                <h3 style={{ margin: 0, fontSize: '1.125rem', fontWeight: 700 }}>Initiate Customer Refund</h3>
              </div>
              <button onClick={() => setShowModal(false)} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: '#64748b' }}>
                <X size={20} />
              </button>
            </div>

            <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: '8px', padding: '0.75rem', marginBottom: '1rem', display: 'flex', gap: '0.5rem' }}>
              <ShieldAlert size={20} color="#dc2626" style={{ flexShrink: 0 }} />
              <div style={{ fontSize: '0.8125rem', color: '#991b1b' }}>
                <strong>Financial Warning:</strong> A refund transfers money back to the customer's payment method via Cashfree and automatically issues a statutory GST Credit Note. Simulated demo payments cannot be refunded.
              </div>
            </div>

            {errorMsg && (
              <div style={{ background: '#fee2e2', color: '#b91c1c', padding: '0.625rem', borderRadius: '6px', fontSize: '0.8125rem', marginBottom: '1rem' }}>
                {errorMsg}
              </div>
            )}

            {successMsg && (
              <div style={{ background: '#dcfce7', color: '#15803d', padding: '0.625rem', borderRadius: '6px', fontSize: '0.8125rem', marginBottom: '1rem' }}>
                {successMsg}
              </div>
            )}

            <form onSubmit={handleRefundSubmit}>
              <div style={{ marginBottom: '1rem' }}>
                <label style={{ display: 'block', fontSize: '0.8125rem', fontWeight: 600, color: '#334155', marginBottom: '4px' }}>
                  Target Payment UUID *
                </label>
                <input
                  type="text"
                  className="admin-input"
                  style={{ width: '100%' }}
                  placeholder="e.g. 7f91... or full payment UUID"
                  value={paymentId}
                  onChange={(e) => setPaymentId(e.target.value)}
                  required
                />
              </div>

              <div style={{ marginBottom: '1rem' }}>
                <label style={{ display: 'block', fontSize: '0.8125rem', fontWeight: 600, color: '#334155', marginBottom: '4px' }}>
                  Refund Amount (₹ INR) *
                </label>
                <input
                  type="number"
                  step="0.01"
                  min="0.01"
                  className="admin-input"
                  style={{ width: '100%' }}
                  placeholder="e.g. 25.00"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  required
                />
              </div>

              <div style={{ marginBottom: '1rem' }}>
                <label style={{ display: 'block', fontSize: '0.8125rem', fontWeight: 600, color: '#334155', marginBottom: '4px' }}>
                  Reason for Refund *
                </label>
                <input
                  type="text"
                  className="admin-input"
                  style={{ width: '100%' }}
                  placeholder="e.g. Paper jam during print, Customer cancelled"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  required
                />
              </div>

              <div style={{ marginBottom: '1.25rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <input
                  type="checkbox"
                  id="confirmBox"
                  checked={confirmed}
                  onChange={(e) => setConfirmed(e.target.checked)}
                  style={{ width: 16, height: 16, cursor: 'pointer' }}
                />
                <label htmlFor="confirmBox" style={{ fontSize: '0.8125rem', color: '#334155', cursor: 'pointer' }}>
                  I confirm this customer refund and authorize statutory Credit Note creation.
                </label>
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem' }}>
                <button
                  type="button"
                  className="btn"
                  onClick={() => setShowModal(false)}
                  style={{ fontSize: '0.8125rem' }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting || !confirmed}
                  style={{
                    padding: '0.5rem 1rem',
                    background: confirmed ? '#dc2626' : '#94a3b8',
                    color: '#ffffff',
                    border: 'none',
                    borderRadius: '6px',
                    fontWeight: 600,
                    fontSize: '0.8125rem',
                    cursor: confirmed ? 'pointer' : 'not-allowed'
                  }}
                >
                  {isSubmitting ? 'Processing Refund...' : 'Authorize Refund'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
