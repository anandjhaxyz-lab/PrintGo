import React, { useState, useRef } from 'react';
import { QRCodeCanvas, QRCodeSVG } from 'qrcode.react';
import {
  QrCode,
  X,
  Download,
  Printer,
  Copy,
  Check,
  AlertTriangle,
  RotateCw,
  Ban,
  ShieldCheck,
  History,
  ExternalLink,
  Sparkles
} from 'lucide-react';

/**
 * Validates the backend-provided public QR target URL.
 * Fails closed if missing, malformed, non-HTTPS, or containing private IP/loopback.
 */
export const validateQrTargetUrl = (targetUrl) => {
  if (!targetUrl || typeof targetUrl !== 'string' || !targetUrl.trim()) {
    return {
      isValid: false,
      url: null,
      error: 'Configuration Error: Public QR destination URL is missing from backend response. QR actions are disabled.'
    };
  }

  const trimmed = targetUrl.trim();
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return {
      isValid: false,
      url: null,
      error: 'Configuration Error: Public QR destination URL is malformed. QR actions are disabled.'
    };
  }

  if (parsed.protocol !== 'https:') {
    return {
      isValid: false,
      url: null,
      error: 'Security Error: Insecure public URL rejected. Permanent QR codes must strictly use HTTPS.'
    };
  }

  const hostname = (parsed.hostname || '').toLowerCase();
  if (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname.endsWith('.local') ||
    /^127\./.test(hostname) ||
    /^10\./.test(hostname) ||
    /^192\.168\./.test(hostname) ||
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(hostname)
  ) {
    return {
      isValid: false,
      url: null,
      error: 'Security Error: Private LAN or loopback addresses are forbidden in permanent QR codes.'
    };
  }

  return {
    isValid: true,
    url: trimmed,
    error: null
  };
};

/**
 * High-Resolution QR Preview Modal with PNG/SVG downloads and Flyer Launch
 */
