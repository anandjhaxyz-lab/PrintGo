/**
 * Dynamic Print Pricing Breakdown Calculator
 * Mirrors backend/src/services/pricing.service.js so customer pre-checkout estimates
 * stay aligned with authoritative server pricing, fees, minimum order, and GST rules.
 */

export const DEFAULT_PRICING_PROFILE = {
  profileId: 'DEFAULT_INTERNAL',
  name: 'Standard Kiosk Pricing',
  bwSingleRate: 2.0,
  bwDuplexRate: 3.0,
  colorSingleRate: 10.0,
  colorDuplexRate: 18.0,
  a4Multiplier: 1.0,
  a3Multiplier: 2.0,
  legalMultiplier: 1.2,
  glossySurcharge: 0.0,
  minOrderAmount: 1.0,
  convenienceFee: 0.0,
  gstEnabled: false,
  gstRatePercent: 18.0,
  isTaxInclusive: true,
};

/**
 * Parses and validates custom page range expressions (e.g. "1-3, 5").
 */
export const parseCustomPageRange = (rangeStr, totalPages = 1) => {
  const maxPages = Math.max(1, parseInt(totalPages, 10) || 1);
  if (!rangeStr || !rangeStr.trim()) {
    return { pages: [], count: 0, isValid: true, error: null };
  }
  if (!/^[0-9,\-\s]+$/.test(rangeStr)) {
    return { pages: [], count: 0, isValid: false, error: 'Only numbers, commas (,) and dashes (-) allowed' };
  }

  const selectedPages = new Set();
  const parts = rangeStr.split(',');
  let outOfBounds = false;

  for (const rawPart of parts) {
    const part = rawPart.trim();
    if (!part) continue;
    if (part.includes('-')) {
      const sides = part.split('-');
      if (sides.length !== 2) {
        return { pages: [], count: 0, isValid: false, error: 'Invalid range format (e.g. 1-3)' };
      }
      const start = parseInt(sides[0].trim(), 10);
      const end = parseInt(sides[1].trim(), 10);
      if (Number.isNaN(start) || Number.isNaN(end) || start <= 0 || end < start) {
        return { pages: [], count: 0, isValid: false, error: 'Invalid range: start must be <= end' };
      }
      if (start > maxPages) outOfBounds = true;
      const clampedEnd = Math.min(end, maxPages);
      for (let p = Math.max(1, start); p <= clampedEnd; p++) {
        selectedPages.add(p);
      }
      if (end > maxPages) outOfBounds = true;
    } else {
      const num = parseInt(part, 10);
      if (Number.isNaN(num) || num <= 0) {
        return { pages: [], count: 0, isValid: false, error: 'Page numbers must be positive' };
      }
      if (num > maxPages) {
        outOfBounds = true;
      } else {
        selectedPages.add(num);
      }
    }
  }

  const sortedPages = Array.from(selectedPages).sort((a, b) => a - b);
  let errorMsg = null;
  if (outOfBounds && sortedPages.length === 0) {
    errorMsg = `Document only has ${maxPages} ${maxPages === 1 ? 'page' : 'pages'}`;
  } else if (outOfBounds) {
    errorMsg = `Document only has ${maxPages} pages (pages > ${maxPages} ignored)`;
  }

  return {
    pages: sortedPages,
    count: sortedPages.length,
    isValid: sortedPages.length > 0 && !errorMsg,
    error: errorMsg,
  };
};

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * Calculates itemized print pricing from active backend PrintPricingProfile.
 */
