import React, { useState, useEffect } from 'react';
import { DollarSign, Calculator, Check, AlertCircle, Save } from 'lucide-react';

export const PricingView = ({ pricingProfiles, onSaveProfile, isSuperadmin }) => {
  const current = pricingProfiles?.[0] || {};

  const [formData, setFormData] = useState({
    id: current.id || '',
    name: current.name || 'Standard Kiosk Pricing',
    bwSingleRate: current.bwSingleRate ?? 2.0,
    bwDuplexRate: current.bwDuplexRate ?? 3.0,
    colorSingleRate: current.colorSingleRate ?? 10.0,
    colorDuplexRate: current.colorDuplexRate ?? 18.0,
    a4Multiplier: current.a4Multiplier ?? 1.0,
    a3Multiplier: current.a3Multiplier ?? 2.0,
    legalMultiplier: current.legalMultiplier ?? 1.2,
    glossySurcharge: current.glossySurcharge ?? 5.0,
    minOrderAmount: current.minOrderAmount ?? 1.0,
    convenienceFee: current.convenienceFee ?? 0.0,
    gstEnabled: Boolean(current.gstEnabled),
    gstRatePercent: current.gstRatePercent ?? 18.0,
    isTaxInclusive: current.isTaxInclusive !== undefined ? Boolean(current.isTaxInclusive) : true
  });

  useEffect(() => {
    if (pricingProfiles?.[0]) {
      const p = pricingProfiles[0];
      setFormData({
        id: p.id || '',
        name: p.name || 'Standard Kiosk Pricing',
        bwSingleRate: p.bwSingleRate ?? 2.0,
        bwDuplexRate: p.bwDuplexRate ?? 3.0,
        colorSingleRate: p.colorSingleRate ?? 10.0,
        colorDuplexRate: p.colorDuplexRate ?? 18.0,
        a4Multiplier: p.a4Multiplier ?? 1.0,
        a3Multiplier: p.a3Multiplier ?? 2.0,
        legalMultiplier: p.legalMultiplier ?? 1.2,
        glossySurcharge: p.glossySurcharge ?? 5.0,
        minOrderAmount: p.minOrderAmount ?? 1.0,
        convenienceFee: p.convenienceFee ?? 0.0,
        gstEnabled: Boolean(p.gstEnabled),
        gstRatePercent: p.gstRatePercent ?? 18.0,
        isTaxInclusive: p.isTaxInclusive !== undefined ? Boolean(p.isTaxInclusive) : true
      });
    }
  }, [pricingProfiles]);

  // Live Calculator State
  const [calcPages, setCalcPages] = useState(10);
  const [calcCopies, setCalcCopies] = useState(1);
  const [calcColor, setCalcColor] = useState('bw');
  const [calcDuplex, setCalcDuplex] = useState('single');
  const [calcPaperSize, setCalcPaperSize] = useState('A4');
  const [calcPaperType, setCalcPaperType] = useState('plain');

  const [isSaving, setIsSaving] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');

  // Calculate live preview cost
  const calculatePreview = () => {
    const isColor = calcColor === 'color';
    const isDouble = calcDuplex === 'double';

    let rate = 0;
    let multiplier = 1.0;
    if (calcPaperSize === 'A3') multiplier = formData.a3Multiplier;
    else if (calcPaperSize === 'Legal') multiplier = formData.legalMultiplier;
    else multiplier = formData.a4Multiplier;

    if (!isColor && !isDouble) rate = formData.bwSingleRate;
    else if (!isColor && isDouble) rate = formData.bwDuplexRate;
    else if (isColor && !isDouble) rate = formData.colorSingleRate;
    else rate = formData.colorDuplexRate;

    let baseCost = 0;
    if (isDouble) {
      const sheets = Math.ceil(calcPages / 2);
      baseCost = sheets * rate * multiplier;
    } else {
      baseCost = calcPages * rate * multiplier;
    }

    if (calcPaperType === 'glossy') {
      baseCost += (calcPages * formData.glossySurcharge);
    }

    baseCost = baseCost * calcCopies;
    let finalCost = Math.max(formData.minOrderAmount, baseCost) + formData.convenienceFee;

    let taxable = finalCost;
    let tax = 0;
    if (formData.gstEnabled) {
      if (formData.isTaxInclusive) {
        taxable = finalCost / (1 + (formData.gstRatePercent / 100));
        tax = finalCost - taxable;
      } else {
        tax = (finalCost * formData.gstRatePercent) / 100;
        finalCost = finalCost + tax;
      }
    }

    return {
      finalCost: Math.round(finalCost * 100) / 100,
      taxable: Math.round(taxable * 100) / 100,
      tax: Math.round(tax * 100) / 100
    };
  };

  const preview = calculatePreview();

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!isSuperadmin) return;
    setIsSaving(true);
    setStatusMsg('');
    try {
      await onSaveProfile(formData);
      setStatusMsg('Pricing profile saved successfully!');
      setTimeout(() => setStatusMsg(''), 3000);
    } catch (err) {
      setStatusMsg('Error: ' + (err.response?.data?.error || err.message));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(350px, 1fr))', gap: '1.5rem' }}>
      {/* Settings Form */}
      <div style={{ background: '#ffffff', border: '1px solid #e2e8f0', borderRadius: '12px', padding: '1.5rem' }}>
        <h3 style={{ fontSize: '1rem', fontWeight: 700, color: '#0f172a', marginBottom: '0.25rem' }}>
          Dynamic Print Rates & Surcharges
        </h3>
        <p style={{ fontSize: '0.75rem', color: '#64748b', marginBottom: '1.25rem' }}>
          Configure base page rates, size multipliers, and GST tax rules.
        </p>

        {statusMsg && (
          <div style={{ padding: '0.75rem', borderRadius: '6px', fontSize: '0.8125rem', marginBottom: '1rem', background: statusMsg.startsWith('Error') ? '#fee2e2' : '#dcfce7', color: statusMsg.startsWith('Error') ? '#991b1b' : '#15803d' }}>
            {statusMsg}
          </div>
        )}

        <form onSubmit={handleSubmit}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '1rem' }}>
            <div>
              <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 600, color: '#475569', marginBottom: '4px' }}>
                B&W Single Rate (₹)
              </label>
              <input
                type="number"
                step="0.5"
                disabled={!isSuperadmin}
                className="admin-input"
                style={{ width: '100%' }}
                value={formData.bwSingleRate}
                onChange={(e) => setFormData({ ...formData, bwSingleRate: Number(e.target.value) })}
              />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 600, color: '#475569', marginBottom: '4px' }}>
                B&W Duplex Rate (₹)
              </label>
              <input
                type="number"
                step="0.5"
                disabled={!isSuperadmin}
                className="admin-input"
                style={{ width: '100%' }}
                value={formData.bwDuplexRate}
                onChange={(e) => setFormData({ ...formData, bwDuplexRate: Number(e.target.value) })}
              />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 600, color: '#475569', marginBottom: '4px' }}>
                Colour Single Rate (₹)
              </label>
              <input
                type="number"
                step="1"
                disabled={!isSuperadmin}
                className="admin-input"
                style={{ width: '100%' }}
                value={formData.colorSingleRate}
                onChange={(e) => setFormData({ ...formData, colorSingleRate: Number(e.target.value) })}
              />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 600, color: '#475569', marginBottom: '4px' }}>
                Colour Duplex Rate (₹)
              </label>
              <input
                type="number"
                step="1"
                disabled={!isSuperadmin}
                className="admin-input"
                style={{ width: '100%' }}
                value={formData.colorDuplexRate}
                onChange={(e) => setFormData({ ...formData, colorDuplexRate: Number(e.target.value) })}
              />
            </div>
          </div>

          <h4 style={{ fontSize: '0.8125rem', fontWeight: 600, color: '#0f172a', margin: '1rem 0 0.5rem' }}>
            Paper Size Multipliers & Surcharges
          </h4>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0.75rem', marginBottom: '1rem' }}>
            <div>
              <label style={{ display: 'block', fontSize: '0.6875rem', color: '#64748b' }}>A4 Multiplier</label>
              <input
                type="number"
                step="0.1"
                disabled={!isSuperadmin}
                className="admin-input"
                style={{ width: '100%' }}
                value={formData.a4Multiplier}
                onChange={(e) => setFormData({ ...formData, a4Multiplier: Number(e.target.value) })}
              />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: '0.6875rem', color: '#64748b' }}>A3 Multiplier</label>
              <input
                type="number"
                step="0.1"
                disabled={!isSuperadmin}
                className="admin-input"
                style={{ width: '100%' }}
                value={formData.a3Multiplier}
                onChange={(e) => setFormData({ ...formData, a3Multiplier: Number(e.target.value) })}
              />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: '0.6875rem', color: '#64748b' }}>Legal Multiplier</label>
              <input
                type="number"
                step="0.1"
                disabled={!isSuperadmin}
                className="admin-input"
                style={{ width: '100%' }}
                value={formData.legalMultiplier}
                onChange={(e) => setFormData({ ...formData, legalMultiplier: Number(e.target.value) })}
              />
            </div>
          </div>

          <h4 style={{ fontSize: '0.8125rem', fontWeight: 600, color: '#0f172a', margin: '1rem 0 0.5rem' }}>
            GST & Statutory Tax Settings
          </h4>
          <div style={{ background: '#f8fafc', padding: '0.75rem', borderRadius: '8px', marginBottom: '1rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
              <input
                type="checkbox"
                id="gstEnabled"
                disabled={!isSuperadmin}
                checked={formData.gstEnabled}
                onChange={(e) => setFormData({ ...formData, gstEnabled: e.target.checked })}
              />
              <label htmlFor="gstEnabled" style={{ fontSize: '0.8125rem', fontWeight: 600, color: '#334155' }}>
                Enable GST on Invoices
              </label>
            </div>
            {formData.gstEnabled && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem', marginTop: '0.5rem' }}>
                <div>
                  <label style={{ display: 'block', fontSize: '0.6875rem', color: '#64748b' }}>GST Rate (%)</label>
                  <input
                    type="number"
                    disabled={!isSuperadmin}
                    className="admin-input"
                    style={{ width: '100%' }}
                    value={formData.gstRatePercent}
                    onChange={(e) => setFormData({ ...formData, gstRatePercent: Number(e.target.value) })}
                  />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: '0.6875rem', color: '#64748b' }}>Pricing Model</label>
                  <select
                    disabled={!isSuperadmin}
                    className="admin-input"
                    style={{ width: '100%' }}
                    value={formData.isTaxInclusive ? 'inclusive' : 'exclusive'}
                    onChange={(e) => setFormData({ ...formData, isTaxInclusive: e.target.value === 'inclusive' })}
                  >
                    <option value="inclusive">Tax Inclusive</option>
                    <option value="exclusive">Tax Exclusive</option>
                  </select>
                </div>
              </div>
            )}
          </div>

          {isSuperadmin && (
            <button
              type="submit"
              disabled={isSaving}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem',
                padding: '0.625rem 1.25rem',
                background: '#4f46e5',
                color: '#ffffff',
                border: 'none',
                borderRadius: '8px',
                fontWeight: 600,
                fontSize: '0.875rem',
                cursor: 'pointer'
              }}
            >
              <Save size={16} /> {isSaving ? 'Saving...' : 'Save Profile Changes'}
            </button>
          )}
        </form>
      </div>

      {/* Interactive Price Preview Calculator */}
      <div style={{ background: '#ffffff', border: '1px solid #e2e8f0', borderRadius: '12px', padding: '1.5rem', height: 'fit-content' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem', borderBottom: '1px solid #f1f5f9', paddingBottom: '0.5rem' }}>
          <Calculator size={20} color="#4f46e5" />
          <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: 700, color: '#0f172a' }}>
            Live Pricing Simulator
          </h3>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem', marginBottom: '1rem' }}>
          <div>
            <label style={{ display: 'block', fontSize: '0.75rem', color: '#64748b' }}>Pages</label>
            <input
              type="number"
              min="1"
              className="admin-input"
              style={{ width: '100%' }}
              value={calcPages}
              onChange={(e) => setCalcPages(Math.max(1, Number(e.target.value)))}
            />
          </div>
          <div>
            <label style={{ display: 'block', fontSize: '0.75rem', color: '#64748b' }}>Copies</label>
            <input
              type="number"
              min="1"
              className="admin-input"
              style={{ width: '100%' }}
              value={calcCopies}
              onChange={(e) => setCalcCopies(Math.max(1, Number(e.target.value)))}
            />
          </div>
          <div>
            <label style={{ display: 'block', fontSize: '0.75rem', color: '#64748b' }}>Color</label>
            <select
              className="admin-input"
              style={{ width: '100%' }}
              value={calcColor}
              onChange={(e) => setCalcColor(e.target.value)}
            >
              <option value="bw">B&W</option>
              <option value="color">Color</option>
            </select>
          </div>
          <div>
            <label style={{ display: 'block', fontSize: '0.75rem', color: '#64748b' }}>Duplex</label>
            <select
              className="admin-input"
              style={{ width: '100%' }}
              value={calcDuplex}
              onChange={(e) => setCalcDuplex(e.target.value)}
            >
              <option value="single">Single-Sided</option>
              <option value="double">Duplex</option>
            </select>
          </div>
        </div>

        <div style={{ background: '#f8fafc', padding: '1rem', borderRadius: '10px', border: '1px solid #e2e8f0' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8125rem', color: '#64748b', marginBottom: '4px' }}>
            <span>Taxable Subtotal:</span>
            <span>₹{preview.taxable}</span>
          </div>
          {formData.gstEnabled && (
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8125rem', color: '#64748b', marginBottom: '4px' }}>
              <span>GST ({formData.gstRatePercent}%):</span>
              <span>₹{preview.tax}</span>
            </div>
          )}
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '1.125rem', fontWeight: 700, color: '#0f172a', borderTop: '1px solid #e2e8f0', paddingTop: '6px', marginTop: '6px' }}>
            <span>Final Customer Price:</span>
            <span style={{ color: '#059669' }}>₹{preview.finalCost}</span>
          </div>
        </div>
      </div>
    </div>
  );
};