export const PrinterQrPreviewModal = ({
  qr,
  machine,
  onClose,
  onOpenPrintFlyer,
  onOpenRotate,
  onOpenRevoke,
  isAuthorized
}) => {
  const [copied, setCopied] = useState(false);
  const canvasRef = useRef(null);
  const svgRef = useRef(null);

  if (!qr) return null;

  const urlValidation = validateQrTargetUrl(qr.targetUrl);
  const targetUrl = urlValidation.url;
  const printerName = machine?.name || 'Main Shop Printer';
  const printerModel = machine?.printerModel || 'EPSON L6460 Series';
  const label = qr.label || 'Front Desk Counter';

  const handleCopyUrl = async () => {
    if (!urlValidation.isValid || !targetUrl) return;
    try {
      await navigator.clipboard.writeText(targetUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleDownloadPng = () => {
    if (!urlValidation.isValid) return;
    const canvas = document.getElementById('preview-qr-canvas-hi-res');
    if (canvas) {
      const pngUrl = canvas.toDataURL('image/png');
      const a = document.createElement('a');
      a.href = pngUrl;
      const safeName = printerName.replace(/[^a-zA-Z0-9_-]/g, '_');
      a.download = `PrintGo_QR_${safeName}_${qr.publicCode}.png`;
      a.click();
    }
  };

  const handleDownloadSvg = () => {
    if (!urlValidation.isValid) return;
    const svg = document.getElementById('preview-qr-svg-hi-res');
    if (svg) {
      const svgData = new XMLSerializer().serializeToString(svg);
      const blob = new Blob([svgData], { type: 'image/svg+xml;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const safeName = printerName.replace(/[^a-zA-Z0-9_-]/g, '_');
      a.download = `PrintGo_QR_${safeName}_${qr.publicCode}.svg`;
      a.click();
      URL.revokeObjectURL(url);
    }
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(15, 23, 42, 0.7)',
        backdropFilter: 'blur(4px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 9999,
        padding: '1rem'
      }}
    >
      <div
        className="admin-kpi-card"
        style={{
          width: '100%',
          maxWidth: '560px',
          maxHeight: '92vh',
          overflowY: 'auto',
          backgroundColor: '#ffffff',
          borderRadius: '16px',
          boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.25)',
          padding: '1.75rem',
          position: 'relative',
          border: '1px solid #e2e8f0'
        }}
      >
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.25rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <div style={{ background: '#ecfdf5', padding: '10px', borderRadius: '12px', border: '1px solid #a7f3d0' }}>
              <QrCode size={24} color="#059669" />
            </div>
            <div>
              <h3 style={{ margin: 0, fontSize: '1.125rem', fontWeight: 700, color: '#0f172a' }}>
                Dedicated Printer QR Code
              </h3>
              <span style={{ fontSize: '0.75rem', color: '#64748b' }}>
                Permanent Physical Counter Identity
              </span>
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              background: '#f1f5f9',
              border: 'none',
              borderRadius: '8px',
              padding: '6px',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              color: '#64748b'
            }}
          >
            <X size={18} />
          </button>
        </div>

        {/* Informational Banner: Permanent QR vs Temporary Customer Session */}
        <div
          style={{
            background: '#f0fdf4',
            border: '1px solid #bbf7d0',
            borderRadius: '10px',
            padding: '0.75rem 1rem',
            marginBottom: '1.25rem',
            fontSize: '0.75rem',
            color: '#166534',
            lineHeight: 1.5
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 600, marginBottom: '2px' }}>
            <ShieldCheck size={16} color="#16a34a" />
            <span>Permanent Physical Identifier</span>
          </div>
          This dedicated QR permanently identifies <strong>{printerName}</strong> ({label}). Scanning this code from any phone generates a fresh, isolated 60-minute customer session. The physical QR code never expires.
        </div>

        {/* Configuration Error Alert Banner (Fails Closed if URL Invalid or Missing) */}
        {!urlValidation.isValid && (
          <div
            style={{
              background: '#fef2f2',
              border: '1px solid #fecaca',
              borderRadius: '10px',
              padding: '0.75rem 1rem',
              marginBottom: '1.25rem',
              fontSize: '0.75rem',
              color: '#991b1b',
              lineHeight: 1.5,
              display: 'flex',
              alignItems: 'center',
              gap: '8px'
            }}
          >
            <AlertTriangle size={18} color="#dc2626" style={{ flexShrink: 0 }} />
            <span>{urlValidation.error}</span>
          </div>
        )}

        {/* QR Display Area */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            background: '#f8fafc',
            border: '1px solid #e2e8f0',
            borderRadius: '12px',
            padding: '1.5rem',
            marginBottom: '1.25rem'
          }}
        >
          {urlValidation.isValid ? (
            <div
              style={{
                background: '#ffffff',
                padding: '16px',
                borderRadius: '12px',
                boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.05), 0 2px 4px -2px rgba(0, 0, 0, 0.05)',
                display: 'inline-block'
              }}
            >
              {/* Visual Screen Canvas */}
              <QRCodeCanvas
                value={targetUrl}
                size={240}
                level="H"
                includeMargin={true}
              />
              {/* Hidden Hi-Res Canvas for 1024x1024 PNG download */}
              <div style={{ display: 'none' }}>
                <QRCodeCanvas
                  id="preview-qr-canvas-hi-res"
                  value={targetUrl}
                  size={1024}
                  level="H"
                  includeMargin={true}
                />
                <QRCodeSVG
                  id="preview-qr-svg-hi-res"
                  value={targetUrl}
                  size={1024}
                  level="H"
                  includeMargin={true}
                />
              </div>
            </div>
          ) : (
            <div
              style={{
                width: 240,
                height: 240,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                background: '#fef2f2',
                border: '2px dashed #fca5a5',
                borderRadius: '12px',
                padding: '1.5rem',
                textAlign: 'center',
                color: '#991b1b'
              }}
            >
              <AlertTriangle size={36} color="#dc2626" style={{ marginBottom: '8px' }} />
              <span style={{ fontSize: '0.8125rem', fontWeight: 700 }}>QR Generation Blocked</span>
              <span style={{ fontSize: '0.6875rem', color: '#b91c1c', marginTop: '4px' }}>
                {urlValidation.error}
              </span>
            </div>
          )}

          {/* Printer Details */}
          <div style={{ textAlign: 'center', marginTop: '1rem' }}>
            <div style={{ fontWeight: 700, fontSize: '1rem', color: '#0f172a' }}>{label}</div>
            <div style={{ fontSize: '0.8125rem', color: '#475569', marginTop: '2px' }}>
              {printerName} • <span style={{ color: '#059669', fontWeight: 600 }}>{printerModel}</span>
            </div>
            <div style={{ fontSize: '0.6875rem', color: '#94a3b8', marginTop: '4px', fontFamily: 'monospace' }}>
              Token: {qr.publicCode}
            </div>
          </div>
        </div>

        {/* Public URL Box with Copy Button */}
        <div style={{ marginBottom: '1.25rem' }}>
          <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 600, color: '#475569', marginBottom: '4px' }}>
            Permanent Public Scan Destination
          </label>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              background: '#f1f5f9',
              border: '1px solid #cbd5e1',
              borderRadius: '8px',
              padding: '0.5rem 0.75rem'
            }}
          >
            <input
              type="text"
              readOnly
              value={urlValidation.isValid ? targetUrl : 'URL Unavailable (Configuration Error)'}
              style={{
                flex: 1,
                background: 'transparent',
                border: 'none',
                outline: 'none',
                fontFamily: 'monospace',
                fontSize: '0.75rem',
                color: urlValidation.isValid ? '#1e293b' : '#dc2626'
              }}
            />
            <button
              onClick={urlValidation.isValid ? handleCopyUrl : undefined}
              disabled={!urlValidation.isValid}
              style={{
                background: !urlValidation.isValid ? '#94a3b8' : copied ? '#059669' : '#0284c7',
                color: '#ffffff',
                border: 'none',
                borderRadius: '6px',
                padding: '4px 10px',
                fontSize: '0.6875rem',
                fontWeight: 600,
                cursor: urlValidation.isValid ? 'pointer' : 'not-allowed',
                display: 'flex',
                alignItems: 'center',
                gap: '4px',
                transition: 'background 0.15s ease',
                opacity: urlValidation.isValid ? 1 : 0.6
              }}
            >
              {copied ? <Check size={12} /> : <Copy size={12} />}
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>

        {/* Download & Print Actions */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.5rem', marginBottom: '1.25rem' }}>
          <button
            onClick={urlValidation.isValid ? handleDownloadPng : undefined}
            disabled={!urlValidation.isValid}
            className="btn"
            style={{
              padding: '0.625rem 0.5rem',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '6px',
              fontSize: '0.75rem',
              fontWeight: 600,
              backgroundColor: '#f8fafc',
              border: '1px solid #cbd5e1',
              borderRadius: '8px',
              cursor: urlValidation.isValid ? 'pointer' : 'not-allowed',
              opacity: urlValidation.isValid ? 1 : 0.5
            }}
          >
            <Download size={14} color="#0284c7" />
            Download PNG
          </button>

          <button
            onClick={urlValidation.isValid ? handleDownloadSvg : undefined}
            disabled={!urlValidation.isValid}
            className="btn"
            style={{
              padding: '0.625rem 0.5rem',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '6px',
              fontSize: '0.75rem',
              fontWeight: 600,
              backgroundColor: '#f8fafc',
              border: '1px solid #cbd5e1',
              borderRadius: '8px',
              cursor: urlValidation.isValid ? 'pointer' : 'not-allowed',
              opacity: urlValidation.isValid ? 1 : 0.5
            }}
          >
            <Download size={14} color="#059669" />
            Download SVG
          </button>

          <button
            onClick={urlValidation.isValid ? () => onOpenPrintFlyer(qr, machine) : undefined}
            disabled={!urlValidation.isValid}
            style={{
              padding: '0.625rem 0.5rem',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '6px',
              fontSize: '0.75rem',
              fontWeight: 600,
              backgroundColor: urlValidation.isValid ? '#0f172a' : '#94a3b8',
              color: '#ffffff',
              border: 'none',
              borderRadius: '8px',
              cursor: urlValidation.isValid ? 'pointer' : 'not-allowed',
              opacity: urlValidation.isValid ? 1 : 0.5
            }}
          >
            <Printer size={14} color="#ffffff" />
            Print Counter Flyer
          </button>
        </div>

        {/* Rotation & Revocation Controls */}
        {isAuthorized && (
          <div
            style={{
              borderTop: '1px solid #f1f5f9',
              paddingTop: '1rem',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '0.5rem'
            }}
          >
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button
                onClick={() => onOpenRotate(qr, machine)}
                style={{
                  padding: '6px 12px',
                  background: '#fef3c7',
                  color: '#92400e',
                  border: '1px solid #fde68a',
                  borderRadius: '6px',
                  fontSize: '0.6875rem',
                  fontWeight: 600,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '4px'
                }}
              >
                <RotateCw size={12} /> Rotate QR
              </button>

              <button
                onClick={() => onOpenRevoke(qr, machine)}
                style={{
                  padding: '6px 12px',
                  background: '#fee2e2',
                  color: '#991b1b',
                  border: '1px solid #fecaca',
                  borderRadius: '6px',
                  fontSize: '0.6875rem',
                  fontWeight: 600,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '4px'
                }}
              >
                <Ban size={12} /> Revoke QR
              </button>
            </div>

            <button
              onClick={onClose}
              style={{
                padding: '6px 14px',
                background: '#f1f5f9',
                border: 'none',
                borderRadius: '6px',
                fontSize: '0.75rem',
                color: '#475569',
                fontWeight: 600,
                cursor: 'pointer'
              }}
            >
              Close
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

/**
 * Printable Counter Display Flyer Component
 * Neutral QR-only layout preserving branding protection rules.
 * Fails closed if backend targetUrl is missing or invalid.
 */
export const PrintableCounterFlyer = ({ qr, machine, onClose }) => {
  if (!qr) return null;

  const urlValidation = validateQrTargetUrl(qr.targetUrl);
  const targetUrl = urlValidation.url;
  const printerName = machine?.name || 'Main Shop Printer';
  const printerModel = machine?.printerModel || 'EPSON L6460 Series';
  const label = qr.label || 'Front Desk Counter';

  const handlePrint = () => {
    if (!urlValidation.isValid) return;
    window.print();
  };

  return (
    <div
      className="printable-flyer-modal-backdrop"
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(15, 23, 42, 0.85)',
        backdropFilter: 'blur(6px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 10000,
        padding: '1rem'
      }}
    >
      <div
        className="printable-flyer-dialog-card admin-kpi-card"
        style={{
          width: '100%',
          maxWidth: '520px',
          maxHeight: '94vh',
          overflowY: 'auto',
          backgroundColor: '#ffffff',
          borderRadius: '16px',
          padding: '2rem',
          position: 'relative'
        }}
      >
        {/* Screen Controls Header (hidden in print) */}
        <div
          className="no-print"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: '1.5rem',
            borderBottom: '1px solid #e2e8f0',
            paddingBottom: '0.75rem'
          }}
        >
          <div>
            <h4 style={{ margin: 0, fontSize: '0.9375rem', fontWeight: 700, color: '#0f172a' }}>
              Counter Display Flyer Preview
            </h4>
            <span style={{ fontSize: '0.6875rem', color: '#64748b' }}>
              Standard neutral layout suitable for A4 / A5 acrylic table tents or wall placards
            </span>
          </div>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button
              onClick={handlePrint}
              disabled={!urlValidation.isValid}
              style={{
                padding: '6px 14px',
                background: urlValidation.isValid ? '#059669' : '#94a3b8',
                color: '#ffffff',
                border: 'none',
                borderRadius: '6px',
                fontSize: '0.75rem',
                fontWeight: 600,
                cursor: urlValidation.isValid ? 'pointer' : 'not-allowed',
                display: 'flex',
                alignItems: 'center',
                gap: '6px'
              }}
            >
              <Printer size={14} /> Print Now
            </button>
            <button
              onClick={onClose}
              style={{
                padding: '6px 12px',
                background: '#f1f5f9',
                color: '#475569',
                border: 'none',
                borderRadius: '6px',
                fontSize: '0.75rem',
                fontWeight: 600,
                cursor: 'pointer'
              }}
            >
              Close
            </button>
          </div>
        </div>

        {/* Configuration Error Alert if URL invalid */}
        {!urlValidation.isValid && (
          <div
            className="no-print"
            style={{
              background: '#fef2f2',
              border: '1px solid #fecaca',
              color: '#991b1b',
              padding: '0.75rem 1rem',
              borderRadius: '8px',
              fontSize: '0.75rem',
              marginBottom: '1rem',
              display: 'flex',
              alignItems: 'center',
              gap: '8px'
            }}
          >
            <AlertTriangle size={16} color="#dc2626" style={{ flexShrink: 0 }} />
            <span>{urlValidation.error}</span>
          </div>
        )}

        {/* Printable Physical Card Container */}
        <div
          id="printable-counter-card"
          className="printable-counter-card"
          style={{
            border: '2px solid #0f172a',
            borderRadius: '16px',
            padding: '2rem 1.5rem',
            textAlign: 'center',
            backgroundColor: '#ffffff'
          }}
        >
          {/* Header Title */}
          <div className="flyer-title" style={{ textTransform: 'uppercase', letterSpacing: '0.08em', fontSize: '1.25rem', fontWeight: 900, color: '#0f172a' }}>
            Self-Service Mobile Printing
          </div>

          <div className="flyer-subtitle" style={{ fontSize: '0.8125rem', color: '#475569', marginTop: '4px', fontWeight: 600 }}>
            {label} • {printerName}
          </div>

          {/* QR Code with quiet-zone padding */}
          <div style={{ margin: '1.5rem 0', display: 'flex', justifyContent: 'center' }}>
            {urlValidation.isValid ? (
              <div
                className="qr-code-quiet-zone"
                style={{
                  padding: '16px',
                  border: '1px solid #cbd5e1',
                  borderRadius: '12px',
                  display: 'inline-block',
                  background: '#ffffff'
                }}
              >
                <QRCodeCanvas
                  value={targetUrl}
                  size={220}
                  level="H"
                  includeMargin={true}
                />
              </div>
            ) : (
              <div
                style={{
                  padding: '1.5rem',
                  border: '2px dashed #fca5a5',
                  borderRadius: '12px',
                  background: '#fef2f2',
                  color: '#991b1b',
                  fontSize: '0.8125rem',
                  maxWidth: '280px'
                }}
              >
                <AlertTriangle size={28} color="#dc2626" style={{ margin: '0 auto 8px auto' }} />
                <div style={{ fontWeight: 700 }}>QR Generation Blocked</div>
                <div style={{ fontSize: '0.6875rem', marginTop: '4px' }}>{urlValidation.error}</div>
              </div>
            )}
          </div>

          {/* Customer Instruction Steps */}
          <div
            className="instruction-box"
            style={{
              background: '#f8fafc',
              border: '1px solid #e2e8f0',
              borderRadius: '10px',
              padding: '1rem',
              textAlign: 'left',
              fontSize: '0.8125rem',
              color: '#1e293b',
              marginBottom: '1.25rem',
              lineHeight: 1.6
            }}
          >
            <div style={{ fontWeight: 700, marginBottom: '4px', color: '#0f172a' }}>
              How to Print:
            </div>
            <div style={{ display: 'flex', gap: '8px', marginBottom: '4px' }}>
              <strong>1.</strong>
              <span><strong>Scan QR</strong> with your phone's camera (No app required).</span>
            </div>
            <div style={{ display: 'flex', gap: '8px', marginBottom: '4px' }}>
              <strong>2.</strong>
              <span><strong>Upload</strong> your PDF, DOCX, or image document.</span>
            </div>
            <div style={{ display: 'flex', gap: '8px' }}>
              <strong>3.</strong>
              <span><strong>Choose options</strong> (B&W / Color, copies) and collect your printout.</span>
            </div>
          </div>

          {/* Readable HTTPS URL */}
          <div className="fallback-url" style={{ fontSize: '0.6875rem', color: '#64748b' }}>
            Direct Link:{' '}
            <span
              style={{
                fontFamily: 'monospace',
                fontWeight: 600,
                color: urlValidation.isValid ? '#0f172a' : '#dc2626'
              }}
            >
              {urlValidation.isValid ? targetUrl : 'Configuration Error (Scan URL Unavailable)'}
            </span>
          </div>

          {/* Neutral Footer */}
          <div className="flyer-footer" style={{ marginTop: '1rem', borderTop: '1px solid #e2e8f0', paddingTop: '0.75rem', fontSize: '0.6875rem', color: '#94a3b8' }}>
            Self-Service Printing Kiosk • Printer Model: {printerModel}
          </div>
        </div>
      </div>
    </div>
  );
};

