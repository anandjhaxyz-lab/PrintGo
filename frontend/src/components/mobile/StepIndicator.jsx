import React from 'react';

export const StepIndicator = ({ step }) => (
  <div className="flex justify-center items-center" style={{ padding: '0.4rem 0.5rem', gap: '0.35rem', width: '100%', flexShrink: 0 }}>
    {['Upload', 'Settings', 'Pay', 'Done'].map((label, i) => {
      const isCompleted = step > i + 1;
      const isActive = step === i + 1;

      return (
        <React.Fragment key={label}>
          <div className="flex items-center gap-1" style={{ flexDirection: 'column' }}>
            <div style={{
              width: 28,
              height: 28,
              borderRadius: '50%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '0.75rem',
              fontWeight: 800,
              background: isCompleted
                ? 'linear-gradient(135deg, #F59E0B 0%, #D4AF37 100%)'
                : isActive
                  ? 'linear-gradient(135deg, #1D4ED8 0%, #2563EB 100%)'
                  : 'rgba(15, 23, 42, 0.7)',
              color: isCompleted ? '#070E1E' : isActive ? '#FFFFFF' : '#64748B',
              border: isActive
                ? '2px solid #D4AF37'
                : isCompleted
                  ? '1.5px solid #F59E0B'
                  : '1px solid rgba(148, 163, 184, 0.25)',
              boxShadow: isActive
                ? '0 0 12px rgba(212, 175, 55, 0.5)'
                : isCompleted
                  ? '0 0 8px rgba(245, 158, 11, 0.35)'
                  : 'none',
              transition: 'all 0.25s ease'
            }}>
              {isCompleted ? '✓' : i + 1}
            </div>
            <span style={{
              fontSize: '0.66rem',
              color: isActive ? '#F59E0B' : isCompleted ? '#FFFFFF' : '#64748B',
              fontWeight: isActive ? 800 : 500,
              letterSpacing: '0.01em',
              lineHeight: 1
            }}>
              {label}
            </span>
          </div>
          {i < 3 && (
            <div style={{
              flex: 1,
              maxWidth: 36,
              height: 2,
              borderRadius: 1,
              background: step > i + 1
                ? 'linear-gradient(90deg, #D4AF37, #2563EB)'
                : 'rgba(148, 163, 184, 0.2)',
              transition: 'background 0.3s ease',
              marginBottom: '1rem'
            }} />
          )}
        </React.Fragment>
      );
    })}
  </div>
);
