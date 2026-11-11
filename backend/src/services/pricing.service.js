/**
 * Dynamic Pricing & Tax Service
 * 
 * Server-side authoritative price calculation engine.
 * Supports:
 *   - Dynamic database pricing profiles with machine/shop overrides
 *   - B&W single-sided, B&W duplex
 *   - Colour single-sided, Colour duplex
 *   - Paper sizes (A4, A3, Legal) & paper types (plain, glossy)
 *   - Configurable GST calculation (Inclusive / Exclusive) with CGST/SGST/IGST breakdown
 *   - Convenience fees & minimum order amount
 *   - Immutable pricing snapshot generation for every job
 */

const prisma = require('../utils/prisma');
const logger = require('../utils/logger');
const AppError = require('../utils/AppError');

// Fallback rates if no database profile exists yet
const DEFAULT_RATES = {
  bwSingleRate: 2.0,       // ₹2.00 per side
  bwDuplexRate: 3.0,       // ₹3.00 per sheet (2 sides)
  colorSingleRate: 10.0,   // ₹10.00 per side
  colorDuplexRate: 18.0,   // ₹18.00 per sheet (2 sides)
  a4Multiplier: 1.0,
  a3Multiplier: 2.0,
  legalMultiplier: 1.2,
  glossySurcharge: 0.0,
  minOrderAmount: 1.0,
  convenienceFee: 0.0,
  gstEnabled: false,
  gstRatePercent: 18.0,
  isTaxInclusive: true
};

/**
 * Parse a custom page range string (e.g. "1-3, 5, 8-10") into a page count.
 * Validates strictly against totalPages. Throws AppError(400) if out of bounds.
 */
const parseCustomPageRange = (rangeStr, totalPages) => {
  if (!rangeStr || !rangeStr.trim()) return totalPages;

  const selectedPages = new Set();
  for (const part of rangeStr.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    if (trimmed.includes('-')) {
      const [startStr, endStr] = trimmed.split('-');
      const start = parseInt(startStr.trim(), 10);
      const end = parseInt(endStr.trim(), 10);
      if (isNaN(start) || isNaN(end) || start < 1 || start > end) {
        throw new AppError(`Invalid page range: ${trimmed}`, 400);
      }
      if (start > totalPages || end > totalPages) {
        throw new AppError(`Page range ${trimmed} exceeds document total of ${totalPages} page(s)`, 400);
      }
      for (let p = start; p <= end; p++) {
        selectedPages.add(p);
      }
    } else {
      const num = parseInt(trimmed, 10);
      if (isNaN(num) || num < 1) {
        throw new AppError(`Invalid page number: ${trimmed}`, 400);
      }
      if (num > totalPages) {
        throw new AppError(`Page ${num} exceeds document total of ${totalPages} page(s)`, 400);
      }
      selectedPages.add(num);
    }
  }

  if (selectedPages.size === 0) {
    throw new AppError('No valid pages selected', 400);
  }

  return selectedPages.size;
};

/**
 * Fetches the active pricing profile for a machine or fallback to default.
 */
const getPricingProfile = async (machineId = null) => {
  try {
    if (machineId) {
      const machineProfile = await prisma.printPricingProfile.findFirst({
        where: { machineId, isActive: true }
      });
      if (machineProfile) return machineProfile;
    }

    const defaultProfile = await prisma.printPricingProfile.findFirst({
      where: { isDefault: true, isActive: true }
    });
    if (defaultProfile) return defaultProfile;

    const anyProfile = await prisma.printPricingProfile.findFirst({
      where: { isActive: true },
      orderBy: { createdAt: 'desc' }
    });
    if (anyProfile) return anyProfile;
  } catch (err) {
    logger.warn('Could not query PrintPricingProfile from DB, using fallback defaults:', err.message);
  }

  return DEFAULT_RATES;
};

/**
 * Calculates authoritative price, tax breakdown, and immutable snapshot.
 * 
 * @param {Object} settings - { color, duplex, copies, pageRangeType, customRange, paperSize, paperType }
 * @param {Object} document - { pages }
 * @param {string|null} machineId - Optional machine ID for dynamic rates
 * @returns {Promise<{ cost: number, pagesToPrint: number, sheetsCount: number, pricingSnapshot: Object, lineItems: Array }>}
 */
