import React, { useCallback, useEffect, useState } from 'react';
import axios from 'axios';
import { QRCodeSVG } from 'qrcode.react';
import { Printer, RefreshCw, CheckCircle2, AlertCircle, Clock, QrCode, Copy, X } from 'lucide-react';

const API_URL = import.meta.env.VITE_API_URL || '';

export const PrinterFleetApprovalPanel = ({ currentUser }) => {
  const [discoveries, setDiscoveries] = useState([]);
  const [devices, setDevices] = useState([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [qrPreview, setQrPreview] = useState(null);

  const canApprove = ['SUPERADMIN', 'FRANCHISEE'].includes(currentUser?.role);

  const loadFleet = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [discoveryResponse, deviceResponse] = await Promise.all([
        axios.get(`${API_URL}/api/admin/printer-discoveries`, { params: { limit: 100 } }),
        axios.get(`${API_URL}/api/admin/printer-devices`, { params: { limit: 100 } })
      ]);
      setDiscoveries(discoveryResponse.data?.data?.discoveries || []);
      setDevices(deviceResponse.data?.data?.devices || []);
    } catch (loadError) {
      setError(loadError.response?.data?.error || loadError.message || 'Could not load printer fleet information.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadFleet();
  }, [loadFleet]);

  const approve = async (discovery) => {
    if (!canApprove || busyId) return;
    const displayName = window.prompt(
      'Choose a customer-facing printer name. The exact Windows queue remains unchanged.',
      discovery.windowsPrinterName
    );
    if (displayName === null) return;
    if (!displayName.trim()) {
      setError('Printer display name cannot be empty.');
      return;
    }

    const machineName = discovery.machine?.name || 'this Machine';
    const confirmed = window.confirm(
      `Approve the exact Windows queue "${discovery.windowsPrinterName}" on "${machineName}"? This registers the device but does not start a print.`
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
      setSuccess(`${registeredName} approved and registered. You can now create its permanent customer QR.`);
      await loadFleet();
    } catch (approveError) {
      setError(approveError.response?.data?.error || approveError.message || 'Printer approval failed.');
    } finally {
      setBusyId(null);
    }
  };

  const createDeviceQr = async (device) => {
    if (!canApprove || busyId) return;
    const label = window.prompt('QR placement label (for example: Counter 1)', device.displayName);
    if (label === null) return;
    if (!label.trim()) {
      setError('QR label cannot be empty.');
      return;
    }
    const confirmed = window.confirm(
      `Create a permanent customer QR for "${device.displayName}" on "${device.machine?.name || 'this Machine'}"? Scans will create sessions bound to this exact physical printer.`
    );
    if (!confirmed) return;

    setBusyId(device.id);
    setError('');
    setSuccess('');
    try {
      const response = await axios.post(
        `${API_URL}/api/admin/printer-devices/${device.id}/qr`,
        { label: label.trim() }
      );
      const qr = response.data?.data?.qr;
      if (!qr?.targetUrl) throw new Error('QR was created but the public target URL was not returned.');
      setQrPreview({ qr, device });
      setSuccess(`Permanent customer QR created for ${device.displayName}.`);
      await loadFleet();
    } catch (createError) {
      setError(createError.response?.data?.error || createError.message || 'Device QR creation failed.');
    } finally {
      setBusyId(null);
    }
  };

  const showDeviceQr = (device) => {
    if (!device.activeQr?.targetUrl) return;
    setQrPreview({
      qr: device.activeQr,
      device
    });
  };

  const copyQrUrl = async () => {
    if (!qrPreview?.qr?.targetUrl) return;
    try {
      await navigator.clipboard.writeText(qrPreview.qr.targetUrl);
      setSuccess('Customer QR URL copied to clipboard.');
    } catch {
      setError('Clipboard permission was unavailable. Copy the URL from the QR preview manually.');
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
            <h3 style={{ margin: 0, fontSize: '0.95rem', color: '#0f172a' }}>Multi-Printer Fleet</h3>
            <p style={{ margin: '3px 0 0', fontSize: '0.75rem', color: '#64748b' }}>
              Review discovered Windows queues, approve each physical device, and issue its permanent customer QR.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={loadFleet}
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

      <div style={{ marginTop: '1.1rem' }}>
        <h4 style={{ margin: '0 0 0.55rem', fontSize: '0.82rem', color: '#0f172a' }}>Pending Windows queue approvals ({discoveries.length})</h4>
        {loading && discoveries.length === 0 ? (
          <p style={{ color: '#64748b', fontSize: '0.8rem' }}>Loading Agent discovery inventory…</p>
        ) : discoveries.length === 0 ? (
          <p style={{ color: '#64748b', fontSize: '0.78rem' }}>No pending discoveries. The Windows Agent must connect and report its installed printer queues first.</p>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '0.75rem' }}>
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
                    marginTop: '0.8rem', width: '100%', padding: '8px 10px', borderRadius: '8px',
                    border: '1px solid #1d4ed8', background: canApprove ? '#1d4ed8' : '#94a3b8',
                    color: '#fff', fontSize: '0.75rem', fontWeight: 700,
                    cursor: canApprove && busyId === null ? 'pointer' : 'not-allowed'
                  }}
                >
                  {busyId === item.id ? 'Approving…' : 'Approve & Register Printer'}
                </button>
              </article>
            ))}
          </div>
        )}
      </div>

      <div style={{ marginTop: '1.25rem', paddingTop: '1rem', borderTop: '1px solid #e2e8f0' }}>
        <h4 style={{ margin: '0 0 0.55rem', fontSize: '0.82rem', color: '#0f172a' }}>Approved physical printers ({devices.length})</h4>
        {devices.length === 0 ? (
          <p style={{ color: '#64748b', fontSize: '0.78rem' }}>Approved printers will appear here. Each one can have its own permanent customer QR.</p>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '0.75rem' }}>
            {devices.map((device) => (
              <article key={device.id} style={{ border: '1px solid #dbeafe', borderRadius: '10px', padding: '0.85rem', minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem' }}>
                  <strong style={{ color: '#0f172a', fontSize: '0.85rem' }}>{device.displayName}</strong>
                  <span style={{ fontSize: '0.65rem', background: '#dcfce7', color: '#166534', borderRadius: '999px', padding: '3px 7px' }}>APPROVED</span>
                </div>
                <div style={{ color: '#64748b', fontSize: '0.7rem', marginTop: '3px' }}>{device.machine?.name || 'Unknown Machine'} · {device.machine?.location || 'Location not set'}</div>
                <div style={{ marginTop: '0.55rem', fontSize: '0.75rem', overflowWrap: 'anywhere' }}>
                  <strong>Windows queue:</strong> {device.windowsPrinterName}
                </div>
                <div style={{ marginTop: '0.35rem', fontSize: '0.7rem', color: '#64748b' }}>
                  {device.connectionType || 'Unknown connection'} · {device.portName || 'Port not reported'}
                </div>
                {device.activeQr ? (
                  <button
                    type="button"
                    onClick={() => showDeviceQr(device)}
                    style={{ marginTop: '0.75rem', width: '100%', padding: '8px 10px', border: '1px solid #059669', borderRadius: '8px', background: '#ecfdf5', color: '#065f46', fontWeight: 700, fontSize: '0.75rem', cursor: 'pointer', display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '6px' }}
                  >
                    <QrCode size={14} /> View permanent QR
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => createDeviceQr(device)}
                    disabled={!canApprove || busyId !== null}
                    style={{ marginTop: '0.75rem', width: '100%', padding: '8px 10px', border: '1px solid #1d4ed8', borderRadius: '8px', background: canApprove ? '#1d4ed8' : '#94a3b8', color: '#fff', fontWeight: 700, fontSize: '0.75rem', cursor: canApprove && busyId === null ? 'pointer' : 'not-allowed', display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '6px' }}
                  >
                    <QrCode size={14} /> {busyId === device.id ? 'Creating QR…' : 'Generate permanent QR'}
                  </button>
                )}
              </article>
            ))}
          </div>
        )}
      </div>

      {qrPreview && (
        <div role="dialog" aria-modal="true" aria-label="Physical printer QR preview" style={{ position: 'fixed', inset: 0, zIndex: 10000, background: 'rgba(15,23,42,0.68)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem' }}>
          <div style={{ background: '#fff', borderRadius: '14px', padding: '1.25rem', width: '100%', maxWidth: '430px', textAlign: 'center', position: 'relative' }}>
            <button type="button" onClick={() => setQrPreview(null)} aria-label="Close QR preview" style={{ position: 'absolute', right: '0.75rem', top: '0.75rem', border: 0, background: 'transparent', cursor: 'pointer' }}>
              <X size={18} />
            </button>
            <h3 style={{ margin: '0.25rem 1.5rem 0.2rem', fontSize: '1rem', color: '#0f172a' }}>{qrPreview.device.displayName}</h3>
            <p style={{ margin: '0 0 1rem', fontSize: '0.75rem', color: '#64748b' }}>{qrPreview.device.machine?.name || 'Machine'} · {qrPreview.qr.label || 'Permanent customer QR'}</p>
            <div style={{ display: 'inline-block', padding: '12px', border: '1px solid #e2e8f0', borderRadius: '12px', background: '#fff' }}>
              <QRCodeSVG value={qrPreview.qr.targetUrl} size={224} level="H" includeMargin />
            </div>
            <p style={{ margin: '0.8rem 0', fontSize: '0.7rem', color: '#64748b', overflowWrap: 'anywhere' }}>{qrPreview.qr.targetUrl}</p>
            <button type="button" onClick={copyQrUrl} style={{ padding: '8px 14px', borderRadius: '8px', border: '1px solid #cbd5e1', background: '#fff', cursor: 'pointer', fontWeight: 600, fontSize: '0.75rem', display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
              <Copy size={14} /> Copy customer URL
            </button>
            <p style={{ margin: '0.85rem 0 0', fontSize: '0.68rem', color: '#64748b' }}>This QR is permanently bound to this physical printer. Do not swap it with another printer's QR.</p>
          </div>
        </div>
      )}
    </section>
  );
};
