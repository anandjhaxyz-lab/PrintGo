import React, { useState } from 'react';
import axios from 'axios';
import { Store, UserCheck, Shield, PlusCircle, CheckCircle, Copy, AlertCircle, X } from 'lucide-react';

const API_URL = import.meta.env.VITE_API_URL || '';

export const ShopOperatorsView = ({ companies, machines, operators, isSuperadmin, onRefresh }) => {
  const [showRegisterModal, setShowRegisterModal] = useState(false);
  const [formData, setFormData] = useState({
    name: '',
    contactPerson: '',
    email: '',
    phone: '',
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [createdInfo, setCreatedInfo] = useState(null);
  const [copied, setCopied] = useState(false);

  const handleRegisterSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const res = await axios.post(`${API_URL}/api/companies`, {
        name: formData.name.trim(),
        contactPerson: formData.contactPerson.trim() || undefined,
        email: formData.email.trim(),
        phone: formData.phone.trim() || undefined,
      });

      if (res.data?.success) {
        const fullActivationUrl = `${window.location.origin}${res.data.activationUrl}`;
        setCreatedInfo({
          company: res.data.company,
          user: res.data.user,
          activationUrl: fullActivationUrl,
          expiresAt: res.data.expiresAt,
        });
        if (onRefresh) onRefresh();
      } else {
        setError(res.data?.message || 'Failed to create franchise shop.');
      }
    } catch (err) {
      setError(
        err.response?.data?.error ||
        err.response?.data?.message ||
        'Failed to register company. Please check input values.'
      );
    } finally {
      setLoading(false);
    }
  };

  const handleCopyLink = () => {
    if (createdInfo?.activationUrl) {
      navigator.clipboard.writeText(createdInfo.activationUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    }
  };

  const resetModal = () => {
    setShowRegisterModal(false);
    setCreatedInfo(null);
    setFormData({ name: '', contactPerson: '', email: '', phone: '' });
    setError('');
    setCopied(false);
  };

  return (
    <div>
      {/* Header and Franchise Registration */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem', flexWrap: 'wrap', gap: '1rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <Store size={22} color="#4f46e5" />
          <h3 style={{ margin: 0, fontSize: '1.25rem', fontWeight: 700, color: '#0f172a' }}>
            Registered Franchisee Shops & Companies
          </h3>
        </div>

        {isSuperadmin && (
          <button
            onClick={() => setShowRegisterModal(true)}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.5rem',
              padding: '0.625rem 1rem',
              background: '#4f46e5',
              color: '#ffffff',
              border: 'none',
              borderRadius: '8px',
              fontSize: '0.875rem',
              fontWeight: 600,
              cursor: 'pointer',
              boxShadow: '0 2px 8px rgba(79, 70, 229, 0.25)'
            }}
          >
            <PlusCircle size={18} />
            <span>Register Franchise Shop</span>
          </button>
        )}
      </div>

      {/* Modal Dialog for Registering Franchise */}
      {showRegisterModal && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: 'rgba(15, 23, 42, 0.6)',
          backdropFilter: 'blur(3px)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 1000,
          padding: '1rem'
        }}>
          <div style={{
            background: '#ffffff',
            borderRadius: '12px',
            maxWidth: '520px',
            width: '100%',
            padding: '2rem',
            boxShadow: '0 10px 25px rgba(0, 0, 0, 0.15)',
            maxHeight: '90vh',
            overflowY: 'auto'
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.25rem' }}>
              <h4 style={{ margin: 0, fontSize: '1.125rem', fontWeight: 700, color: '#0f172a' }}>
                {createdInfo ? 'Franchise Registered Successfully' : 'Register New Franchise Shop'}
              </h4>
              <button
                onClick={resetModal}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#64748b' }}
              >
                <X size={20} />
              </button>
            </div>

            {error && (
              <div style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: '0.5rem',
                padding: '0.75rem',
                background: '#fef2f2',
                border: '1px solid #fecaca',
                borderRadius: '6px',
                color: '#b91c1c',
                fontSize: '0.8125rem',
                marginBottom: '1rem'
              }}>
                <AlertCircle size={16} style={{ flexShrink: 0, marginTop: '2px' }} />
                <span>{error}</span>
              </div>
            )}

            {createdInfo ? (
              <div>
                <div style={{
                  padding: '1rem',
                  background: '#f0fdf4',
                  border: '1px solid #bbf7d0',
                  borderRadius: '8px',
                  marginBottom: '1.25rem'
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: '#166534', fontWeight: 600, marginBottom: '0.25rem' }}>
                    <CheckCircle size={18} />
                    <span>Company & Franchisee Account Created</span>
                  </div>
                  <p style={{ margin: 0, fontSize: '0.8125rem', color: '#15803d' }}>
                    Company: <strong>{createdInfo.company.name}</strong> ({createdInfo.company.contactEmail})
                  </p>
                </div>

                <div style={{ marginBottom: '1.25rem' }}>
                  <label style={{ display: 'block', fontSize: '0.8125rem', fontWeight: 600, color: '#334155', marginBottom: '0.375rem' }}>
                    Single-Use Secure Activation URL (Expires in 24h)
                  </label>
                  <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <input
                      type="text"
                      readOnly
                      value={createdInfo.activationUrl}
                      style={{
                        flex: 1,
                        padding: '0.5rem 0.75rem',
                        fontSize: '0.8125rem',
                        background: '#f8fafc',
                        border: '1px solid #cbd5e1',
                        borderRadius: '6px',
                        fontFamily: 'monospace',
                        color: '#334155'
                      }}
                    />
                    <button
                      type="button"
                      onClick={handleCopyLink}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '0.375rem',
                        padding: '0.5rem 0.75rem',
                        background: copied ? '#059669' : '#4f46e5',
                        color: '#ffffff',
                        border: 'none',
                        borderRadius: '6px',
                        fontSize: '0.8125rem',
                        fontWeight: 600,
                        cursor: 'pointer'
                      }}
                    >
                      <Copy size={14} />
                      <span>{copied ? 'Copied!' : 'Copy'}</span>
                    </button>
                  </div>
                  <p style={{ fontSize: '0.75rem', color: '#64748b', marginTop: '0.5rem', marginBottom: 0 }}>
                    Provide this link to the franchisee administrator. No temporary password was generated; the franchisee will securely set their initial password upon opening this link.
                  </p>
                </div>

                <button
                  type="button"
                  onClick={resetModal}
                  style={{
                    width: '100%',
                    padding: '0.625rem',
                    background: '#e2e8f0',
                    color: '#334155',
                    border: 'none',
                    borderRadius: '6px',
                    fontSize: '0.875rem',
                    fontWeight: 600,
                    cursor: 'pointer'
                  }}
                >
                  Done
                </button>
              </div>
            ) : (
              <form onSubmit={handleRegisterSubmit}>
                <div style={{ marginBottom: '1rem' }}>
                  <label style={{ display: 'block', fontSize: '0.8125rem', fontWeight: 600, color: '#334155', marginBottom: '0.375rem' }}>
                    Shop / Company Name *
                  </label>
                  <input
                    type="text"
                    required
                    value={formData.name}
                    onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                    placeholder="e.g. Metro Express Prints"
                    style={{
                      width: '100%',
                      padding: '0.5rem 0.75rem',
                      border: '1px solid #cbd5e1',
                      borderRadius: '6px',
                      fontSize: '0.875rem',
                      boxSizing: 'border-box'
                    }}
                  />
                </div>

                <div style={{ marginBottom: '1rem' }}>
                  <label style={{ display: 'block', fontSize: '0.8125rem', fontWeight: 600, color: '#334155', marginBottom: '0.375rem' }}>
                    Contact Person (Franchisee Name)
                  </label>
                  <input
                    type="text"
                    value={formData.contactPerson}
                    onChange={(e) => setFormData({ ...formData, contactPerson: e.target.value })}
                    placeholder="e.g. Ramesh Kumar"
                    style={{
                      width: '100%',
                      padding: '0.5rem 0.75rem',
                      border: '1px solid #cbd5e1',
                      borderRadius: '6px',
                      fontSize: '0.875rem',
                      boxSizing: 'border-box'
                    }}
                  />
                </div>

                <div style={{ marginBottom: '1rem' }}>
                  <label style={{ display: 'block', fontSize: '0.8125rem', fontWeight: 600, color: '#334155', marginBottom: '0.375rem' }}>
                    Contact Email (Used for Franchisee Login) *
                  </label>
                  <input
                    type="email"
                    required
                    value={formData.email}
                    onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                    placeholder="e.g. franchise@metroprint.in"
                    style={{
                      width: '100%',
                      padding: '0.5rem 0.75rem',
                      border: '1px solid #cbd5e1',
                      borderRadius: '6px',
                      fontSize: '0.875rem',
                      boxSizing: 'border-box'
                    }}
                  />
                </div>

                <div style={{ marginBottom: '1.5rem' }}>
                  <label style={{ display: 'block', fontSize: '0.8125rem', fontWeight: 600, color: '#334155', marginBottom: '0.375rem' }}>
                    Contact Phone
                  </label>
                  <input
                    type="tel"
                    value={formData.phone}
                    onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                    placeholder="e.g. +91 98765 43210"
                    style={{
                      width: '100%',
                      padding: '0.5rem 0.75rem',
                      border: '1px solid #cbd5e1',
                      borderRadius: '6px',
                      fontSize: '0.875rem',
                      boxSizing: 'border-box'
                    }}
                  />
                </div>

                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem' }}>
                  <button
                    type="button"
                    onClick={resetModal}
                    style={{
                      padding: '0.5rem 1rem',
                      background: '#f1f5f9',
                      color: '#475569',
                      border: 'none',
                      borderRadius: '6px',
                      fontSize: '0.875rem',
                      fontWeight: 600,
                      cursor: 'pointer'
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={loading}
                    style={{
                      padding: '0.5rem 1.25rem',
                      background: loading ? '#94a3b8' : '#4f46e5',
                      color: '#ffffff',
                      border: 'none',
                      borderRadius: '6px',
                      fontSize: '0.875rem',
                      fontWeight: 600,
                      cursor: loading ? 'not-allowed' : 'pointer'
                    }}
                  >
                    {loading ? 'Creating...' : 'Register & Generate Activation Link'}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}

      {/* Companies & Shops List */}
      <div style={{ marginBottom: '2rem' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '1rem' }}>
          {companies && companies.length > 0 ? (
            companies.map(comp => (
              <div key={comp.id} className="admin-kpi-card">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                  <h4 style={{ margin: 0, fontSize: '1rem', fontWeight: 600, color: '#0f172a' }}>{comp.name}</h4>
                  <span style={{ fontSize: '0.6875rem', background: '#ecfdf5', color: '#059669', padding: '2px 8px', borderRadius: '4px', fontWeight: 600 }}>
                    ACTIVE
                  </span>
                </div>
                <div style={{ fontSize: '0.75rem', color: '#64748b', marginBottom: '0.5rem' }}>
                  Email: {comp.contactEmail} | Phone: {comp.contactPhone || 'N/A'}
                </div>
                <div style={{ display: 'flex', gap: '1rem', borderTop: '1px solid #f1f5f9', paddingTop: '0.5rem', fontSize: '0.75rem' }}>
                  <span>🖨️ Machines: <strong>{comp._count?.machines || comp.machines?.length || 0}</strong></span>
                  <span>👥 Operators: <strong>{comp._count?.users || comp.users?.length || 0}</strong></span>
                </div>
              </div>
            ))
          ) : (
            <p style={{ color: '#94a3b8' }}>No companies registered.</p>
          )}
        </div>
      </div>

      {/* Operator User Accounts */}
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem' }}>
          <UserCheck size={20} color="#059669" />
          <h3 style={{ margin: 0, fontSize: '1.125rem', fontWeight: 700, color: '#0f172a' }}>
            Operators & Administrative Users
          </h3>
        </div>

        <div className="admin-table-container">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Operator Name</th>
                <th>Email</th>
                <th>Role</th>
                <th>Status</th>
                <th>Company / Shop</th>
                <th>Created At</th>
              </tr>
            </thead>
            <tbody>
              {!operators || operators.length === 0 ? (
                <tr>
                  <td colSpan={6} style={{ textAlign: 'center', padding: '2rem', color: '#94a3b8' }}>
                    No operator accounts found.
                  </td>
                </tr>
              ) : (
                operators.map(u => (
                  <tr key={u.id}>
                    <td>
                      <span style={{ fontWeight: 600, color: '#0f172a' }}>{u.name}</span>
                    </td>
                    <td style={{ fontSize: '0.8125rem', color: '#475569' }}>
                      {u.email}
                    </td>
                    <td>
                      <span style={{
                        padding: '2px 8px',
                        borderRadius: '4px',
                        fontSize: '0.6875rem',
                        fontWeight: 600,
                        background: u.role === 'SUPERADMIN' ? '#e0e7ff' : '#ecfdf5',
                        color: u.role === 'SUPERADMIN' ? '#4338ca' : '#059669'
                      }}>
                        {u.role}
                      </span>
                    </td>
                    <td>
                      <span style={{
                        padding: '2px 8px',
                        borderRadius: '4px',
                        fontSize: '0.6875rem',
                        fontWeight: 600,
                        background: u.isActive === true ? '#f0fdf4' : u.isActive === false ? '#fef2f2' : '#f1f5f9',
                        color: u.isActive === true ? '#166534' : u.isActive === false ? '#991b1b' : '#64748b'
                      }}>
                        {u.isActive === true ? 'ACTIVE' : u.isActive === false ? 'INACTIVE' : 'UNKNOWN'}
                      </span>
                    </td>
                    <td style={{ fontSize: '0.8125rem', color: '#64748b' }}>
                      {u.company?.name || 'Platform Global'}
                    </td>
                    <td style={{ fontSize: '0.75rem', color: '#64748b' }}>
                      {new Date(u.createdAt).toLocaleDateString()}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
