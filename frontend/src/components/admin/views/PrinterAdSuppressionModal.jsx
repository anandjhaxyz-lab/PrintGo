import React, { useState } from 'react';
import axios from 'axios';
import { VolumeX, Clock, Ban, AlertTriangle, X, Check, ShieldAlert } from 'lucide-react';
import { getApiUrl } from '../../../utils/apiConfig';

const API_URL = getApiUrl();
const PRESET_HOURS = [2, 6, 12, 24];

export const PrinterAdSuppressionModal = ({
  machine,
  isOpen,
  onClose,
  onSuccess
}) => {
  const [mode, setMode] = useState('TEMPORARY'); // 'TEMPORARY' | 'PERMANENT'
  const [durationHours, setDurationHours] = useState(2);
  const [useCustomUntil, setUseCustomUntil] = useState(false);
  const [customUntil, setCustomUntil] = useState('');
  const [reason, setReason] = useState('');
  const [confirmPermanent, setConfirmPermanent] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  if (!isOpen || !machine) return null;

  const handleSubmit = async (e) => {
    e.preventDefault();
    setErrorMessage('');

    if (!reason.trim()) {
      setErrorMessage('Operator reason is required for compliance and audit logging.');
      return;
    }

    if (mode === 'PERMANENT' && !confirmPermanent) {
      setErrorMessage('Please check the confirmation box to permanently disable advertisements.');
      return;
    }

    if (mode === 'TEMPORARY' && useCustomUntil) {
      if (!customUntil) {
        setErrorMessage('Please select a future date and time for advertisement resumption.');
        return;
      }
      const selectedDate = new Date(customUntil);
      if (isNaN(selectedDate.getTime()) || selectedDate <= new Date()) {
        setErrorMessage('Custom expiry must be a valid future date and time.');
        return;
      }
    }

    setIsSubmitting(true);
    try {
      const payload = {
        mode,
        reason: reason.trim()
      };

      if (mode === 'TEMPORARY') {
        if (useCustomUntil) {
          payload.customUntil = new Date(customUntil).toISOString();
        } else {
          payload.durationHours = Number(durationHours);
        }
      }

      const res = await axios.post(`${API_URL}/api/machines/${machine.id}/ad-suppression`, payload);
      if (res.data?.success) {
        onSuccess(res.data);
        onClose();
      }
    } catch (err) {
      console.error('Failed to set ad suppression:', err);
      const serverError = err.response?.data?.error || err.response?.data?.message || err.message;
      if (err.response?.status === 403 && serverError.includes('Read-Only')) {
        setErrorMessage('Action blocked: Cloud Admin Dashboard is operating in Read-Only Monitoring Mode (ADMIN_READ_ONLY=true). Remote mutations are disabled.');
      } else {
        setErrorMessage(serverError || 'Failed to silence advertisements.');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div style={{
      position: 'fixed',
      inset: 0,
      background: 'rgba(0, 0, 0, 0.75)',
      backdropFilter: 'blur(4px)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 10000,
      padding: '1rem'
    }}>
      <div style={{
        background: '#0F172A',
        border: '1px solid #334155',
        borderRadius: '16px',
        width: '100%',
        maxWidth: '520px',
        boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.6)',
        color: '#F8FAFC',
        overflow: 'hidden'
      }}>
        {/* Header */}
        <div style={{
          padding: '1.25rem 1.5rem',
          borderBottom: '1px solid #1E293B',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <div style={{
              width: 38,
              height: 38,
              borderRadius: 10,
              background: 'rgba(239, 68, 68, 0.15)',
              border: '1px solid rgba(239, 68, 68, 0.3)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#F87171'
            }}>
              <VolumeX size={20} />
            </div>
            <div>
              <h3 style={{ fontSize: '1.05rem', fontWeight: 800, margin: 0, color: '#FFFFFF' }}>
                Silence Machine Advertisements
              </h3>
              <p style={{ fontSize: '0.75rem', color: '#94A3B8', margin: 0, marginTop: 2 }}>
                {machine.name} {machine.location ? `• ${machine.location}` : ''}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            style={{
              background: 'transparent',
              border: 'none',
              color: '#64748B',
              cursor: 'pointer',
              padding: 4
            }}
          >
            <X size={20} />
          </button>
        </div>

        {/* Form Body */}
        <form noValidate onSubmit={handleSubmit} style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          {errorMessage && (
            <div style={{
              background: 'rgba(239, 68, 68, 0.15)',
              border: '1px solid rgba(239, 68, 68, 0.4)',
              borderRadius: '8px',
              padding: '0.75rem 1rem',
              display: 'flex',
              alignItems: 'flex-start',
              gap: '0.625rem',
              color: '#FCA5A5',
              fontSize: '0.8125rem'
            }}>
              <AlertTriangle size={16} style={{ flexShrink: 0, marginTop: 2 }} />
              <div>{errorMessage}</div>
            </div>
          )}

          {/* Mode Tabs */}
          <div>
            <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 700, color: '#CBD5E1', marginBottom: '0.5rem' }}>
              Suppression Type
            </label>
            <div style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: '0.5rem',
              background: '#070E1E',
              padding: '4px',
              borderRadius: '10px',
              border: '1px solid #1E293B'
            }}>
              <button
                type="button"
                onClick={() => { setMode('TEMPORARY'); setErrorMessage(''); }}
                style={{
                  padding: '8px',
                  borderRadius: '7px',
                  border: 'none',
                  background: mode === 'TEMPORARY' ? '#1E293B' : 'transparent',
                  color: mode === 'TEMPORARY' ? '#F59E0B' : '#94A3B8',
                  fontWeight: 700,
                  fontSize: '0.8125rem',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '6px',
                  cursor: 'pointer',
                  transition: 'all 0.2s ease'
                }}
              >
                <Clock size={15} />
                Temporary Silence
              </button>
              <button
                type="button"
                onClick={() => { setMode('PERMANENT'); setErrorMessage(''); }}
                style={{
                  padding: '8px',
                  borderRadius: '7px',
                  border: 'none',
                  background: mode === 'PERMANENT' ? '#1E293B' : 'transparent',
                  color: mode === 'PERMANENT' ? '#EF4444' : '#94A3B8',
                  fontWeight: 700,
                  fontSize: '0.8125rem',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '6px',
                  cursor: 'pointer',
                  transition: 'all 0.2s ease'
                }}
              >
                <Ban size={15} />
                Permanent Silence
              </button>
            </div>
          </div>

          {/* Temporary Preset Duration */}
          {mode === 'TEMPORARY' ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <label style={{ fontSize: '0.75rem', fontWeight: 700, color: '#CBD5E1' }}>
                  Resumes Automatically After
                </label>
                <button
                  type="button"
                  onClick={() => setUseCustomUntil(!useCustomUntil)}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: '#60A5FA',
                    fontSize: '0.72rem',
                    fontWeight: 600,
                    cursor: 'pointer'
                  }}
                >
                  {useCustomUntil ? 'Use standard presets' : 'Specify exact date/time'}
                </button>
              </div>

              {!useCustomUntil ? (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '0.5rem' }}>
                  {PRESET_HOURS.map(hrs => (
                    <button
                      key={hrs}
                      type="button"
                      onClick={() => setDurationHours(hrs)}
                      style={{
                        padding: '10px 4px',
                        borderRadius: '8px',
                        border: `1.5px solid ${durationHours === hrs ? '#F59E0B' : '#334155'}`,
                        background: durationHours === hrs ? 'rgba(245, 158, 11, 0.15)' : '#070E1E',
                        color: durationHours === hrs ? '#FCD34D' : '#CBD5E1',
                        fontWeight: 800,
                        fontSize: '0.8125rem',
                        cursor: 'pointer',
                        textAlign: 'center'
                      }}
                    >
                      {hrs} Hours
                    </button>
                  ))}
                </div>
              ) : (
                <div>
                  <input
                    type="datetime-local"
                    value={customUntil}
                    onChange={(e) => setCustomUntil(e.target.value)}
                    style={{
                      width: '100%',
                      padding: '0.625rem 0.75rem',
                      borderRadius: '8px',
                      background: '#070E1E',
                      border: '1px solid #334155',
                      color: '#FFFFFF',
                      fontSize: '0.8125rem',
                      outline: 'none'
                    }}
                  />
                  <span style={{ fontSize: '0.6875rem', color: '#64748B', marginTop: 4, display: 'block' }}>
                    Select local date & time when advertisements should resume.
                  </span>
                </div>
              )}
            </div>
          ) : (
            /* Permanent Warning Banner */
            <div style={{
              background: 'rgba(239, 68, 68, 0.1)',
              border: '1px solid rgba(239, 68, 68, 0.3)',
              borderRadius: '10px',
              padding: '0.875rem 1rem',
              display: 'flex',
              flexDirection: 'column',
              gap: '0.5rem'
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: '#F87171', fontWeight: 700, fontSize: '0.8125rem' }}>
                <ShieldAlert size={16} />
                <span>Indefinite Ad Blackout</span>
              </div>
              <p style={{ fontSize: '0.75rem', color: '#CBD5E1', margin: 0, lineHeight: 1.4 }}>
                All advertisements on this physical kiosk will remain disabled indefinitely. Ads will not run until an authorized operator manually clicks <strong>Resume Ads</strong>.
              </p>
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', marginTop: 4 }}>
                <input
                  type="checkbox"
                  checked={confirmPermanent}
                  onChange={(e) => setConfirmPermanent(e.target.checked)}
                  style={{ width: 16, height: 16, accentColor: '#EF4444' }}
                />
                <span style={{ fontSize: '0.75rem', fontWeight: 600, color: '#FFFFFF' }}>
                  I confirm permanent advertisement silencing for this kiosk.
                </span>
              </label>
            </div>
          )}

          {/* Operator Reason (Mandatory) */}
          <div>
            <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 700, color: '#CBD5E1', marginBottom: '0.35rem' }}>
              Mandatory Operator Reason *
            </label>
            <textarea
              rows={3}
              placeholder="e.g. Store request for quiet hours / Client conference / Maintenance"
              value={reason}
              onChange={(e) => setReason(e.target.value.slice(0, 500))}
              required
              style={{
                width: '100%',
                padding: '0.625rem 0.75rem',
                borderRadius: '8px',
                background: '#070E1E',
                border: '1px solid #334155',
                color: '#FFFFFF',
                fontSize: '0.8125rem',
                outline: 'none',
                resize: 'none'
              }}
            />
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.6875rem', color: '#64748B', marginTop: 3 }}>
              <span>Recorded in immutable ActivityLog & AuditLog</span>
              <span>{reason.length}/500</span>
            </div>
          </div>

          {/* Actions */}
          <div style={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: '0.75rem',
            paddingTop: '0.75rem',
            borderTop: '1px solid #1E293B'
          }}>
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
              style={{
                padding: '0.55rem 1rem',
                borderRadius: '8px',
                border: '1px solid #334155',
                background: 'transparent',
                color: '#94A3B8',
                fontWeight: 600,
                fontSize: '0.8125rem',
                cursor: 'pointer'
              }}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              style={{
                padding: '0.55rem 1.25rem',
                borderRadius: '8px',
                border: 'none',
                background: mode === 'PERMANENT' ? '#EF4444' : '#F59E0B',
                color: '#000000',
                fontWeight: 800,
                fontSize: '0.8125rem',
                cursor: isSubmitting ? 'not-allowed' : 'pointer',
                opacity: isSubmitting ? 0.7 : 1,
                display: 'flex',
                alignItems: 'center',
                gap: '6px'
              }}
            >
              {isSubmitting ? 'Updating...' : (mode === 'PERMANENT' ? 'Silence Permanently' : 'Silence Ads')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