export const calculatePrintBreakdown = (settings = {}, rawTotalPages = 1, rawProfile = null) => {
  const profile = { ...DEFAULT_PRICING_PROFILE, ...(rawProfile || {}) };
  const totalPages = Math.max(1, parseInt(rawTotalPages, 10) || 1);
  const copies = Math.max(1, Math.min(100, parseInt(settings.copies, 10) || 1));
  const isColor = settings.color === 'color';
  const isDuplex = settings.duplex === 'double';
  const paperSize = (settings.paperSize || 'A4').toUpperCase();
  const paperType = (settings.paperType || 'plain').toLowerCase();

  let pagesToPrint = totalPages;
  if (settings.pageRangeType === 'custom' && settings.customRange && settings.customRange.trim()) {
    const parsed = parseCustomPageRange(settings.customRange, totalPages);
    pagesToPrint = parsed.count > 0 ? parsed.count : totalPages;
  }

  const sheetsCount = isDuplex
    ? Math.ceil(pagesToPrint / 2) * copies
    : pagesToPrint * copies;

  let unitRate = 0;
  let rateLabel = '';
  if (isColor) {
    unitRate = Number(isDuplex ? profile.colorDuplexRate : profile.colorSingleRate);
    rateLabel = isDuplex ? `Colour Duplex (₹${unitRate}/sheet)` : `Colour Single (₹${unitRate}/side)`;
  } else {
    unitRate = Number(isDuplex ? profile.bwDuplexRate : profile.bwSingleRate);
    rateLabel = isDuplex ? `B&W Duplex (₹${unitRate}/sheet)` : `B&W Single (₹${unitRate}/side)`;
  }

  let sizeMultiplier = Number(profile.a4Multiplier ?? 1.0);
  if (paperSize === 'A3') sizeMultiplier = Number(profile.a3Multiplier ?? 2.0);
  else if (paperSize === 'LEGAL') sizeMultiplier = Number(profile.legalMultiplier ?? 1.2);

  const typeSurchargePerSide = paperType === 'glossy' ? Number(profile.glossySurcharge || 0) : 0;

  let rawBasePrintCharge = 0;
  if (isDuplex) {
    rawBasePrintCharge =
      Math.ceil(pagesToPrint / 2) * copies * unitRate * sizeMultiplier +
      pagesToPrint * copies * typeSurchargePerSide;
  } else {
    rawBasePrintCharge =
      pagesToPrint * copies * (unitRate + typeSurchargePerSide) * sizeMultiplier;
  }

  const convenienceFee = Number(profile.convenienceFee || 0);
  const rawCombined = rawBasePrintCharge + convenienceFee;
  const minOrderAmount = Number(profile.minOrderAmount ?? 1.0);
  const grossAmount = Math.max(minOrderAmount, rawCombined);
  const minOrderAdjustment = grossAmount > rawCombined ? round2(grossAmount - rawCombined) : 0;

  let taxableAmount = grossAmount;
  let cgstAmount = 0;
  let sgstAmount = 0;
  let totalTax = 0;
  let finalCost = grossAmount;

  const gstEnabled = Boolean(profile.gstEnabled);
  const gstRatePercent = Number(profile.gstRatePercent || 0);
  const isTaxInclusive = profile.isTaxInclusive !== undefined ? Boolean(profile.isTaxInclusive) : true;

  if (gstEnabled && gstRatePercent > 0) {
    if (isTaxInclusive) {
      taxableAmount = grossAmount / (1 + gstRatePercent / 100);
      totalTax = grossAmount - taxableAmount;
    } else {
      taxableAmount = grossAmount;
      totalTax = taxableAmount * (gstRatePercent / 100);
      finalCost = taxableAmount + totalTax;
    }
    cgstAmount = round2(totalTax / 2);
    sgstAmount = round2(totalTax / 2);
  }

  const totalAmount = Math.max(1, Math.round(finalCost));

  return {
    totalPages,
    pagesToPrint,
    copies,
    sheetsCount,
    unitRate,
    rateLabel,
    basePrintCharge: round2(rawBasePrintCharge),
    convenienceFee: round2(convenienceFee),
    minOrderAmount: round2(minOrderAmount),
    minOrderAdjustment,
    subtotal: round2(taxableAmount),
    taxableAmount: round2(taxableAmount),
    gstEnabled,
    gstRatePercent,
    isTaxInclusive,
    cgstAmount,
    sgstAmount,
    totalTax: round2(totalTax),
    totalAmount,
  };
};
