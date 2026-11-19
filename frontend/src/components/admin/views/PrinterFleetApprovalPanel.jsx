import React, { useCallback, useEffect, useState } from 'react';
import axios from 'axios';
import { Printer, RefreshCw, CheckCircle2, AlertCircle, Clock } from 'lucide-react';

const API_URL = import.meta.env.VITE_API_URL || '';

export const PrinterFleetApprovalPanel = ({ currentUser }) => {
  const [discoveries, setDiscoveries] = useState([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const canApprove = ['SUPERADMIN', 'FRANCHISEE'].includes(currentUser?.role);

  const loadDiscoveries = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await axios.get(`${API_URL}/api/admin/printer-discoveries`, {
        params: { limit: 100 }
      });
      setDiscoveries(response.data?.data?.discoveries || []);
    } catch (loadError) {
      setError(loadError.response?.data?.error || loadError.message || 'Could not load discovered printer queues.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadDiscoveries();
  }, [loadDiscoveries]);

  const approve = async (discovery) => {
    if (!canApprove || busyId) return;
    const suggestedName = discovery.windowsPrinterName;
    const displayName = window.prompt(
      'Choose a customer-facing printer name. The exact Windows queue remains unchanged.',
      suggestedName
    );
    if (displayName === null) return;
    if (!displayName.trim()) {
      setError('Printer display name cannot be empty.');
      return;
    }

    const machineName = discovery.machine?.name || 'this Machine';
    const confirmed = window.confirm(
      `Approve the exact Windows queue "${discovery.windowsPrinterName}" on "${machineName}"? This registers the device but does not generate a customer QR or start a print.`
    );
    if (!confirmed) return;

    setBusyId(discovery.id);
    setError('');
    setSuccess('');
    try {
      const response = await axios.post(
        `${API_URL}/api/admin/printer-discoveries/${discovery.id}/approve`,
        { displayName: displayName.trim() }
      );
      const registeredName = response.data?.data?.device?.displayName || displayName.trim();
      setSuccess(`${registeredName} approved and registered. QR creation and print routing are not enabled in this phase.`);
      await loadDiscoveries();
    } catch (approveError) {
      setError(approveError.response?.data?.error || approveError.message || 'Printer approval failed.');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section
      className="admin-kpi-card"
      style={{
        marginBottom: '1.25rem',
        border: '1px solid #cbd5e1',
        borderRadius: '12px',
        padding: '1rem 1.125rem',
        background: '#fff'
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem' }}>
          <div style={{ background: '#eff6ff', padding: '8px', borderRadius: '9px' }}>
            <Printer size={20} color="#1d4ed8" />
          </div>
          <div>
            <h3 style={{ margin: 0, fontSize: '0.95rem', color: '#0f172a' }}>Discovered Windows Printers</h3>
            <p style={{ margin: '3px 0 0', fontSize: '0.75rem', color: '#64748b' }}>
              Agent inventory is saved for review. Only an Admin approval registers a PrinterDevice.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={loadDiscoveries}
          disabled={loading}
          style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '7px 11px', borderRadius: '8px', border: '1px solid #cbd5e1', background: '#fff', cursor: loading ? 'wait' : 'pointer' }}
        >
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      {error && (
        <div role="alert" style={{ marginTop: '0.8rem', padding: '0.65rem 0.8rem', background: '#fef2f2', borderRadius: '8px', color: '#991b1b', fontSize: '0.8rem', display: 'flex', gap: '0.5rem' }}>
          <AlertCircle size={15} /> {error}
        </div>
      )}
      {success && (
        <div role="status" style={{ marginTop: '0.8rem', padding: '0.65rem 0.8rem', background: '#ecfdf5', borderRadius: '8px', color: '#065f46', fontSize: '0.8rem', display: 'flex', gap: '0.5rem' }}>
          <CheckCircle2 size={15} /> {success}
        </div>
      )}

      {loading && discoveries.length === 0 ? (
        <p style={{ margin: '1rem 0 0', color: '#64748b', fontSize: '0.8rem' }}>Loading Agent discovery inventory…</p>
      ) : discoveries.length === 0 ? (
        <p style={{ margin: '1rem 0 0', color: '#64748b', fontSize: '0.8rem' }}>
          No pending discoveries. The Windows Agent must connect and report its installed printer queues first.
        </p>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '0.75rem', marginTop: '1rem' }}>
          {discoveries.map((item) => (
            <article key={item.id} style={{ border: '1px solid #e2e8f0', borderRadius: '10px', padding: '0.85rem', minWidth: 0 }}>
              <div style={{ fontWeight: 700, color: '#0f172a', fontSize: '0.85rem' }}>{item.machine?.name || 'Unknown Machine'}</div>
              <div style={{ color: '#64748b', fontSize: '0.7rem', marginTop: '2px' }}>{item.machine?.location || 'Location not set'}</div>
              <div style={{ marginTop: '0.65rem', fontSize: '0.8rem', color: '#1e293b', overflowWrap: 'anywhere' }}>
                <strong>Exact Windows queue:</strong> {item.windowsPrinterName}
              </div>
              <div style={{ marginTop: '0.35rem', fontSize: '0.72rem', color: '#64748b', lineHeight: 1.55 }}>
                <div>Driver: {item.driverName || 'Not reported'}</div>
                <div>Port: {item.portName || 'Not reported'}</div>
                <div>Connection: {item.connectionType || 'Unknown'}{item.isDefault ? ' · Windows default' : ''}</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginTop: '4px' }}>
                  <Clock size={12} /> Last seen: {item.lastSeenAt ? new Date(item.lastSeenAt).toLocaleString() : 'Unknown'}
                </div>
              </div>
              <button
                type="button"
                onClick={() => approve(item)}
                disabled={!canApprove || busyId !== null}
                style={{
                  marginTop: '0.8rem',
                  width: '100%',
                  padding: '8px 10px',
                  borderRadius: '8px',
                  border: '1px solid #1d4ed8',
                  background: canApprove ? '#1d4ed8' : '#94a3b8',
                  color: '#fff',
                  fontSize: '0.75rem',
                  fontWeight: 700,
                  cursor: canApprove && busyId === null ? 'pointer' : 'not-allowed'
                }}
              >
                {busyId === item.id ? 'Approving…' : 'Approve & Register Printer'}
              </button>
            </article>
          ))}
        </div>
      )}
    </section>
  );
};
