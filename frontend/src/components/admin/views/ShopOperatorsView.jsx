import React from 'react';
import { Store, UserCheck, Shield, Printer } from 'lucide-react';

export const ShopOperatorsView = ({ companies, machines, operators, isSuperadmin }) => {
  return (
    <div>
      {/* Companies & Shops */}
      <div style={{ marginBottom: '2rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem' }}>
          <Store size={20} color="#4f46e5" />
          <h3 style={{ margin: 0, fontSize: '1.125rem', fontWeight: 700, color: '#0f172a' }}>
            Registered Franchisee Shops & Companies
          </h3>
        </div>

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
                  <span>🖨️ Machines: <strong>{comp._count?.machines || 0}</strong></span>
                  <span>👥 Operators: <strong>{comp._count?.users || 0}</strong></span>
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
                <th>Company / Shop</th>
                <th>Created At</th>
              </tr>
            </thead>
            <tbody>
              {!operators || operators.length === 0 ? (
                <tr>
                  <td colSpan={5} style={{ textAlign: 'center', padding: '2rem', color: '#94a3b8' }}>
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