const calculatePrice = async (settings = {}, document = {}, machineId = null) => {
  const profile = await getPricingProfile(machineId);

  const totalPages = Math.max(1, parseInt(document.pages, 10) || 1);
  const copies = Math.max(1, Math.min(100, parseInt(settings.copies, 10) || 1));
  const isColor = settings.color === 'color';
  const isDuplex = settings.duplex === 'double';
  const paperSize = (settings.paperSize || 'A4').toUpperCase();
  const paperType = (settings.paperType || 'plain').toLowerCase();

  const pagesToPrint = settings.pageRangeType === 'custom'
    ? parseCustomPageRange(settings.customRange, totalPages)
    : totalPages;

  // 1. Calculate physical sheets count
  const sheetsCount = isDuplex
    ? Math.ceil(pagesToPrint / 2) * copies
    : pagesToPrint * copies;

  // 2. Determine base unit rate
  let unitRate = 0;
  let rateDescription = '';

  if (isColor) {
    if (isDuplex) {
      unitRate = profile.colorDuplexRate;
      rateDescription = `Colour Duplex (₹${unitRate}/sheet)`;
    } else {
      unitRate = profile.colorSingleRate;
      rateDescription = `Colour Single-Sided (₹${unitRate}/side)`;
    }
  } else {
    if (isDuplex) {
      unitRate = profile.bwDuplexRate;
      rateDescription = `B&W Duplex (₹${unitRate}/sheet)`;
    } else {
      unitRate = profile.bwSingleRate;
      rateDescription = `B&W Single-Sided (₹${unitRate}/side)`;
    }
  }

  // 3. Multipliers for Paper Size
  let sizeMultiplier = 1.0;
  if (paperSize === 'A3') sizeMultiplier = profile.a3Multiplier || 2.0;
  else if (paperSize === 'LEGAL') sizeMultiplier = profile.legalMultiplier || 1.2;

  // 4. Paper Type surcharge (e.g. glossy photo paper)
  const typeSurchargePerSide = paperType === 'glossy' ? (profile.glossySurcharge || 0) : 0;

  // 5. Compute base print charge
  let basePrintCharge = 0;
  if (isDuplex) {
    basePrintCharge = (Math.ceil(pagesToPrint / 2) * copies * unitRate * sizeMultiplier) +
                      (pagesToPrint * copies * typeSurchargePerSide);
  } else {
    basePrintCharge = (pagesToPrint * copies * (unitRate + typeSurchargePerSide) * sizeMultiplier);
  }

  // 6. Convenience fee
  const convenienceFee = Number(profile.convenienceFee || 0);

  // 7. Gross amount before rounding / minimum floor
  let grossAmount = basePrintCharge + convenienceFee;
  grossAmount = Math.max(profile.minOrderAmount || 1.0, grossAmount);

  // 8. Taxes & GST Breakdown
  let taxableAmount = grossAmount;
  let cgstAmount = 0;
  let sgstAmount = 0;
  let igstAmount = 0;
  let totalTax = 0;
  let finalCost = grossAmount;

  if (profile.gstEnabled && profile.gstRatePercent > 0) {
    const rate = profile.gstRatePercent;
    if (profile.isTaxInclusive) {
      // Inclusive GST: extract tax from gross amount
      taxableAmount = grossAmount / (1 + (rate / 100));
      totalTax = grossAmount - taxableAmount;
    } else {
      // Exclusive GST: add tax on top of gross amount
      taxableAmount = grossAmount;
      totalTax = taxableAmount * (rate / 100);
      finalCost = taxableAmount + totalTax;
    }

    // Default to Intra-State split (CGST 50%, SGST 50%)
    cgstAmount = Math.round((totalTax / 2) * 100) / 100;
    sgstAmount = Math.round((totalTax / 2) * 100) / 100;
  }

  // Final rounded rupee cost
  const roundedCost = Math.max(1, Math.round(finalCost));

  // 9. Structured Line Items for Billing & Receipt
  const lineItems = [
    {
      description: `Printing: ${pagesToPrint} pages x ${copies} copies (${rateDescription}) - Size: ${paperSize}`,
      pages: pagesToPrint,
      copies,
      paperSize,
      paperType,
      unitRate,
      amount: Math.round(basePrintCharge * 100) / 100
    }
  ];

  if (convenienceFee > 0) {
    lineItems.push({
      description: 'Platform Convenience Fee',
      amount: convenienceFee
    });
  }

  // 10. Immutable Snapshot to preserve with job
  const pricingSnapshot = {
    profileId: profile.id || 'DEFAULT_INTERNAL',
    profileName: profile.name || 'Standard Kiosk Pricing',
    ratesApplied: {
      unitRate,
      color: isColor ? 'color' : 'bw',
      duplex: isDuplex ? 'double' : 'single',
      paperSize,
      sizeMultiplier,
      paperType,
      typeSurchargePerSide,
      convenienceFee
    },
    calculation: {
      totalPages,
      pagesToPrint,
      copies,
      sheetsCount,
      basePrintCharge: Math.round(basePrintCharge * 100) / 100,
      subtotal: Math.round(taxableAmount * 100) / 100,
      taxableAmount: Math.round(taxableAmount * 100) / 100,
      gstEnabled: !!profile.gstEnabled,
      gstRatePercent: profile.gstRatePercent || 0,
      isTaxInclusive: !!profile.isTaxInclusive,
      cgstAmount,
      sgstAmount,
      igstAmount,
      totalTax: Math.round(totalTax * 100) / 100,
      finalCost: roundedCost
    },
    lineItems,
    calculatedAt: new Date().toISOString()
  };

  return {
    cost: roundedCost,
    pagesToPrint,
    sheetsCount,
    pricingSnapshot,
    lineItems,
    taxBreakdown: {
      subtotal: Math.round(taxableAmount * 100) / 100,
      taxableAmount: Math.round(taxableAmount * 100) / 100,
      cgstAmount,
      sgstAmount,
      igstAmount,
      totalTax: Math.round(totalTax * 100) / 100,
      totalAmount: roundedCost
    }
  };
};

