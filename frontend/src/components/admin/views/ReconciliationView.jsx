import React, { useState } from 'react';
import { CheckCircle, AlertTriangle, Play, RefreshCw, X, ShieldAlert } from 'lucide-react';

export const ReconciliationView = ({ 
  records, 
  onRunReconciliation, 
  onResolveDiscrepancy, 
  isSuperadmin 
}) => {
  const [selectedRecord, setSelectedRecord] = useState(null);
  const [resolutionNotes, setResolutionNotes] = useState('');
  const [isRunning, setIsRunning] = useState(false);
  const [dryRun, setDryRun] = useState(false);
  const [msg, setMsg] = useState('');

  const handleRun = async () => {
    setIsRunning(true);
    setMsg('');
    try {
      const res = await onRunReconciliation({ dryRun });
      setMsg(`Reconciliation scan finished. ${res.totalDiscrepancies} items evaluated.`);
      setTimeout(() => setMsg(''), 4000);
    } catch (e) {
      setMsg('Error: ' + (e.response?.data?.error || e.message));
    } finally {
      setIsRunning(false);
    }
  };

  const handleResolve = async (e) => {
    e.preventDefault();
    if (!resolutionNotes || resolutionNotes.trim().length < 5) {
      alert('A valid resolution note explaining the correction is required (minimum 5 characters)');
      return;
    }

    try {
      await onResolveDiscrepancy(selectedRecord.id, resolutionNotes.trim());
      setSelectedRecord(null);
      setResolutionNotes('');
    } catch (e) {
      alert('Failed to resolve: ' + (e.response?.data?.error || e.message));
    }
  };

  return (
    <div>
      <div className="admin-filter-bar" style={{ justifyContent: 'space-between' }}>
        <div>
          <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: 700 }}>Financial Discrepancy Ledger</h3>
          <p style={{ margin: 0, fontSize: '0.75rem', color: '#64748b' }}>
            Automated gateway cross-verification, missing credit notes, and orphan transaction detection.
          </p>
        </div>

        {isSuperadmin && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '0.8125rem', color: '#475569', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={dryRun}
                onChange={(e) => setDryRun(e.target.checked)}
              />
              Dry Run Only
            </label>
            <button
              onClick={handleRun}
              disabled={isRunning}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.375rem',
                padding: '0.5rem 1rem',
                background: '#4f46e5',
                color: '#ffffff',
                border: 'none',
                borderRadius: '8px',
                fontWeight: 600,
                fontSize: '0.8125rem',
                cursor: 'pointer'
              }}
            >
              <Play size={14} className={isRunning ? 'animate-spin' : ''} />
              {isRunning ? 'Scanning Ledger...' : 'Run Reconciliation Engine'}
            </button>
          </div>
        )}
      </div>

      {msg && (
        <div style={{ padding: '0.75rem', borderRadius: '8px', marginBottom: '1rem', fontSize: '0.8125rem', background: msg.startsWith('Error') ? '#fee2e2' : '#eff6ff', color: msg.startsWith('Error') ? '#991b1b' : '#1d4ed8' }}>
          {msg}
        </div>
      )}

      <div className="admin-table-container">
        <table className="admin-table">
          <thead>
            <tr>
              <th>Record ID</th>
              <th>Discrepancy Type</th>
              <th>Status</th>
              <th>Payment ID</th>
              <th>Details</th>
              <th>Resolved</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {!records || records.length === 0 ? (
              <tr>
                <td colSpan={7} style={{ textAlign: 'center', padding: '3rem', color: '#10b981' }}>
                  <CheckCircle size={32} style={{ margin: '0 auto 0.5rem', opacity: 0.8 }} />
                  <div>No open discrepancies found. The financial ledger is reconciled.</div>
                </td>
              </tr>
            ) : (
              records.map(rec => (
                <tr key={rec.id}>
                  <td>
                    <span style={{ fontFamily: 'monospace', fontSize: '0.75rem', color: '#475569' }}>
                      {rec.id.slice(0, 8)}...
                    </span>
                  </td>
                  <td>
                    <span style={{ fontWeight: 600, color: '#dc2626', fontSize: '0.8125rem' }}>
                      {rec.discrepancyType || 'ANOMALY'}
                    </span>
                  </td>
                  <td>
                    <span style={{
                      padding: '2px 8px',
                      borderRadius: '9999px',
                      fontSize: '0.6875rem',
                      fontWeight: 600,
                      background: rec.resolved ? '#ecfdf5' : '#fef2f2',
                      color: rec.resolved ? '#059669' : '#dc2626'
                    }}>
                      {rec.status}
                    </span>
                  </td>
                  <td>
                    <span style={{ fontFamily: 'monospace', fontSize: '0.75rem', color: '#64748b' }}>
                      {rec.paymentId ? `${rec.paymentId.slice(0, 8)}...` : 'N/A'}
                    </span>
                  </td>
                  <td style={{ fontSize: '0.75rem', color: '#475569', maxWidth: 250, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={rec.details}>
                    {rec.details || 'Gateway ledger mismatch'}
                  </td>
                  <td>
                    <span style={{ fontSize: '0.75rem', color: rec.resolved ? '#059669' : '#d97706', fontWeight: 600 }}>
                      {rec.resolved ? 'RESOLVED' : 'OPEN'}
                    </span>
                  </td>
                  <td>
                    {!rec.resolved && isSuperadmin ? (
                      <button
                        onClick={() => setSelectedRecord(rec)}
                        style={{
                          background: '#f1f5f9',
                          border: '1px solid #cbd5e1',
                          borderRadius: '6px',
                          padding: '4px 8px',
                          fontSize: '0.75rem',
                          fontWeight: 500,
                          cursor: 'pointer'
                        }}
                      >
                        Resolve
                      </button>
                    ) : (
                      <span style={{ fontSize: '0.75rem', color: '#94a3b8' }}>—</span>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Resolution Modal */}
      {selectedRecord && (
        <div className="admin-modal-backdrop" onClick={() => setSelectedRecord(null)}>
          <div className="admin-modal-card" onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem', borderBottom: '1px solid #e2e8f0', paddingBottom: '0.75rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <CheckCircle size={20} color="#059669" />
                <h3 style={{ margin: 0, fontSize: '1.125rem', fontWeight: 700 }}>Resolve Ledger Discrepancy</h3>
              </div>
              <button onClick={() => setSelectedRecord(null)} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: '#64748b' }}>
                <X size={20} />
              </button>
            </div>

            <div style={{ background: '#f8fafc', padding: '0.75rem', borderRadius: '8px', marginBottom: '1rem', fontSize: '0.8125rem' }}>
              <div><strong>Discrepancy Type:</strong> {selectedRecord.discrepancyType}</div>
              <div><strong>Status:</strong> {selectedRecord.status}</div>
              <div><strong>Details:</strong> {selectedRecord.details}</div>
            </div>

            <form onSubmit={handleResolve}>
              <div style={{ marginBottom: '1rem' }}>
                <label style={{ display: 'block', fontSize: '0.8125rem', fontWeight: 600, color: '#334155', marginBottom: '4px' }}>
                  Resolution Notes * (Minimum 5 characters)
                </label>
                <textarea
                  className="admin-input"
                  style={{ width: '100%', minHeight: 80 }}
                  placeholder="Explain the audit verification or correction applied..."
                  value={resolutionNotes}
                  onChange={(e) => setResolutionNotes(e.target.value)}
                  required
                />
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' }}>
                <button type="button" className="btn" onClick={() => setSelectedRecord(null)} style={{ fontSize: '0.8125rem' }}>
                  Cancel
                </button>
                <button
                  type="submit"
                  style={{
                    padding: '0.5rem 1rem',
                    background: '#059669',
                    color: '#ffffff',
                    border: 'none',
                    borderRadius: '6px',
                    fontWeight: 600,
                    fontSize: '0.8125rem',
                    cursor: 'pointer'
                  }}
                >
                  Confirm & Resolve Discrepancy
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
