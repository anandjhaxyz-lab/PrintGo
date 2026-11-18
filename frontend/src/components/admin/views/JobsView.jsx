import React, { useState } from 'react';
import axios from 'axios';
import { 
  Search, 
  Filter, 
  Eye, 
  Printer, 
  FileText, 
  ShieldAlert, 
  Download, 
  Clock, 
  X, 
  AlertCircle,
  CheckCircle,
  CheckCircle2,
  FileCheck,
  Banknote,
  Loader
} from 'lucide-react';

const API_URL = import.meta.env.VITE_API_URL || '';

export const JobsView = ({ jobs, machines, onRefresh, onReconcileJob }) => {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [paymentFilter, setPaymentFilter] = useState('');
  const [colorFilter, setColorFilter] = useState('');
  const [duplexFilter, setDuplexFilter] = useState('');
  const [machineFilter, setMachineFilter] = useState('');
  const [testFilter, setTestFilter] = useState('');
  const [selectedJob, setSelectedJob] = useState(null);
  const [cashModalState, setCashModalState] = useState({
    isOpen: false,
    job: null,
    isConfirming: false,
    error: '',
    successMsg: ''
  });

  const handleConfirmCash = async (job) => {
    if (!job) return;
    setCashModalState(prev => ({ ...prev, isConfirming: true, error: '' }));
    try {
      const res = await axios.post(`${API_URL}/api/admin/jobs/${job.shortId}/confirm-cash`, {
        amount: job.cost
      });
      if (res.data?.success) {
        setCashModalState({
          isOpen: false,
          job: null,
          isConfirming: false,
          error: '',
          successMsg: `Cash payment of ₹${job.cost} confirmed for Job #${job.shortId}. Print job dispatched to queue!`
        });
        if (selectedJob && selectedJob.id === job.id) {
          setSelectedJob(null);
        }
        if (onRefresh) onRefresh();
      } else {
        throw new Error(res.data?.error || 'Cash confirmation failed');
      }
    } catch (err) {
      const errMsg = err.response?.data?.error || err.message || 'Failed to confirm cash payment';
      setCashModalState(prev => ({ ...prev, isConfirming: false, error: errMsg }));
    }
  };

  // Filter jobs
  const filteredJobs = jobs.filter(job => {
    if (search) {
      const q = search.toLowerCase();
      const matchId = (job.shortId || job.id).toLowerCase().includes(q);
      const matchDoc = job.document?.originalName?.toLowerCase().includes(q) || job.originalName?.toLowerCase().includes(q);
      const matchCust = job.customer?.phone?.includes(q) || job.customer?.email?.toLowerCase().includes(q);
      if (!matchId && !matchDoc && !matchCust) return false;
    }
    if (statusFilter && job.status !== statusFilter) return false;
    if (paymentFilter && job.payment?.status !== paymentFilter) return false;
    if (colorFilter && job.color !== colorFilter) return false;
    if (duplexFilter && job.duplex !== duplexFilter) return false;
    if (machineFilter && job.machineId !== machineFilter) return false;
    if (testFilter === 'test' && !job.isTest) return false;
    if (testFilter === 'commercial' && job.isTest) return false;
    return true;
  });

  const getStatusBadge = (status) => {
    switch (status) {
      case 'COMPLETED':
        return <span style={{ padding: '3px 8px', borderRadius: '9999px', fontSize: '0.75rem', fontWeight: 600, background: '#ecfdf5', color: '#059669' }}>COMPLETED</span>;
      case 'PRINTING':
        return <span style={{ padding: '3px 8px', borderRadius: '9999px', fontSize: '0.75rem', fontWeight: 600, background: '#eff6ff', color: '#2563eb' }}>PRINTING</span>;
      case 'WAITING':
        return <span style={{ padding: '3px 8px', borderRadius: '9999px', fontSize: '0.75rem', fontWeight: 600, background: '#fef3c7', color: '#d97706' }}>WAITING</span>;
      case 'PENDING_PAYMENT':
        return <span style={{ padding: '3px 8px', borderRadius: '9999px', fontSize: '0.75rem', fontWeight: 600, background: '#f1f5f9', color: '#64748b' }}>PENDING PAY</span>;
      case 'FAILED':
      case 'CANCELLED':
        return <span style={{ padding: '3px 8px', borderRadius: '9999px', fontSize: '0.75rem', fontWeight: 600, background: '#fef2f2', color: '#dc2626' }}>{status}</span>;
      default:
        return <span style={{ padding: '3px 8px', borderRadius: '9999px', fontSize: '0.75rem', fontWeight: 600, background: '#f8fafc', color: '#475569' }}>{status}</span>;
    }
  };

  const getPaymentBadge = (payment) => {
    if (!payment) {
      return <span style={{ fontSize: '0.75rem', color: '#94a3b8' }}>Unpaid</span>;
    }
    const isDemo = payment.paymentMethod === 'demo' || (payment.gatewayOrderId && payment.gatewayOrderId.startsWith('demo_order_'));
    const isCash = payment.paymentMethod === 'cash' || (payment.gatewayOrderId && payment.gatewayOrderId.startsWith('cash_order_'));
    if (payment.status === 'SUCCESS') {
      return (
        <span style={{ 
          padding: '2px 6px', 
          borderRadius: '4px', 
          fontSize: '0.6875rem', 
          fontWeight: 600, 
          background: isCash ? '#ecfdf5' : isDemo ? '#fffbeb' : '#f0f9ff',
          color: isCash ? '#059669' : isDemo ? '#d97706' : '#0284c7',
          border: `1px solid ${isCash ? '#a7f3d0' : isDemo ? '#fde68a' : '#bae6fd'}`
        }}>
          {isCash ? '💵 CASH PAID' : isDemo ? '🧪 DEMO PAID' : '💳 PAID (Cashfree)'}
        </span>
      );
    }
    return <span style={{ fontSize: '0.75rem', color: '#ef4444' }}>{payment.status}</span>;
  };

  return (
    <div>
      {/* Cash Confirmation Success Notification */}
      {cashModalState.successMsg && (
        <div style={{
          background: '#ecfdf5',
          border: '1px solid #a7f3d0',
          color: '#065f46',
          borderRadius: '8px',
          padding: '0.75rem 1rem',
          marginBottom: '1rem',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          fontSize: '0.8125rem'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <CheckCircle2 size={16} color="#059669" />
            <span style={{ fontWeight: 600 }}>{cashModalState.successMsg}</span>
          </div>
          <button
            onClick={() => setCashModalState(prev => ({ ...prev, successMsg: '' }))}
            style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: '#065f46' }}
          >
            <X size={16} />
          </button>
        </div>
      )}

      {/* Filter Toolbar */}
      <div className="admin-filter-bar">
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flex: 1, minWidth: 200 }}>
          <Search size={16} color="#94a3b8" />
          <input
            type="text"
            className="admin-input"
            placeholder="Search Job ID, Document, Customer..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ width: '100%' }}
          />
        </div>

        {/* Status Dropdown */}
        <select 
          className="admin-input" 
          value={statusFilter} 
          onChange={(e) => setStatusFilter(e.target.value)}
        >
          <option value="">All Job Statuses</option>
          <option value="WAITING">WAITING</option>
          <option value="PRINTING">PRINTING</option>
          <option value="COMPLETED">COMPLETED</option>
          <option value="FAILED">FAILED</option>
          <option value="CANCELLED">CANCELLED</option>
          <option value="PENDING_PAYMENT">PENDING_PAYMENT</option>
        </select>

        {/* Payment Dropdown */}
        <select 
          className="admin-input" 
          value={paymentFilter} 
          onChange={(e) => setPaymentFilter(e.target.value)}
        >
          <option value="">All Payments</option>
          <option value="SUCCESS">PAID</option>
          <option value="PENDING">PENDING</option>
          <option value="FAILED">FAILED</option>
        </select>

        {/* Color Dropdown */}
        <select 
          className="admin-input" 
          value={colorFilter} 
          onChange={(e) => setColorFilter(e.target.value)}
        >
          <option value="">Color / B&W</option>
          <option value="bw">B&W</option>
          <option value="color">Color</option>
        </select>

        {/* Duplex Dropdown */}
        <select 
          className="admin-input" 
          value={duplexFilter} 
          onChange={(e) => setDuplexFilter(e.target.value)}
        >
          <option value="">Single / Duplex</option>
          <option value="single">Single-Sided</option>
          <option value="double">Duplex</option>
        </select>

        {/* Machine Filter */}
        {machines && machines.length > 0 && (
          <select 
            className="admin-input" 
            value={machineFilter} 
            onChange={(e) => setMachineFilter(e.target.value)}
          >
            <option value="">All Machines</option>
            {machines.map(m => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>
        )}

        {/* Test / Commercial Filter */}
        <select 
          className="admin-input" 
          value={testFilter} 
          onChange={(e) => setTestFilter(e.target.value)}
        >
          <option value="">All Types (Commercial & Test)</option>
          <option value="commercial">Commercial Only</option>
          <option value="test">Test Records Only</option>
        </select>
      </div>

      {/* Jobs Data Table */}
      <div className="admin-table-container">
        <table className="admin-table">
          <thead>
            <tr>
              <th>Job ID</th>
              <th>Document</th>
              <th>Machine</th>
              <th>Specs</th>
              <th>Cost</th>
              <th>Payment</th>
              <th>Print Status</th>
              <th>Created</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {filteredJobs.length === 0 ? (
              <tr>
                <td colSpan={9} style={{ textAlign: 'center', padding: '3rem', color: '#94a3b8' }}>
                  No print jobs match the selected filter criteria.
                </td>
              </tr>
            ) : (
              filteredJobs.map(job => {
                const isBaselineProtected = job.shortId === 'ab36197e';
                const docName = job.document?.originalName || job.originalName || 'Document';
                const machineName = job.machine?.name || 'Unassigned';
                const timeStr = new Date(job.createdAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });

                return (
                  <tr key={job.id} style={isBaselineProtected ? { background: '#fffbeb' } : {}}>
                    <td>
                      <span style={{ fontWeight: 600, color: '#4f46e5' }}>#{job.shortId}</span>
                      {job.isTest && (
                        <span style={{ 
                          display: 'inline-block', 
                          marginLeft: '6px',
                          padding: '1px 5px', 
                          borderRadius: '4px', 
                          fontSize: '0.625rem', 
                          fontWeight: 700, 
                          background: '#fef3c7', 
                          color: '#b45309',
                          border: '1px solid #fde68a'
                        }}>
                          TEST RECORD
                        </span>
                      )}
                      {isBaselineProtected && (
                        <span style={{ display: 'block', fontSize: '0.625rem', color: '#d97706', fontWeight: 700 }}>
                          🔒 Baseline Job
                        </span>
                      )}
                    </td>
                    <td>
                      <div style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 500 }} title={docName}>
                        {docName}
                      </div>
                      <div style={{ fontSize: '0.75rem', color: '#64748b' }}>
                        {job.pagesToPrint || 1} pages · {job.copies || 1} {job.copies > 1 ? 'copies' : 'copy'}
                      </div>
                    </td>
                    <td>
                      <span style={{ fontSize: '0.8125rem', color: '#334155' }}>{machineName}</span>
                    </td>
                    <td>
                      <span style={{ fontSize: '0.75rem', color: '#475569' }}>
                        {job.color === 'color' ? '🎨 Color' : '📄 B&W'} · {job.duplex === 'double' ? 'Duplex' : 'Single'}
                      </span>
                    </td>
                    <td>
                      <span style={{ fontWeight: 700, color: '#0f172a' }}>₹{job.cost || 0}</span>
                    </td>
                    <td>
                      {getPaymentBadge(job.payment)}
                    </td>
                    <td>
                      {getStatusBadge(job.status)}
                    </td>
                    <td style={{ fontSize: '0.75rem', color: '#64748b', whiteSpace: 'nowrap' }}>
                      {timeStr}
                    </td>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        {job.status === 'PENDING_PAYMENT' && (
                          <button
                            onClick={() => setCashModalState({ isOpen: true, job, isConfirming: false, error: '', successMsg: '' })}
                            style={{
                              background: '#10b981',
                              color: '#ffffff',
                              border: 'none',
                              borderRadius: '6px',
                              padding: '4px 8px',
                              display: 'flex',
                              alignItems: 'center',
                              gap: '4px',
                              fontSize: '0.75rem',
                              fontWeight: 600,
                              cursor: 'pointer',
                              boxShadow: '0 1px 2px rgba(16, 185, 129, 0.2)',
                              whiteSpace: 'nowrap'
                            }}
                            title="Confirm cash received from customer and dispatch printing"
                          >
                            <Banknote size={12} /> Confirm Cash (₹{job.cost})
                          </button>
                        )}
                        <button
                          onClick={() => setSelectedJob(job)}
                          style={{
                            background: '#f1f5f9',
                            border: '1px solid #cbd5e1',
                            borderRadius: '6px',
                            padding: '4px 8px',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '4px',
                            fontSize: '0.75rem',
                            fontWeight: 500,
                            cursor: 'pointer'
                          }}
                        >
                          <Eye size={12} /> View
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Job Details Modal */}
      {selectedJob && (
        <div className="admin-modal-backdrop" onClick={() => setSelectedJob(null)}>
          <div className="admin-modal-card" onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem', borderBottom: '1px solid #e2e8f0', paddingBottom: '0.75rem' }}>
              <div>
                <h3 style={{ margin: 0, fontSize: '1.125rem', fontWeight: 700 }}>
                  Job Details — #{selectedJob.shortId}
                </h3>
                <span style={{ fontSize: '0.75rem', color: '#64748b' }}>UUID: {selectedJob.id}</span>
              </div>
              <button 
                onClick={() => setSelectedJob(null)}
                style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: '#64748b' }}
              >
                <X size={20} />
              </button>
            </div>

            {selectedJob.isTest && (
              <div style={{ background: '#fef3c7', border: '1px solid #fde68a', borderRadius: '8px', padding: '0.625rem', marginBottom: '0.75rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <AlertCircle size={16} color="#b45309" />
                <span style={{ fontSize: '0.8125rem', color: '#92400e', fontWeight: 600 }}>
                  TEST RECORD — This job is flagged as a test transaction and is excluded from commercial revenue KPIs.
                </span>
              </div>
            )}

            {selectedJob.shortId === 'ab36197e' && (
              <div style={{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: '8px', padding: '0.75rem', marginBottom: '1rem', display: 'flex', gap: '0.5rem' }}>
                <ShieldAlert size={18} color="#d97706" />
                <span style={{ fontSize: '0.8125rem', color: '#92400e' }}>
                  <strong>Safety Notice:</strong> Historical baseline job ab36197e is permanently protected. Automated reprint dispatch and status tampering are restricted by safety policy.
                </span>
              </div>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '1rem' }}>
              <div style={{ background: '#f8fafc', padding: '0.75rem', borderRadius: '8px' }}>
                <span style={{ fontSize: '0.6875rem', color: '#64748b', textTransform: 'uppercase', fontWeight: 600 }}>Document & Pages</span>
                <p style={{ margin: '4px 0 0', fontWeight: 600, fontSize: '0.875rem' }}>{selectedJob.document?.originalName || selectedJob.originalName}</p>
                <p style={{ margin: 0, fontSize: '0.75rem', color: '#64748b' }}>{selectedJob.pagesToPrint} pages · {selectedJob.copies} copy · Paper: {selectedJob.paperSize || 'A4'}</p>
              </div>

              <div style={{ background: '#f8fafc', padding: '0.75rem', borderRadius: '8px' }}>
                <span style={{ fontSize: '0.6875rem', color: '#64748b', textTransform: 'uppercase', fontWeight: 600 }}>Commercial Cost & Payment</span>
                <p style={{ margin: '4px 0 0', fontWeight: 700, fontSize: '1rem', color: '#059669' }}>₹{selectedJob.cost}</p>
                <p style={{ margin: 0, fontSize: '0.75rem', color: '#64748b' }}>
                  Status: {selectedJob.payment?.status || 'UNPAID'} {selectedJob.payment?.paymentMethod ? `(${selectedJob.payment.paymentMethod})` : ''}
                </p>
              </div>
            </div>

            {/* Print History / Timeline */}
            <div style={{ marginBottom: '1.25rem' }}>
              <h4 style={{ fontSize: '0.875rem', fontWeight: 600, marginBottom: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.375rem' }}>
                <Clock size={14} color="#6366f1" /> Hardware Execution History
              </h4>
              {selectedJob.printHistory && selectedJob.printHistory.length > 0 ? (
                <div style={{ border: '1px solid #e2e8f0', borderRadius: '8px', padding: '0.5rem', background: '#fafafa' }}>
                  {selectedJob.printHistory.map((h, i) => (
                    <div key={i} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '0.75rem', padding: '4px 0', borderBottom: i < selectedJob.printHistory.length - 1 ? '1px solid #f1f5f9' : 'none' }}>
                      <span style={{ color: h.success ? '#059669' : '#dc2626', fontWeight: 600 }}>
                        {h.success ? '✅ Succeeded' : '❌ Failed'}
                      </span>
                      <span style={{ color: '#64748b' }}>{h.errorDetails || 'Physical print verification confirmed'}</span>
                      <span style={{ color: '#94a3b8' }}>{new Date(h.completedAt).toLocaleTimeString()}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p style={{ fontSize: '0.75rem', color: '#94a3b8', margin: 0 }}>No print agent execution logs recorded yet.</p>
              )}
            </div>

            {/* Invoices Link */}
            {selectedJob.invoice && (
              <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: '8px', padding: '0.75rem', marginBottom: '1rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div>
                  <span style={{ fontSize: '0.75rem', fontWeight: 600, color: '#166534' }}>Statutory Tax Invoice Issued</span>
                  <p style={{ margin: 0, fontSize: '0.8125rem', color: '#14532d' }}>{selectedJob.invoice.invoiceNumber} (₹{selectedJob.invoice.totalAmount})</p>
                </div>
                <a
                  href={`${API_URL}/api/jobs/${selectedJob.shortId}/invoice/download`}
                  target="_blank"
                  rel="noreferrer"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '4px',
                    fontSize: '0.75rem',
                    padding: '4px 8px',
                    background: '#16a34a',
                    color: '#ffffff',
                    borderRadius: '6px',
                    textDecoration: 'none',
                    fontWeight: 500
                  }}
                >
                  <Download size={12} /> Download PDF
                </a>
              </div>
            )}

            {/* Operator Actions */}
            <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: '0.5rem', borderTop: '1px solid #e2e8f0', paddingTop: '0.75rem' }}>
              {selectedJob.status === 'PENDING_PAYMENT' && (
                <button
                  type="button"
                  onClick={() => handleConfirmCash(selectedJob)}
                  disabled={cashModalState.isConfirming}
                  style={{
                    background: '#10b981',
                    color: '#ffffff',
                    border: 'none',
                    borderRadius: '6px',
                    padding: '6px 12px',
                    fontSize: '0.8125rem',
                    fontWeight: 600,
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    cursor: 'pointer'
                  }}
                >
                  {cashModalState.isConfirming ? (
                    <><Loader size={14} className="animate-spin" /> Confirming...</>
                  ) : (
                    <><Banknote size={14} /> Confirm Cash Received (₹{selectedJob.cost}) & Dispatch Print</>
                  )}
                </button>
              )}
              <button
                className="btn"
                onClick={() => setSelectedJob(null)}
                style={{ fontSize: '0.8125rem' }}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Cash Confirmation Dialog Modal */}
      {cashModalState.isOpen && cashModalState.job && (
        <div className="admin-modal-backdrop" onClick={() => !cashModalState.isConfirming && setCashModalState(prev => ({ ...prev, isOpen: false, job: null }))}>
          <div className="admin-modal-card" style={{ maxWidth: '440px' }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem', borderBottom: '1px solid #e2e8f0', paddingBottom: '0.75rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Banknote size={22} color="#10b981" />
                <h3 style={{ margin: 0, fontSize: '1.125rem', fontWeight: 700 }}>Confirm Cash Received</h3>
              </div>
              <button
                disabled={cashModalState.isConfirming}
                onClick={() => setCashModalState(prev => ({ ...prev, isOpen: false, job: null }))}
                style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: '#64748b' }}
              >
                <X size={18} />
              </button>
            </div>

            {cashModalState.error && (
              <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: '8px', padding: '0.625rem', marginBottom: '0.75rem', color: '#dc2626', fontSize: '0.8125rem' }}>
                {cashModalState.error}
              </div>
            )}

            <p style={{ fontSize: '0.875rem', color: '#334155', marginBottom: '1rem', lineHeight: 1.5 }}>
              Are you sure you received the exact cash payment of <strong>₹{cashModalState.job.cost}</strong> from the customer for Job <strong>#{cashModalState.job.shortId}</strong>?
            </p>

            <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '0.75rem', marginBottom: '1.25rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8125rem', marginBottom: '4px' }}>
                <span style={{ color: '#64748b' }}>Document:</span>
                <span style={{ fontWeight: 600, color: '#1e293b' }}>{cashModalState.job.document?.originalName || 'Document'}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8125rem', marginBottom: '4px' }}>
                <span style={{ color: '#64748b' }}>Pages & Copies:</span>
                <span style={{ fontWeight: 600, color: '#1e293b' }}>{cashModalState.job.pagesToPrint || 1} pages × {cashModalState.job.copies || 1}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.875rem', borderTop: '1px solid #cbd5e1', paddingTop: '6px', marginTop: '4px' }}>
                <span style={{ fontWeight: 700, color: '#0f172a' }}>Amount Collected:</span>
                <span style={{ fontWeight: 800, color: '#059669', fontSize: '1rem' }}>₹{cashModalState.job.cost}</span>
              </div>
            </div>

            <p style={{ fontSize: '0.75rem', color: '#64748b', marginBottom: '1.25rem' }}>
              Notice: Confirming cash immediately marks the order as paid, records an auditable transaction, and automatically dispatches the document to the physical printer.
            </p>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' }}>
              <button
                type="button"
                className="btn"
                disabled={cashModalState.isConfirming}
                onClick={() => setCashModalState(prev => ({ ...prev, isOpen: false, job: null }))}
                style={{ fontSize: '0.8125rem' }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => handleConfirmCash(cashModalState.job)}
                disabled={cashModalState.isConfirming}
                style={{
                  background: '#10b981',
                  color: '#ffffff',
                  border: 'none',
                  borderRadius: '6px',
                  padding: '6px 14px',
                  fontSize: '0.8125rem',
                  fontWeight: 600,
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  cursor: 'pointer'
                }}
              >
                {cashModalState.isConfirming ? (
                  <><Loader size={14} className="animate-spin" /> Confirming...</>
                ) : (
                  <><Banknote size={14} /> Confirm Cash & Dispatch Print</>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