/**
 * QR Generation Confirmation Modal
 */
export const PrinterQrGenerateModal = ({
  machine,
  onConfirm,
  onClose,
  isSubmitting,
  errorMsg
}) => {
  const [label, setLabel] = useState('Front Desk Counter');

  if (!machine) return null;

  const handleSubmit = (e) => {
    e.preventDefault();
    onConfirm(machine.id, label);
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(15, 23, 42, 0.7)',
        backdropFilter: 'blur(4px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 9999,
        padding: '1rem'
      }}
    >
      <div
        className="admin-kpi-card"
        style={{
          width: '100%',
          maxWidth: '460px',
          backgroundColor: '#ffffff',
          borderRadius: '16px',
          padding: '1.75rem',
          border: '1px solid #e2e8f0'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1rem' }}>
          <div style={{ background: '#ecfdf5', padding: '10px', borderRadius: '12px' }}>
            <Sparkles size={22} color="#059669" />
          </div>
          <div>
            <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: 700, color: '#0f172a' }}>
              Generate Permanent Dedicated QR
            </h3>
            <span style={{ fontSize: '0.75rem', color: '#64748b' }}>
              {machine.name} ({machine.printerModel || 'EPSON L6460 Series'})
            </span>
          </div>
        </div>

        {errorMsg && (
          <div
            style={{
              background: '#fef2f2',
              border: '1px solid #fecaca',
              color: '#991b1b',
              padding: '0.75rem',
              borderRadius: '8px',
              fontSize: '0.75rem',
              marginBottom: '1rem'
            }}
          >
            {errorMsg}
          </div>
        )}

        <p style={{ fontSize: '0.8125rem', color: '#475569', lineHeight: 1.5, marginBottom: '1rem' }}>
          This will generate a permanent physical QR code bound to this printer. Customers scanning this QR from their smartphones will be seamlessly connected to a fresh upload session.
        </p>

        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: '1.25rem' }}>
            <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 600, color: '#334155', marginBottom: '4px' }}>
              Placement Label *
            </label>
            <input
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              className="admin-input"
              style={{ width: '100%' }}
              placeholder="e.g. Front Desk Counter, Entrance Kiosk"
              required
            />
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem' }}>
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
              className="btn"
              style={{ fontSize: '0.8125rem' }}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              style={{
                padding: '0.5rem 1.25rem',
                background: '#059669',
                color: '#ffffff',
                border: 'none',
                borderRadius: '6px',
                fontWeight: 600,
                fontSize: '0.8125rem',
                cursor: isSubmitting ? 'not-allowed' : 'pointer'
              }}
            >
              {isSubmitting ? 'Generating...' : 'Confirm & Generate'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

/**
 * QR Rotate / Replacement Confirmation Modal
 */
export const PrinterQrRotateModal = ({
  qr,
  machine,
  onConfirm,
  onClose,
  isSubmitting,
  errorMsg
}) => {
  const [reason, setReason] = useState('');
  const [newLabel, setNewLabel] = useState(qr?.label || 'Front Desk Counter');

  if (!qr) return null;

  const validReason = reason.trim().length >= 10;

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!validReason) return;
    onConfirm(qr.id, reason.trim(), newLabel.trim());
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(15, 23, 42, 0.7)',
        backdropFilter: 'blur(4px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 9999,
        padding: '1rem'
      }}
    >
      <div
        className="admin-kpi-card"
        style={{
          width: '100%',
          maxWidth: '480px',
          backgroundColor: '#ffffff',
          borderRadius: '16px',
          padding: '1.75rem',
          border: '1px solid #e2e8f0'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1rem' }}>
          <div style={{ background: '#fef3c7', padding: '10px', borderRadius: '12px' }}>
            <RotateCw size={22} color="#b45309" />
          </div>
          <div>
            <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: 700, color: '#0f172a' }}>
              Rotate Dedicated Printer QR
            </h3>
            <span style={{ fontSize: '0.75rem', color: '#64748b' }}>
              {machine?.name} ({qr.label})
            </span>
          </div>
        </div>

        {/* Warning Banner */}
        <div
          style={{
            background: '#fffbeb',
            border: '1px solid #fde68a',
            borderRadius: '10px',
            padding: '0.75rem',
            marginBottom: '1rem',
            fontSize: '0.75rem',
            color: '#92400e',
            lineHeight: 1.5
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 600, marginBottom: '2px' }}>
            <AlertTriangle size={14} color="#b45309" />
            <span>Important Operational Impact</span>
          </div>
          Rotating this QR code immediately archives the old code as <strong>REPLACED</strong>. Customers scanning the old physical code will be redirected to ask staff for the updated flyer. All prior session history and audit logs remain preserved.
        </div>

        {errorMsg && (
          <div
            style={{
              background: '#fef2f2',
              border: '1px solid #fecaca',
              color: '#991b1b',
              padding: '0.75rem',
              borderRadius: '8px',
              fontSize: '0.75rem',
              marginBottom: '1rem'
            }}
          >
            {errorMsg}
          </div>
        )}

        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: '1rem' }}>
            <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 600, color: '#334155', marginBottom: '4px' }}>
              Placement Label for New QR *
            </label>
            <input
              type="text"
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              className="admin-input"
              style={{ width: '100%' }}
              required
            />
          </div>

          <div style={{ marginBottom: '1.25rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
              <label style={{ fontSize: '0.75rem', fontWeight: 600, color: '#334155' }}>
                Operator Reason for Rotation *
              </label>
              <span
                style={{
                  fontSize: '0.6875rem',
                  color: validReason ? '#059669' : '#dc2626',
                  fontWeight: 600
                }}
              >
                {reason.trim().length} / 10 characters minimum
              </span>
            </div>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="admin-input"
              style={{ width: '100%', minHeight: '68px', resize: 'vertical' }}
              placeholder="e.g. Counter flyer damaged and reprinted with new placement..."
              required
            />
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem' }}>
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
              className="btn"
              style={{ fontSize: '0.8125rem' }}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting || !validReason}
              style={{
                padding: '0.5rem 1.25rem',
                background: validReason ? '#d97706' : '#94a3b8',
                color: '#ffffff',
                border: 'none',
                borderRadius: '6px',
                fontWeight: 600,
                fontSize: '0.8125rem',
                cursor: validReason && !isSubmitting ? 'pointer' : 'not-allowed'
              }}
            >
              {isSubmitting ? 'Rotating QR...' : 'Authorize Rotation'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

/**
 * QR Revocation Confirmation Modal
 */
export const PrinterQrRevokeModal = ({
  qr,
  machine,
  onConfirm,
  onClose,
  isSubmitting,
  errorMsg
}) => {
  const [reason, setReason] = useState('');

  if (!qr) return null;

  const validReason = reason.trim().length >= 10;

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!validReason) return;
    onConfirm(qr.id, reason.trim());
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(15, 23, 42, 0.7)',
        backdropFilter: 'blur(4px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 9999,
        padding: '1rem'
      }}
    >
      <div
        className="admin-kpi-card"
        style={{
          width: '100%',
          maxWidth: '480px',
          backgroundColor: '#ffffff',
          borderRadius: '16px',
          padding: '1.75rem',
          border: '1px solid #e2e8f0'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1rem' }}>
          <div style={{ background: '#fee2e2', padding: '10px', borderRadius: '12px' }}>
            <Ban size={22} color="#dc2626" />
          </div>
          <div>
            <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: 700, color: '#0f172a' }}>
              Revoke Dedicated Printer QR
            </h3>
            <span style={{ fontSize: '0.75rem', color: '#64748b' }}>
              {machine?.name} ({qr.label})
            </span>
          </div>
        </div>

        {/* Warning Banner */}
        <div
          style={{
            background: '#fef2f2',
            border: '1px solid #fecaca',
            borderRadius: '10px',
            padding: '0.75rem',
            marginBottom: '1rem',
            fontSize: '0.75rem',
            color: '#991b1b',
            lineHeight: 1.5
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 600, marginBottom: '2px' }}>
            <AlertTriangle size={14} color="#dc2626" />
            <span>Permanent Deactivation</span>
          </div>
          Revoking this QR permanently disables it. Scans will be rejected with HTTP 410 Gone. The printer will have no active QR until a new one is generated. Complete audit logs and prior jobs are preserved.
        </div>

        {errorMsg && (
          <div
            style={{
              background: '#fef2f2',
              border: '1px solid #fecaca',
              color: '#991b1b',
              padding: '0.75rem',
              borderRadius: '8px',
              fontSize: '0.75rem',
              marginBottom: '1rem'
            }}
          >
            {errorMsg}
          </div>
        )}

        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: '1.25rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
              <label style={{ fontSize: '0.75rem', fontWeight: 600, color: '#334155' }}>
                Operator Revocation Reason *
              </label>
              <span
                style={{
                  fontSize: '0.6875rem',
                  color: validReason ? '#059669' : '#dc2626',
                  fontWeight: 600
                }}
              >
                {reason.trim().length} / 10 characters minimum
              </span>
            </div>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="admin-input"
              style={{ width: '100%', minHeight: '68px', resize: 'vertical' }}
              placeholder="e.g. Printer taken offline for major maintenance, counter flyer decommissioned..."
              required
            />
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem' }}>
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
              className="btn"
              style={{ fontSize: '0.8125rem' }}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting || !validReason}
              style={{
                padding: '0.5rem 1.25rem',
                background: validReason ? '#dc2626' : '#94a3b8',
                color: '#ffffff',
                border: 'none',
                borderRadius: '6px',
                fontWeight: 600,
                fontSize: '0.8125rem',
                cursor: validReason && !isSubmitting ? 'pointer' : 'not-allowed'
              }}
            >
              {isSubmitting ? 'Revoking...' : 'Confirm Revocation'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

/**
 * QR History / Audit Ledger Modal
 */
export const PrinterQrLedgerModal = ({
  machine,
  ledger,
  onClose,
  onOpenPreview
}) => {
  if (!machine) return null;

  const history = ledger?.history || [];
  const activeQr = ledger?.activeQr;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(15, 23, 42, 0.7)',
        backdropFilter: 'blur(4px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 9999,
        padding: '1rem'
      }}
    >
      <div
        className="admin-kpi-card"
        style={{
          width: '100%',
          maxWidth: '640px',
          maxHeight: '90vh',
          overflowY: 'auto',
          backgroundColor: '#ffffff',
          borderRadius: '16px',
          padding: '1.75rem',
          border: '1px solid #e2e8f0'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.25rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <div style={{ background: '#f1f5f9', padding: '10px', borderRadius: '12px' }}>
              <History size={22} color="#475569" />
            </div>
            <div>
              <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: 700, color: '#0f172a' }}>
                Dedicated QR Audit Ledger
              </h3>
              <span style={{ fontSize: '0.75rem', color: '#64748b' }}>
                {machine.name} • {ledger?.total || (activeQr ? 1 : 0) + history.length} total records
              </span>
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              background: '#f1f5f9',
              border: 'none',
              borderRadius: '8px',
              padding: '6px',
              cursor: 'pointer',
              color: '#64748b'
            }}
          >
            <X size={18} />
          </button>
        </div>

        {/* Current Active QR (if exists) */}
        {activeQr && (
          <div
            style={{
              background: '#f0fdf4',
              border: '1px solid #bbf7d0',
              borderRadius: '10px',
              padding: '1rem',
              marginBottom: '1.25rem'
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '4px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <span
                  style={{
                    background: '#059669',
                    color: '#ffffff',
                    fontSize: '0.625rem',
                    fontWeight: 700,
                    padding: '2px 8px',
                    borderRadius: '9999px',
                    textTransform: 'uppercase'
                  }}
                >
                  Current Active
                </span>
                <span style={{ fontWeight: 600, fontSize: '0.875rem', color: '#0f172a' }}>
                  {activeQr.label}
                </span>
              </div>
              <button
                onClick={() => onOpenPreview(activeQr, machine)}
                style={{
                  background: '#ffffff',
                  border: '1px solid #86efac',
                  color: '#059669',
                  borderRadius: '6px',
                  padding: '4px 10px',
                  fontSize: '0.6875rem',
                  fontWeight: 600,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '4px'
                }}
              >
                <QrCode size={12} /> View Code
              </button>
            </div>
            <div style={{ fontSize: '0.6875rem', color: '#64748b', fontFamily: 'monospace' }}>
              Token: {activeQr.publicCode}
            </div>
            <div style={{ fontSize: '0.6875rem', color: '#475569', marginTop: '4px' }}>
              Created: {new Date(activeQr.createdAt).toLocaleString()} by {activeQr.generatedBy || 'SYSTEM'}
            </div>
          </div>
        )}

        {/* History Table */}
        <h5 style={{ margin: '0 0 0.5rem 0', fontSize: '0.8125rem', fontWeight: 600, color: '#334155' }}>
          Historical Records & Revocation Log
        </h5>

        {history.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '1.5rem', color: '#94a3b8', fontSize: '0.8125rem' }}>
            No prior replaced or revoked QR codes for this printer.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {history.map((record) => {
              const isReplaced = record.status === 'REPLACED';
              return (
                <div
                  key={record.id}
                  style={{
                    border: '1px solid #e2e8f0',
                    borderRadius: '8px',
                    padding: '0.75rem',
                    background: '#f8fafc',
                    fontSize: '0.75rem'
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '4px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <span
                        style={{
                          background: isReplaced ? '#fef3c7' : '#fee2e2',
                          color: isReplaced ? '#92400e' : '#991b1b',
                          fontSize: '0.625rem',
                          fontWeight: 700,
                          padding: '2px 6px',
                          borderRadius: '4px'
                        }}
                      >
                        {record.status}
                      </span>
                      <span style={{ fontWeight: 600, color: '#1e293b' }}>
                        {record.label || 'Front Desk Counter'}
                      </span>
                    </div>
                    <span style={{ fontFamily: 'monospace', color: '#94a3b8', fontSize: '0.6875rem' }}>
                      {record.publicCode.slice(0, 10)}...{record.publicCode.slice(-6)}
                    </span>
                  </div>

                  <div style={{ color: '#64748b', fontSize: '0.6875rem', marginBottom: '4px' }}>
                    Revoked/Replaced: {record.revokedAt ? new Date(record.revokedAt).toLocaleString() : 'N/A'} by {record.revokedBy || 'SYSTEM'}
                  </div>

                  {record.revokedReason && (
                    <div
                      style={{
                        background: '#ffffff',
                        border: '1px solid #e2e8f0',
                        borderRadius: '6px',
                        padding: '4px 8px',
                        color: '#334155',
                        fontSize: '0.6875rem',
                        fontStyle: 'italic'
                      }}
                    >
                      Reason: "{record.revokedReason}"
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '1.25rem' }}>
          <button
            onClick={onClose}
            style={{
              padding: '6px 14px',
              background: '#f1f5f9',
              border: 'none',
              borderRadius: '6px',
              fontSize: '0.75rem',
              color: '#475569',
              fontWeight: 600,
              cursor: 'pointer'
            }}
          >
            Close Ledger
          </button>
        </div>
      </div>
    </div>
  );
};
