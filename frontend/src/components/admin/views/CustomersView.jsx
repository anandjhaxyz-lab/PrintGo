import React, { useState } from 'react';
import { Users, Search, Phone, Mail, FileText } from 'lucide-react';

export const CustomersView = ({ customers }) => {
  const [search, setSearch] = useState('');

  const filtered = (customers || []).filter(c => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      (c.phone && c.phone.includes(q)) ||
      (c.email && c.email.toLowerCase().includes(q)) ||
      (c.name && c.name.toLowerCase().includes(q))
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
            placeholder="Search phone number, email or name..."
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
              <th>Customer ID</th>
              <th>Phone</th>
              <th>Email</th>
              <th>Name</th>
              <th>Total Print Orders</th>
              <th>First Seen</th>
              <th>Last Seen</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={7} style={{ textAlign: 'center', padding: '3rem', color: '#94a3b8' }}>
                  No customer records found.
                </td>
              </tr>
            ) : (
              filtered.map(c => (
                <tr key={c.id}>
                  <td>
                    <span style={{ fontFamily: 'monospace', fontSize: '0.75rem', color: '#64748b' }}>
                      {c.id.slice(0, 8)}...
                    </span>
                  </td>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '4px', fontWeight: 600, color: '#0f172a' }}>
                      <Phone size={12} color="#64748b" /> {c.phone || 'Anonymous Walk-in'}
                    </div>
                  </td>
                  <td>
                    <span style={{ fontSize: '0.8125rem', color: '#475569' }}>{c.email || '—'}</span>
                  </td>
                  <td>
                    <span style={{ fontSize: '0.8125rem', color: '#475569' }}>{c.name || 'Walk-in'}</span>
                  </td>
                  <td>
                    <span style={{ fontWeight: 700, color: '#4f46e5' }}>
                      {c._count?.printJobs || 0}
                    </span>
                  </td>
                  <td style={{ fontSize: '0.75rem', color: '#64748b', whiteSpace: 'nowrap' }}>
                    {new Date(c.createdAt).toLocaleDateString()}
                  </td>
                  <td style={{ fontSize: '0.75rem', color: '#64748b', whiteSpace: 'nowrap' }}>
                    {new Date(c.updatedAt).toLocaleDateString()}
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
