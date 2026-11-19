import React, { useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import {
  Printer,
  Wifi,
  WifiOff,
  Droplet,
  File,
  QrCode,
  Sparkles,
  RotateCw,
  Ban,
  History,
  CheckCircle2,
  AlertCircle,
  Eye,
  Shield,
  RefreshCw,
  VolumeX,
  Volume2,
  Clock,
  Megaphone,
  Banknote,
  CreditCard
} from 'lucide-react';
import { TelemetryDashboard } from '../TelemetryDashboard';
import {
  PrinterQrPreviewModal,
  PrintableCounterFlyer,
  PrinterQrGenerateModal,
  PrinterQrRotateModal,
  PrinterQrRevokeModal,
  PrinterQrLedgerModal
} from './PrinterQrModals';
import { PrinterAdSuppressionModal } from './PrinterAdSuppressionModal';
import { PrinterFleetApprovalPanel } from './PrinterFleetApprovalPanel';

const API_URL = import.meta.env.VITE_API_URL || '';

export const PrintersView = ({
  machines = [],
  telemetryHistory = [],
  printerStatus,
  currentUser,
  onRefresh
}) => {
  // Dedicated QR state indexed by machineId
  const [machineQrData, setMachineQrData] = useState({});
  const [isLoadingQrs, setIsLoadingQrs] = useState(false);
  const [globalError, setGlobalError] = useState('');
  const [globalSuccess, setGlobalSuccess] = useState('');

  // Modals state
  const [previewState, setPreviewState] = useState({ isOpen: false, qr: null, machine: null });
  const [flyerState, setFlyerState] = useState({ isOpen: false, qr: null, machine: null });
  const [generateState, setGenerateState] = useState({ isOpen: false, machine: null, isSubmitting: false, errorMsg: '' });
  const [rotateState, setRotateState] = useState({ isOpen: false, qr: null, machine: null, isSubmitting: false, errorMsg: '' });
  const [revokeState, setRevokeState] = useState({ isOpen: false, qr: null, machine: null, isSubmitting: false, errorMsg: '' });
  const [ledgerState, setLedgerState] = useState({ isOpen: false, machine: null, ledger: null, isLoading: false });
  const [suppressionModalState, setSuppressionModalState] = useState({ isOpen: false, machine: null });
  const [, setTick] = useState(0);

  // Live countdown timer ticker (1s interval)
  useEffect(() => {
    const interval = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(interval);
  }, []);

  const formatCountdown = (untilDate) => {
    if (!untilDate) return '';
    const diffMs = new Date(untilDate).getTime() - Date.now();
    if (diffMs <= 0) return 'Expiring now...';
    const totalSecs = Math.floor(diffMs / 1000);
    const hrs = Math.floor(totalSecs / 3600);
    const mins = Math.floor((totalSecs % 3600) / 60);
    const secs = totalSecs % 60;
    if (hrs > 0) return `${hrs}h ${mins}m ${secs}s`;
    if (mins > 0) return `${mins}m ${secs}s`;
    return `${secs}s`;
  };

  const handleResumeAds = async (machine) => {
    if (!window.confirm(`Resume advertisements immediately for machine "${machine.name}"?`)) {
      return;
    }
    try {
      const res = await axios.delete(`${API_URL}/api/machines/${machine.id}/ad-suppression`);
      if (res.data?.success) {
        setGlobalSuccess(`Advertisements resumed for ${machine.name}`);
        setTimeout(() => setGlobalSuccess(''), 4000);
        if (onRefresh) onRefresh();
      }
    } catch (err) {
      console.error('Failed to resume ads:', err);
      const serverError = err.response?.data?.error || err.response?.data?.message || err.message;
      if (err.response?.status === 403 && serverError.includes('Read-Only')) {
        setGlobalError('Action blocked: Cloud Admin Dashboard is operating in Read-Only Monitoring Mode (ADMIN_READ_ONLY=true). Remote mutations are disabled.');
      } else {
        setGlobalError(serverError || 'Failed to resume advertisements.');
      }
      setTimeout(() => setGlobalError(''), 6000);
    }
  };

  // Determine if current user can manage a machine
  const canManageMachine = useCallback((machine) => {
    if (!currentUser) return false;
    if (currentUser.role === 'SUPERADMIN') return true;
    if (currentUser.role === 'FRANCHISEE') {
      return Boolean(currentUser.companyId && machine.companyId === currentUser.companyId);
    }
    return false;
  }, [currentUser]);

  // Load all dedicated QRs
  const loadPrinterQrs = useCallback(async () => {
    setIsLoadingQrs(true);
    try {
      const res = await axios.get(`${API_URL}/api/admin/printer-qrs`, {
        params: { limit: 100, legacyOnly: true }
      });

      if (res.data?.success && res.data.data?.qrs) {
        const qrs = res.data.data.qrs;
        const mapping = {};

        // Group by machineId: pick active or latest
        qrs.forEach((q) => {
          if (!q.machineId) return;
          if (!mapping[q.machineId]) {
            mapping[q.machineId] = { activeQr: null, latestQr: q, totalCount: 0 };
          }
          mapping[q.machineId].totalCount += 1;
          if (q.status === 'ACTIVE') {
            mapping[q.machineId].activeQr = q;
          }
        });

        setMachineQrData(mapping);
      }
    } catch (err) {
      console.error('Failed to load printer QRs:', err);
      // Suppress noisy UI error if not logged in or backend down
    } finally {
      setIsLoadingQrs(false);
    }
  }, []);

  useEffect(() => {
    loadPrinterQrs();
  }, [loadPrinterQrs, machines]);

  // Handle generating a new QR
  const handleGenerateConfirm = async (machineId, label) => {
    setGenerateState(prev => ({ ...prev, isSubmitting: true, errorMsg: '' }));
    try {
      const res = await axios.post(`${API_URL}/api/admin/printer-qrs`, {
        machineId,
        label: label.trim()
      });

      if (res.data?.success && res.data.data?.qr) {
        const newQr = res.data.data.qr;
        setGlobalSuccess(`Dedicated permanent QR generated successfully for ${generateState.machine?.name || 'printer'}!`);
        setGenerateState({ isOpen: false, machine: null, isSubmitting: false, errorMsg: '' });

        // Reload and open preview directly
        await loadPrinterQrs();
        setPreviewState({ isOpen: true, qr: newQr, machine: generateState.machine });
      }
    } catch (err) {
      const errMsg = err.response?.data?.error || err.message || 'Failed to generate printer QR';
      setGenerateState(prev => ({ ...prev, isSubmitting: false, errorMsg: errMsg }));
    }
  };

  // Handle rotating an existing QR
  const handleRotateConfirm = async (qrId, reason, newLabel) => {
    setRotateState(prev => ({ ...prev, isSubmitting: true, errorMsg: '' }));
    try {
      const res = await axios.post(`${API_URL}/api/admin/printer-qrs/${qrId}/replace`, {
        reason,
        label: newLabel
      });

      if (res.data?.success && res.data.data?.newQr) {
        const rotatedQr = res.data.data.newQr;
        setGlobalSuccess(`Printer QR rotated successfully! Old QR marked REPLACED and archived.`);
        setRotateState({ isOpen: false, qr: null, machine: null, isSubmitting: false, errorMsg: '' });

        // Reload and open preview for the newly generated active QR
        await loadPrinterQrs();
        setPreviewState({ isOpen: true, qr: rotatedQr, machine: rotateState.machine });
      }
    } catch (err) {
      const errMsg = err.response?.data?.error || err.message || 'Failed to rotate printer QR';
      setRotateState(prev => ({ ...prev, isSubmitting: false, errorMsg: errMsg }));
    }
  };

  // Handle revoking an existing QR
  const handleRevokeConfirm = async (qrId, reason) => {
    setRevokeState(prev => ({ ...prev, isSubmitting: true, errorMsg: '' }));
    try {
      const res = await axios.post(`${API_URL}/api/admin/printer-qrs/${qrId}/revoke`, {
        reason
      });

      if (res.data?.success) {
        setGlobalSuccess(`Printer QR revoked successfully. Physical counter scans will be rejected.`);
        setRevokeState({ isOpen: false, qr: null, machine: null, isSubmitting: false, errorMsg: '' });
        setPreviewState({ isOpen: false, qr: null, machine: null });
        await loadPrinterQrs();
      }
    } catch (err) {
      const errMsg = err.response?.data?.error || err.message || 'Failed to revoke printer QR';
      setRevokeState(prev => ({ ...prev, isSubmitting: false, errorMsg: errMsg }));
    }
  };

  // Open ledger for a machine
  const handleOpenLedger = async (machine) => {
    setLedgerState({ isOpen: true, machine, ledger: null, isLoading: true });
    try {
      const res = await axios.get(`${API_URL}/api/admin/machines/${machine.id}/qr`);
      if (res.data?.success) {
        setLedgerState({
          isOpen: true,
          machine,
          ledger: res.data.data,
          isLoading: false
        });
      }
    } catch (err) {
      setGlobalError(err.response?.data?.error || 'Failed to load QR history ledger');
      setLedgerState(prev => ({ ...prev, isLoading: false }));
    }
  };

  // Switch Payment Mode with 1 click
  const handleSwitchPaymentMode = async (machine, newMode) => {
    if (machine.paymentMode === newMode) return;
    setGlobalError('');
    setGlobalSuccess('');
    try {
      const res = await axios.put(`${API_URL}/api/machines/${machine.id}/payment-mode`, {
        paymentMode: newMode
      });
      if (res.data?.success) {
        setGlobalSuccess(`Payment mode updated to "${newMode === 'CASH_AT_COUNTER' ? 'Cash at Counter' : newMode === 'DEMO_SIMULATION' ? 'Demo Simulation' : 'Cashfree Online'}" for printer "${machine.name}". New QR sessions will use this mode.`);
        machine.paymentMode = newMode;
      } else {
        throw new Error(res.data?.error || 'Failed to update payment mode');
      }
    } catch (err) {
      setGlobalError(err.response?.data?.error || err.message || 'Failed to switch payment mode');
    }
  };

  return (
    <div>
      <PrinterFleetApprovalPanel currentUser={currentUser} />
      {/* Global Alerts */}
      {globalSuccess && (
        <div
          style={{
            background: '#ecfdf5',
            border: '1px solid #a7f3d0',
            color: '#065f46',
            borderRadius: '10px',
            padding: '0.75rem 1rem',
            marginBottom: '1rem',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            fontSize: '0.8125rem'
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <CheckCircle2 size={16} color="#059669" />
            <span>{globalSuccess}</span>
          </div>
          <button
            onClick={() => setGlobalSuccess('')}
            style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: '#065f46', fontWeight: 700 }}
          >
            ✕
          </button>
        </div>
      )}

      {globalError && (
        <div
          style={{
            background: '#fef2f2',
            border: '1px solid #fecaca',
            color: '#991b1b',
            borderRadius: '10px',
            padding: '0.75rem 1rem',
            marginBottom: '1rem',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            fontSize: '0.8125rem'
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <AlertCircle size={16} color="#dc2626" />
            <span>{globalError}</span>
          </div>
          <button
            onClick={() => setGlobalError('')}
            style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: '#991b1b', fontWeight: 700 }}
          >
            ✕
          </button>
        </div>
      )}

      {/* Header Info */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem' }}>
        <div>
          <h3 style={{ margin: 0, fontSize: '1.125rem', fontWeight: 700, color: '#0f172a' }}>
            Printers & Dedicated Counter QRs
          </h3>
          <p style={{ margin: '2px 0 0 0', fontSize: '0.75rem', color: '#64748b' }}>
            Manage registered printing hardware and their permanent physical customer QR identifiers
          </p>
        </div>
        <button
          onClick={async () => {
            loadPrinterQrs();
            if (typeof onRefresh === 'function') {
              onRefresh();
            }
          }}
          disabled={isLoadingQrs}
          className="btn"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            fontSize: '0.75rem',
            fontWeight: 600,
            padding: '6px 12px'
          }}
        >
          <RefreshCw size={13} className={isLoadingQrs ? 'animate-spin' : ''} />
          Refresh Fleet Status
        </button>
      </div>

      {/* Live Fleet Overview Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))', gap: '1rem', marginBottom: '1.5rem' }}>
        {machines && machines.length > 0 ? (
          machines.map(machine => {
            const isOnline = machine.isOnline === true;
            const latestStatus = machine.printerStatuses?.[0];
            const paperDisplay = latestStatus?.paperStatus
              ? (latestStatus.paperStatus === 'OK' ? 'Sufficient' : latestStatus.paperStatus)
              : 'Unknown';
            const paperColor = !latestStatus?.paperStatus
              ? '#64748b'
              : (latestStatus.paperStatus === 'OK' ? '#059669' : '#d97706');

            const tonerDisplay = latestStatus?.tonerStatus
              ? (latestStatus.tonerStatus === 'OK' ? 'Optimal' : latestStatus.tonerStatus)
              : 'Unknown';
            const tonerColor = !latestStatus?.tonerStatus
              ? '#64748b'
              : (latestStatus.tonerStatus === 'OK' ? '#059669' : '#d97706');

            // QR Info for this machine
            const qrEntry = machineQrData[machine.id];
            const activeQr = qrEntry?.activeQr || null;
            const latestQr = qrEntry?.latestQr || null;
            const hasQrHistory = Boolean(qrEntry?.totalCount > 0);

            // Determine status
            let qrStatus = 'NOT GENERATED';
            let displayQr = null;

            if (activeQr) {
              qrStatus = 'ACTIVE';
              displayQr = activeQr;
            } else if (latestQr) {
              qrStatus = latestQr.status; // REVOKED or REPLACED
              displayQr = latestQr;
            }

            const isAuthorized = canManageMachine(machine);

            return (
              <div
                key={machine.id}
                className="admin-kpi-card"
                style={{
                  borderTop: `4px solid ${isOnline ? '#10b981' : '#ef4444'}`,
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'space-between'
                }}
              >
                <div>
                  {/* Top Bar: Printer Name & Hardware Online Badge */}
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75rem' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <div style={{ background: isOnline ? '#ecfdf5' : '#fef2f2', padding: '6px', borderRadius: '8px' }}>
                        <Printer size={20} color={isOnline ? '#059669' : '#dc2626'} />
                      </div>
                      <div>
                        <h4 style={{ margin: 0, fontSize: '0.9375rem', fontWeight: 600, color: '#0f172a' }}>{machine.name}</h4>
                        <span style={{ fontSize: '0.6875rem', color: '#64748b' }}>{machine.location || 'Front Desk'}</span>
                      </div>
                    </div>

                    <span style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '4px',
                      fontSize: '0.6875rem',
                      fontWeight: 600,
                      padding: '2px 8px',
                      borderRadius: '9999px',
                      background: isOnline ? '#ecfdf5' : '#fef2f2',
                      color: isOnline ? '#059669' : '#dc2626'
                    }}>
                      {isOnline ? <Wifi size={12} /> : <WifiOff size={12} />}
                      {isOnline ? 'ONLINE' : (machine.hardwareStatus ? machine.hardwareStatus.replace('_', ' ') : 'OFFLINE')}
                    </span>
                  </div>

                  {/* Hardware Telemetry Snapshot */}
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem', background: '#f8fafc', padding: '0.625rem', borderRadius: '8px', fontSize: '0.75rem', marginBottom: '0.75rem' }}>
                    <div>
                      <span style={{ color: '#64748b' }}>Model:</span>
                      <div style={{ fontWeight: 600, color: '#1e293b' }}>{machine.printerModel?.trim() || 'Unknown'}</div>
                    </div>
                    <div>
                      <span style={{ color: '#64748b' }}>Connection:</span>
                      <div style={{ fontWeight: 600, color: '#1e293b' }}>{machine.connectionType?.trim() || 'Unknown'}</div>
                    </div>
                    <div>
                      <span style={{ color: '#64748b' }}>Paper Tray:</span>
                      <div style={{ fontWeight: 600, color: paperColor, display: 'flex', alignItems: 'center', gap: '2px' }}>
                        <File size={12} /> {paperDisplay}
                      </div>
                    </div>
                    <div>
                      <span style={{ color: '#64748b' }}>Toner/Ink:</span>
                      <div style={{ fontWeight: 600, color: tonerColor, display: 'flex', alignItems: 'center', gap: '2px' }}>
                        <Droplet size={12} /> {tonerDisplay}
                      </div>
                    </div>
                  </div>

                  {/* DEDICATED PERMANENT PRINTER QR SECTION */}
                  <div
                    style={{
                      border: '1px solid #e2e8f0',
                      borderRadius: '10px',
                      padding: '0.75rem',
                      background: qrStatus === 'ACTIVE' ? '#ffffff' : '#f8fafc',
                      marginBottom: '0.75rem'
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <QrCode size={16} color={qrStatus === 'ACTIVE' ? '#059669' : '#64748b'} />
                        <span style={{ fontSize: '0.75rem', fontWeight: 700, color: '#1e293b' }}>
                          Counter QR Identity
                        </span>
                      </div>

                      {/* QR Status Badge */}
                      <span
                        style={{
                          fontSize: '0.625rem',
                          fontWeight: 700,
                          padding: '2px 8px',
                          borderRadius: '9999px',
                          textTransform: 'uppercase',
                          background:
                            qrStatus === 'ACTIVE' ? '#ecfdf5' :
                            qrStatus === 'REVOKED' ? '#fef2f2' :
                            qrStatus === 'REPLACED' ? '#fffbeb' : '#f1f5f9',
                          color:
                            qrStatus === 'ACTIVE' ? '#059669' :
                            qrStatus === 'REVOKED' ? '#dc2626' :
                            qrStatus === 'REPLACED' ? '#b45309' : '#64748b',
                          border: `1px solid ${
                            qrStatus === 'ACTIVE' ? '#a7f3d0' :
                            qrStatus === 'REVOKED' ? '#fecaca' :
                            qrStatus === 'REPLACED' ? '#fde68a' : '#cbd5e1'
                          }`
                        }}
                      >
                        {qrStatus}
                      </span>
                    </div>

                    {/* QR Details */}
                    {displayQr ? (
                      <div style={{ fontSize: '0.6875rem', color: '#475569', lineHeight: 1.5 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                          <span>Placement Label:</span>
                          <strong style={{ color: '#0f172a' }}>{displayQr.label || 'Front Desk Counter'}</strong>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '2px' }}>
                          <span>Public Token:</span>
                          <span style={{ fontFamily: 'monospace', color: '#64748b' }}>
                            {displayQr.publicCode.slice(0, 10)}...{displayQr.publicCode.slice(-6)}
                          </span>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '2px', color: '#94a3b8' }}>
                          <span>Generated:</span>
                          <span>{new Date(displayQr.createdAt).toLocaleDateString()}</span>
                        </div>
                      </div>
                    ) : (
                      <div style={{ fontSize: '0.6875rem', color: '#94a3b8', fontStyle: 'italic', padding: '4px 0' }}>
                        No dedicated QR has been generated for this physical printer yet.
                      </div>
                    )}

                    {/* QR Action Toolbar */}
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.5rem',
                        marginTop: '0.625rem',
                        paddingTop: '0.5rem',
                        borderTop: '1px solid #f1f5f9'
                      }}
                    >
                      {qrStatus === 'ACTIVE' ? (
                        <>
                          <button
                            onClick={() => setPreviewState({ isOpen: true, qr: activeQr, machine })}
                            style={{
                              flex: 1,
                              padding: '5px 8px',
                              background: '#059669',
                              color: '#ffffff',
                              border: 'none',
                              borderRadius: '6px',
                              fontSize: '0.6875rem',
                              fontWeight: 600,
                              cursor: 'pointer',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              gap: '4px'
                            }}
                          >
                            <Eye size={12} /> View QR
                          </button>

                          {isAuthorized && (
                            <>
                              <button
                                onClick={() => setRotateState({ isOpen: true, qr: activeQr, machine, isSubmitting: false, errorMsg: '' })}
                                style={{
                                  padding: '5px 8px',
                                  background: '#fef3c7',
                                  color: '#92400e',
                                  border: '1px solid #fde68a',
                                  borderRadius: '6px',
                                  fontSize: '0.6875rem',
                                  fontWeight: 600,
                                  cursor: 'pointer',
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: '3px'
                                }}
                                title="Rotate / Replace QR with fresh token"
                              >
                                <RotateCw size={12} /> Rotate
                              </button>

                              <button
                                onClick={() => setRevokeState({ isOpen: true, qr: activeQr, machine, isSubmitting: false, errorMsg: '' })}
                                style={{
                                  padding: '5px 8px',
                                  background: '#fee2e2',
                                  color: '#991b1b',
                                  border: '1px solid #fecaca',
                                  borderRadius: '6px',
                                  fontSize: '0.6875rem',
                                  fontWeight: 600,
                                  cursor: 'pointer',
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: '3px'
                                }}
                                title="Revoke QR permanently"
                              >
                                <Ban size={12} /> Revoke
                              </button>
                            </>
                          )}
                        </>
                      ) : (
                        isAuthorized ? (
                          <button
                            onClick={() => setGenerateState({ isOpen: true, machine, isSubmitting: false, errorMsg: '' })}
                            style={{
                              flex: 1,
                              padding: '6px 10px',
                              background: '#0284c7',
                              color: '#ffffff',
                              border: 'none',
                              borderRadius: '6px',
                              fontSize: '0.6875rem',
                              fontWeight: 600,
                              cursor: 'pointer',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              gap: '6px'
                            }}
                          >
                            <Sparkles size={13} /> Generate Permanent QR
                          </button>
                        ) : (
                          <span style={{ fontSize: '0.6875rem', color: '#94a3b8' }}>
                            Read-Only / Franchisee Scoped
                          </span>
                        )
                      )}

                      {/* Audit Ledger History Button */}
                      {(hasQrHistory || isAuthorized) && (
                        <button
                          onClick={() => handleOpenLedger(machine)}
                          style={{
                            padding: '5px 8px',
                            background: '#f8fafc',
                            color: '#475569',
                            border: '1px solid #cbd5e1',
                            borderRadius: '6px',
                            fontSize: '0.6875rem',
                            fontWeight: 600,
                            cursor: 'pointer',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '3px'
                          }}
                          title="View complete QR lifecycle history"
                        >
                          <History size={12} /> Ledger
                        </button>
                      )}
                    </div>
                  </div>

                  {/* MACHINE PAYMENT OPERATING MODE CONFIGURATION */}
                  <div
                    style={{
                      border: '1px solid #e2e8f0',
                      borderRadius: '10px',
                      padding: '0.75rem',
                      background: '#ffffff',
                      marginBottom: '0.75rem'
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <Banknote size={16} color="#059669" />
                        <span style={{ fontSize: '0.75rem', fontWeight: 700, color: '#1e293b' }}>
                          Payment Operating Mode
                        </span>
                      </div>
                      <span
                        style={{
                          fontSize: '0.625rem',
                          fontWeight: 700,
                          padding: '2px 8px',
                          borderRadius: '9999px',
                          background:
                            machine.paymentMode === 'CASH_AT_COUNTER' || !machine.paymentMode ? '#ecfdf5' :
                            machine.paymentMode === 'DEMO_SIMULATION' ? '#fffbeb' : '#f0f9ff',
                          color:
                            machine.paymentMode === 'CASH_AT_COUNTER' || !machine.paymentMode ? '#059669' :
                            machine.paymentMode === 'DEMO_SIMULATION' ? '#b45309' : '#0284c7',
                          border: `1px solid ${
                            machine.paymentMode === 'CASH_AT_COUNTER' || !machine.paymentMode ? '#a7f3d0' :
                            machine.paymentMode === 'DEMO_SIMULATION' ? '#fde68a' : '#bae6fd'
                          }`
                        }}
                      >
                        {machine.paymentMode === 'CASH_AT_COUNTER' || !machine.paymentMode
                          ? '💵 CASH AT COUNTER (ACTIVE)'
                          : machine.paymentMode === 'DEMO_SIMULATION'
                            ? '🧪 DEMO SIMULATION'
                            : '💳 CASHFREE ONLINE'}
                      </span>
                    </div>

                    <p style={{ fontSize: '0.6875rem', color: '#64748b', margin: '0 0 8px 0', lineHeight: 1.4 }}>
                      {machine.paymentMode === 'CASH_AT_COUNTER' || !machine.paymentMode
                        ? 'Customers pay cash at counter; printing starts after cashier confirms payment in Admin.'
                        : machine.paymentMode === 'DEMO_SIMULATION'
                          ? 'Supervised staging simulation producing real prints using demo access code.'
                          : 'Online payments via Cashfree payment gateway (UPI, Cards, NetBanking).'}
                    </p>

                    {/* One-Click Mode Buttons */}
                    {isAuthorized && (
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '6px' }}>
                        <button
                          type="button"
                          onClick={() => handleSwitchPaymentMode(machine, 'CASH_AT_COUNTER')}
                          style={{
                            padding: '6px 4px',
                            borderRadius: '6px',
                            fontSize: '0.6875rem',
                            fontWeight: 700,
                            cursor: 'pointer',
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: 'center',
                            gap: '2px',
                            background: machine.paymentMode === 'CASH_AT_COUNTER' || !machine.paymentMode ? '#059669' : '#f8fafc',
                            color: machine.paymentMode === 'CASH_AT_COUNTER' || !machine.paymentMode ? '#ffffff' : '#334155',
                            border: machine.paymentMode === 'CASH_AT_COUNTER' || !machine.paymentMode ? '1px solid #047857' : '1px solid #cbd5e1',
                            transition: 'all 0.15s ease'
                          }}
                        >
                          <span>💵 Cash</span>
                          <span style={{ fontSize: '0.5625rem', opacity: 0.85 }}>At Counter</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => handleSwitchPaymentMode(machine, 'DEMO_SIMULATION')}
                          style={{
                            padding: '6px 4px',
                            borderRadius: '6px',
                            fontSize: '0.6875rem',
                            fontWeight: 700,
                            cursor: 'pointer',
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: 'center',
                            gap: '2px',
                            background: machine.paymentMode === 'DEMO_SIMULATION' ? '#d97706' : '#f8fafc',
                            color: machine.paymentMode === 'DEMO_SIMULATION' ? '#ffffff' : '#334155',
                            border: machine.paymentMode === 'DEMO_SIMULATION' ? '1px solid #b45309' : '1px solid #cbd5e1',
                            transition: 'all 0.15s ease'
                          }}
                        >
                          <span>🧪 Demo</span>
                          <span style={{ fontSize: '0.5625rem', opacity: 0.85 }}>Simulation</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => handleSwitchPaymentMode(machine, 'CASHFREE_ONLINE')}
                          style={{
                            padding: '6px 4px',
                            borderRadius: '6px',
                            fontSize: '0.6875rem',
                            fontWeight: 700,
                            cursor: 'pointer',
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: 'center',
                            gap: '2px',
                            background: machine.paymentMode === 'CASHFREE_ONLINE' ? '#0284c7' : '#f8fafc',
                            color: machine.paymentMode === 'CASHFREE_ONLINE' ? '#ffffff' : '#334155',
                            border: machine.paymentMode === 'CASHFREE_ONLINE' ? '1px solid #0369a1' : '1px solid #cbd5e1',
                            transition: 'all 0.15s ease'
                          }}
                        >
                          <span>💳 Cashfree</span>
                          <span style={{ fontSize: '0.5625rem', opacity: 0.85 }}>Online</span>
                        </button>
                      </div>
                    )}
                  </div>

                  {/* MACHINE ADVERTISEMENT SUPPRESSION / STATUS */}
                  <div
                    style={{
                      border: '1px solid #e2e8f0',
                      borderRadius: '10px',
                      padding: '0.75rem',
                      background: '#ffffff',
                      marginBottom: '0.75rem'
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <Megaphone size={16} color={machine.adSuppressionMode === 'PERMANENT' ? '#ef4444' : machine.adSuppressionMode === 'TEMPORARY' ? '#f59e0b' : '#059669'} />
                        <span style={{ fontSize: '0.75rem', fontWeight: 700, color: '#1e293b' }}>
                          Advertisement Status
                        </span>
                      </div>

                      {/* Mode Badge */}
                      <span
                        style={{
                          fontSize: '0.625rem',
                          fontWeight: 700,
                          padding: '2px 8px',
                          borderRadius: '9999px',
                          background:
                            machine.adSuppressionMode === 'PERMANENT' ? '#fef2f2' :
                            machine.adSuppressionMode === 'TEMPORARY' ? '#fffbeb' : '#ecfdf5',
                          color:
                            machine.adSuppressionMode === 'PERMANENT' ? '#dc2626' :
                            machine.adSuppressionMode === 'TEMPORARY' ? '#b45309' : '#059669',
                          border: `1px solid ${
                            machine.adSuppressionMode === 'PERMANENT' ? '#fecaca' :
                            machine.adSuppressionMode === 'TEMPORARY' ? '#fde68a' : '#a7f3d0'
                          }`
                        }}
                      >
                        {machine.adSuppressionMode === 'PERMANENT' ? 'PERMANENTLY SILENCED' :
                         machine.adSuppressionMode === 'TEMPORARY' ? 'TEMPORARILY SILENCED' : 'ADS ACTIVE'}
                      </span>
                    </div>

                    {/* Details or Countdown */}
                    {machine.adSuppressionMode === 'TEMPORARY' ? (
                      <div style={{ fontSize: '0.6875rem', color: '#b45309', background: '#fffbeb', padding: '6px 8px', borderRadius: '6px', marginBottom: '6px', display: 'flex', flexDirection: 'column', gap: '2px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '4px', fontWeight: 700 }}>
                          <Clock size={12} />
                          <span>Countdown: {formatCountdown(machine.adSuppressionUntil)}</span>
                        </div>
                        {machine.adSuppressionReason && (
                          <div style={{ color: '#78350f', fontStyle: 'italic' }}>
                            Reason: {machine.adSuppressionReason}
                          </div>
                        )}
                      </div>
                    ) : machine.adSuppressionMode === 'PERMANENT' ? (
                      <div style={{ fontSize: '0.6875rem', color: '#991b1b', background: '#fef2f2', padding: '6px 8px', borderRadius: '6px', marginBottom: '6px', display: 'flex', flexDirection: 'column', gap: '2px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '4px', fontWeight: 700 }}>
                          <Ban size={12} />
                          <span>Ads disabled indefinitely</span>
                        </div>
                        {machine.adSuppressionReason && (
                          <div style={{ color: '#7f1d1d', fontStyle: 'italic' }}>
                            Reason: {machine.adSuppressionReason}
                          </div>
                        )}
                      </div>
                    ) : (
                      <div style={{ fontSize: '0.6875rem', color: '#64748b', padding: '2px 0 6px 0' }}>
                        Advertisements are actively running on this kiosk and customer mobile screens.
                      </div>
                    )}

                    {/* Action Buttons */}
                    {isAuthorized && (
                      <div style={{ display: 'flex', gap: '0.5rem', marginTop: '4px' }}>
                        {machine.adSuppressionMode === 'PERMANENT' || machine.adSuppressionMode === 'TEMPORARY' ? (
                          <button
                            type="button"
                            onClick={() => handleResumeAds(machine)}
                            style={{
                              flex: 1,
                              padding: '5px 8px',
                              background: '#ecfdf5',
                              color: '#059669',
                              border: '1px solid #a7f3d0',
                              borderRadius: '6px',
                              fontSize: '0.6875rem',
                              fontWeight: 700,
                              cursor: 'pointer',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              gap: '4px'
                            }}
                          >
                            <Volume2 size={12} /> Resume Advertisements
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setSuppressionModalState({ isOpen: true, machine })}
                            style={{
                              flex: 1,
                              padding: '5px 8px',
                              background: '#fffbeb',
                              color: '#b45309',
                              border: '1px solid #fde68a',
                              borderRadius: '6px',
                              fontSize: '0.6875rem',
                              fontWeight: 700,
                              cursor: 'pointer',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              gap: '4px'
                            }}
                          >
                            <VolumeX size={12} /> Silence Advertisements
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </div>

                {/* Footer Metadata */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '0.6875rem', color: '#94a3b8', borderTop: '1px solid #f1f5f9', paddingTop: '0.5rem' }}>
                  <span>Shop: {machine.company?.name || 'Main Shop'}</span>
                  <span>Agent Key: ••••••••{machine.machineKey?.slice(-4)}</span>
                </div>
              </div>
            );
          })
        ) : (
          <p style={{ color: '#94a3b8' }}>No kiosks or printers registered.</p>
        )}
      </div>

      {/* Telemetry Realtime Graph */}
      <TelemetryDashboard history={telemetryHistory} />

      {/* MODALS */}
      {previewState.isOpen && (
        <PrinterQrPreviewModal
          qr={previewState.qr}
          machine={previewState.machine}
          onClose={() => setPreviewState({ isOpen: false, qr: null, machine: null })}
          onOpenPrintFlyer={(qr, machine) => {
            setPreviewState({ isOpen: false, qr: null, machine: null });
            setFlyerState({ isOpen: true, qr, machine });
          }}
          onOpenRotate={(qr, machine) => {
            setPreviewState({ isOpen: false, qr: null, machine: null });
            setRotateState({ isOpen: true, qr, machine, isSubmitting: false, errorMsg: '' });
          }}
          onOpenRevoke={(qr, machine) => {
            setPreviewState({ isOpen: false, qr: null, machine: null });
            setRevokeState({ isOpen: true, qr, machine, isSubmitting: false, errorMsg: '' });
          }}
          isAuthorized={canManageMachine(previewState.machine)}
        />
      )}

      {flyerState.isOpen && (
        <PrintableCounterFlyer
          qr={flyerState.qr}
          machine={flyerState.machine}
          onClose={() => setFlyerState({ isOpen: false, qr: null, machine: null })}
        />
      )}

      {generateState.isOpen && (
        <PrinterQrGenerateModal
          machine={generateState.machine}
          onConfirm={handleGenerateConfirm}
          onClose={() => setGenerateState({ isOpen: false, machine: null, isSubmitting: false, errorMsg: '' })}
          isSubmitting={generateState.isSubmitting}
          errorMsg={generateState.errorMsg}
        />
      )}

      {rotateState.isOpen && (
        <PrinterQrRotateModal
          qr={rotateState.qr}
          machine={rotateState.machine}
          onConfirm={handleRotateConfirm}
          onClose={() => setRotateState({ isOpen: false, qr: null, machine: null, isSubmitting: false, errorMsg: '' })}
          isSubmitting={rotateState.isSubmitting}
          errorMsg={rotateState.errorMsg}
        />
      )}

      {revokeState.isOpen && (
        <PrinterQrRevokeModal
          qr={revokeState.qr}
          machine={revokeState.machine}
          onConfirm={handleRevokeConfirm}
          onClose={() => setRevokeState({ isOpen: false, qr: null, machine: null, isSubmitting: false, errorMsg: '' })}
          isSubmitting={revokeState.isSubmitting}
          errorMsg={revokeState.errorMsg}
        />
      )}

      {ledgerState.isOpen && (
        <PrinterQrLedgerModal
          machine={ledgerState.machine}
          ledger={ledgerState.ledger}
          onClose={() => setLedgerState({ isOpen: false, machine: null, ledger: null, isLoading: false })}
          onOpenPreview={(qr, machine) => {
            setLedgerState({ isOpen: false, machine: null, ledger: null, isLoading: false });
            setPreviewState({ isOpen: true, qr, machine });
          }}
        />
      )}

      {suppressionModalState.isOpen && (
        <PrinterAdSuppressionModal
          machine={suppressionModalState.machine}
          isOpen={suppressionModalState.isOpen}
          onClose={() => setSuppressionModalState({ isOpen: false, machine: null })}
          onSuccess={() => {
            setGlobalSuccess('Advertisement suppression updated successfully');
            setTimeout(() => setGlobalSuccess(''), 4000);
            if (onRefresh) onRefresh();
          }}
        />
      )}
    </div>
  );
};
