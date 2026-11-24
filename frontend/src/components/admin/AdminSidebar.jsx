import React from 'react';
import { 
  LayoutDashboard, 
  Printer, 
  Users, 
  FileText, 
  CreditCard, 
  RotateCcw, 
  Receipt, 
  DollarSign, 
  Megaphone,
  CheckCircle, 
  Store, 
  Download, 
  ShieldCheck, 
  LogOut,
  X
} from 'lucide-react';

export const AdminSidebar = ({ currentTab, onSelectTab, user, onLogout, isOpen, onClose }) => {
  const isSuperadmin = user?.role === 'SUPERADMIN';

  const navItems = [
    { id: 'overview', label: 'Overview', icon: LayoutDashboard, roles: ['SUPERADMIN', 'FRANCHISEE'] },
    { id: 'jobs', label: 'Print Jobs', icon: FileText, roles: ['SUPERADMIN', 'FRANCHISEE'] },
    { id: 'printers', label: 'Printers & Telemetry', icon: Printer, roles: ['SUPERADMIN', 'FRANCHISEE'] },
    { id: 'customers', label: 'Customers', icon: Users, roles: ['SUPERADMIN', 'FRANCHISEE'] },
    { id: 'payments', label: 'Payments', icon: CreditCard, roles: ['SUPERADMIN', 'FRANCHISEE'] },
    { id: 'refunds', label: 'Refunds', icon: RotateCcw, roles: ['SUPERADMIN', 'FRANCHISEE'] },
    { id: 'invoices', label: 'Invoices & Credit Notes', icon: Receipt, roles: ['SUPERADMIN', 'FRANCHISEE'] },
    { id: 'pricing', label: 'Pricing Profiles', icon: DollarSign, roles: ['SUPERADMIN', 'FRANCHISEE'] },
    { id: 'advertisements', label: 'Advertisements', icon: Megaphone, roles: ['SUPERADMIN', 'FRANCHISEE'] },
    { id: 'reconciliation', label: 'Reconciliation', icon: CheckCircle, roles: ['SUPERADMIN', 'FRANCHISEE'] },
    { id: 'shop', label: 'Shop & Operators', icon: Store, roles: ['SUPERADMIN', 'FRANCHISEE'] },
    { id: 'reports', label: 'Reports & Export', icon: Download, roles: ['SUPERADMIN', 'FRANCHISEE'] },
    { id: 'audit', label: 'Audit Logs', icon: ShieldCheck, roles: ['SUPERADMIN', 'FRANCHISEE'] },
  ];

  const visibleItems = navItems.filter(item => item.roles.includes(user?.role || 'FRANCHISEE'));

  return (
    <aside className={`admin-sidebar ${isOpen ? 'open' : ''}`}>
      <div className="admin-sidebar-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem' }}>
          <div style={{
            background: 'linear-gradient(135deg, #1D4ED8 0%, #0F172A 100%)',
            border: '1px solid #D4AF37',
            borderRadius: '8px',
            padding: '5px 8px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: '0 0 8px rgba(212, 175, 55, 0.3)'
          }}>
            <span style={{ color: '#D4AF37', fontWeight: 900, fontSize: '0.85rem' }}>S3K</span>
          </div>
          <div>
            <div style={{ fontWeight: 700, fontSize: '1rem', color: '#ffffff', letterSpacing: '-0.02em' }}>
              Print <span style={{ color: '#D4AF37' }}>Yourself</span>
            </div>
            <div style={{ fontSize: '0.6875rem', color: '#94a3b8' }}>Admin Workspace</div>
          </div>
        </div>
        <button 
          onClick={onClose} 
          className="mobile-close-btn"
          style={{ background: 'transparent', border: 'none', color: '#94a3b8', cursor: 'pointer', display: 'none' }}
        >
          <X size={18} />
        </button>
      </div>

      {/* User profile brief */}
      <div style={{ padding: '0.875rem 1.25rem', borderBottom: '1px solid #1e293b', background: 'rgba(255, 255, 255, 0.02)' }}>
        <div style={{ fontSize: '0.8125rem', fontWeight: 600, color: '#f1f5f9', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {user?.name || 'Administrator'}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', marginTop: '0.25rem' }}>
          <span style={{
            fontSize: '0.625rem',
            padding: '2px 6px',
            borderRadius: '4px',
            background: isSuperadmin ? 'rgba(99, 102, 241, 0.2)' : 'rgba(16, 185, 129, 0.2)',
            color: isSuperadmin ? '#a5b4fc' : '#6ee7b7',
            fontWeight: 600
          }}>
            {user?.role || 'STAFF'}
          </span>
          {user?.company?.name && (
            <span style={{ fontSize: '0.6875rem', color: '#64748b', truncate: true }}>
              · {user.company.name}
            </span>
          )}
        </div>
      </div>

      <nav className="admin-nav">
        {visibleItems.map(item => {
          const Icon = item.icon;
          const isActive = currentTab === item.id;
          return (
            <button
              key={item.id}
              className={`admin-nav-item ${isActive ? 'active' : ''}`}
              onClick={() => {
                onSelectTab(item.id);
                if (onClose) onClose();
              }}
            >
              <Icon size={18} />
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>

      <div className="admin-sidebar-footer">
        <button
          onClick={onLogout}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
            background: 'transparent',
            border: 'none',
            color: '#ef4444',
            fontSize: '0.8125rem',
            fontWeight: 500,
            cursor: 'pointer',
            padding: '0.375rem 0.5rem',
            borderRadius: '6px'
          }}
        >
          <LogOut size={16} />
          <span>Sign Out</span>
        </button>
        <span style={{ fontSize: '0.6875rem', color: '#475569' }}>v5.0-ready</span>
      </div>
    </aside>
  );
};
