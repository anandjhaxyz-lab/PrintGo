import React, { useState } from 'react';
import { ShieldCheck, Search, Clock, User } from 'lucide-react';

export const AuditLogsView = ({ logs }) => {
  const [search, setSearch] = useState('');

  const filtered = (logs || []).filter(l => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      l.action.toLowerCase().includes(q) ||
      (l.details && l.details.toLowerCase().includes(q)) ||
      (l.user?.name && l.user.name.toLowerCase().includes(q))
    );
  });

  return (
    <div>
      <div className="admin-filter-bar">
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flex: 1, maxWidth: 400 }}>
          <Search size={16} color="#94a3b8" />
          <input
            type="text"
            className="admin-input"
            placeholder="Search action, details, operator..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ width: '100%' }}
          />
        </div>
      </div>

      <div className="admin-table-container">
        <table className="admin-table">
          <thead>
            <tr>
              <th>Timestamp</th>
              <th>Operator / Actor</th>
              <th>Action Event</th>
              <th>Audit Trail Details (Redacted)</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={4} style={{ textAlign: 'center', padding: '3rem', color: '#94a3b8' }}>
                  No administrative activity logs found.
                </td>
              </tr>
            ) : (
              filtered.map(l => (
                <tr key={l.id}>
                  <td style={{ fontSize: '0.75rem', color: '#64748b', whiteSpace: 'nowrap' }}>
                    {new Date(l.createdAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'medium' })}
                  </td>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '4px', fontWeight: 600, fontSize: '0.8125rem', color: '#0f172a' }}>
                      <User size={12} color="#64748b" />
                      {l.user?.name || l.userId || 'SYSTEM'}
                    </div>
                    {l.user?.role && (
                      <span style={{ fontSize: '0.625rem', color: '#64748b' }}>{l.user.role}</span>
                    )}
                  </td>
                  <td>
                    <span style={{
                      padding: '2px 8px',
                      borderRadius: '4px',
                      fontSize: '0.6875rem',
                      fontWeight: 600,
                      background: '#f1f5f9',
                      color: '#334155',
                      fontFamily: 'monospace'
                    }}>
                      {l.action}
                    </span>
                  </td>
                  <td style={{ fontSize: '0.8125rem', color: '#475569', maxWidth: 450, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={l.details}>
                    {l.details || 'System event recorded'}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};
