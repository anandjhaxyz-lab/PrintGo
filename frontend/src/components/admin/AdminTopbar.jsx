import React from 'react';
import { Menu, RefreshCw, Calendar, Radio } from 'lucide-react';

export const AdminTopbar = ({ 
  title, 
  subtitle, 
  period, 
  onPeriodChange, 
  onRefresh, 
  isRefreshing, 
  onToggleSidebar,
  isLive = true
}) => {
  return (
    <header className="admin-topbar">
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
        <button 
          onClick={onToggleSidebar}
          className="admin-hamburger"
          style={{
            background: 'transparent',
            border: '1px solid #e2e8f0',
            borderRadius: '6px',
            padding: '6px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            color: '#475569'
          }}
        >
          <Menu size={18} />
        </button>
        <div>
          <h1 style={{ fontSize: '1.25rem', fontWeight: 700, color: '#0f172a', margin: 0 }}>
            {title}
          </h1>
          {subtitle && (
            <p style={{ fontSize: '0.75rem', color: '#64748b', margin: 0 }}>
              {subtitle}
            </p>
          )}
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
        {/* Real-time Indicator */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.375rem',
          fontSize: '0.75rem',
          fontWeight: 600,
          color: isLive ? '#10b981' : '#f59e0b',
          background: isLive ? '#ecfdf5' : '#fffbeb',
          padding: '4px 8px',
          borderRadius: '9999px',
          border: `1px solid ${isLive ? '#a7f3d0' : '#fde68a'}`
        }}>
          <Radio size={14} className={isLive ? 'animate-pulse' : ''} />
          <span>{isLive ? 'Live Sync' : 'Polling'}</span>
        </div>

        {/* Date Filter */}
        {onPeriodChange && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', background: '#f8fafc', padding: '2px 4px', borderRadius: '8px', border: '1px solid #e2e8f0' }}>
            <Calendar size={14} style={{ color: '#64748b', marginLeft: '4px' }} />
            <select
              value={period}
              onChange={(e) => onPeriodChange(e.target.value)}
              style={{
                background: 'transparent',
                border: 'none',
                outline: 'none',
                fontSize: '0.8125rem',
                color: '#334155',
                fontWeight: 500,
                padding: '4px 8px',
                cursor: 'pointer'
              }}
            >
              <option value="today">Today</option>
              <option value="yesterday">Yesterday</option>
              <option value="7d">Last 7 Days</option>
              <option value="30d">Last 30 Days</option>
            </select>
          </div>
        )}

        {/* Refresh Action */}
        <button
          onClick={onRefresh}
          disabled={isRefreshing}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.375rem',
            padding: '0.45rem 0.75rem',
            background: '#ffffff',
            border: '1px solid #cbd5e1',
            borderRadius: '6px',
            fontSize: '0.8125rem',
            fontWeight: 500,
            color: '#334155',
            cursor: 'pointer'
          }}
        >
          <RefreshCw size={14} className={isRefreshing ? 'animate-spin' : ''} />
          <span>Refresh</span>
        </button>
      </div>
    </header>
  );
};