/**
 * Returns only non-secret customer-facing pricing rate fields for frontend calculators.
 */
const serializePublicPricingProfile = (profile = {}) => ({
  profileId: profile.id || 'DEFAULT_INTERNAL',
  name: profile.name || 'Standard Kiosk Pricing',
  bwSingleRate: Number(profile.bwSingleRate ?? DEFAULT_RATES.bwSingleRate),
  bwDuplexRate: Number(profile.bwDuplexRate ?? DEFAULT_RATES.bwDuplexRate),
  colorSingleRate: Number(profile.colorSingleRate ?? DEFAULT_RATES.colorSingleRate),
  colorDuplexRate: Number(profile.colorDuplexRate ?? DEFAULT_RATES.colorDuplexRate),
  a4Multiplier: Number(profile.a4Multiplier ?? DEFAULT_RATES.a4Multiplier),
  a3Multiplier: Number(profile.a3Multiplier ?? DEFAULT_RATES.a3Multiplier),
  legalMultiplier: Number(profile.legalMultiplier ?? DEFAULT_RATES.legalMultiplier),
  glossySurcharge: Number(profile.glossySurcharge ?? DEFAULT_RATES.glossySurcharge),
  minOrderAmount: Number(profile.minOrderAmount ?? DEFAULT_RATES.minOrderAmount),
  convenienceFee: Number(profile.convenienceFee ?? DEFAULT_RATES.convenienceFee),
  gstEnabled: Boolean(profile.gstEnabled),
  gstRatePercent: Number(profile.gstRatePercent ?? DEFAULT_RATES.gstRatePercent),
  isTaxInclusive: profile.isTaxInclusive !== undefined ? Boolean(profile.isTaxInclusive) : DEFAULT_RATES.isTaxInclusive,
});

module.exports = {
  calculatePrice,
  parseCustomPageRange,
  getPricingProfile,
  serializePublicPricingProfile,
  DEFAULT_RATES
};
