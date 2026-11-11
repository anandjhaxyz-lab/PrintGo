/**
 * Customer Invoice, Lifecycle & Credit Note Service
 * 
 * Generates verified billing records, tax invoices, cash receipts, and credit notes.
 * Adheres strictly to Indian GST requirements & PrintGo security invariants:
 *   - Verifies authoritative server-side payment success before issuing confirmed invoices
 *   - Classifies demo payments explicitly as SIMULATED receipts (no real money, no GST)
 *   - Enforces unique, race-condition-free invoice & credit note sequences
 *   - Issues "TAX INVOICE" if valid GSTIN is configured
 *   - Issues "BILL OF SUPPLY / CASH RECEIPT" if GSTIN is unconfigured
 *   - Issues Section 34 compliant "CREDIT NOTE" upon refund/cancellation
 */

const fs = require('fs');
const path = require('path');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const prisma = require('../utils/prisma');
const logger = require('../utils/logger');
const AppError = require('../utils/AppError');

const INVOICE_DIR = process.env.INVOICE_DIR || path.resolve(__dirname, '../../uploads/invoices');
if (!fs.existsSync(INVOICE_DIR)) {
  fs.mkdirSync(INVOICE_DIR, { recursive: true });
}

/**
 * Retrieves the business profile for billing or defaults.
 */
const getBusinessProfile = async (companyId = null) => {
  try {
    if (companyId) {
      const profile = await prisma.businessProfile.findUnique({ where: { companyId } });
      if (profile) return profile;
    }

    const defaultProfile = await prisma.businessProfile.findFirst({
      orderBy: { createdAt: 'desc' }
    });
    if (defaultProfile) return defaultProfile;
  } catch (err) {
    logger.warn('Could not query BusinessProfile from DB, using fallback defaults:', err.message);
  }

  return {
    legalName: 'PrintGo Self-Service Kiosks',
    tradeName: 'PrintGo',
    gstin: null, // Unconfigured by default — never invent GSTIN
    panNumber: null,
    sacCode: '9989',
    supportEmail: 'support@printgo.local',
    supportPhone: '+91 9999999999',
    addressLine1: 'Self-Service Print Kiosk',
    city: 'Hyderabad',
    state: 'Telangana',
    stateCode: '36',
    invoicePrefix: 'INV-PG-',
    nextInvoiceNumber: 1001
  };
};

/**
 * Generates a clean 1-page PDF receipt/invoice using pdf-lib.
 */
const generateInvoicePdf = async (invoiceData, filePath) => {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([595.28, 841.89]); // A4 portrait in points (72 DPI)
  const { width, height } = page.getSize();

  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);

  const primaryColor = invoiceData.isDemo ? rgb(0.2, 0.6, 0.2) : rgb(0.08, 0.45, 0.85);
  const darkColor = rgb(0.12, 0.14, 0.18);
  const grayColor = rgb(0.45, 0.48, 0.52);
  const lightBg = rgb(0.96, 0.97, 0.98);

  let y = height - 50;

  // Header Banner
  page.drawText('PrintGo', { x: 50, y, size: 24, font: fontBold, color: primaryColor });
  
  let headerTitle = 'RETAIL PRINT RECEIPT';
  let subBanner = 'Self-Service Smart Printing Kiosk';

  if (invoiceData.isDemo) {
    headerTitle = 'DEMO PRINT RECEIPT';
    subBanner = 'SIMULATED DEMO — NO REAL MONEY COLLECTED';
  } else if (invoiceData.sellerGstin && invoiceData.sellerGstin.trim()) {
    headerTitle = 'TAX INVOICE';
  }

  page.drawText(headerTitle, { x: width - 230, y, size: 13, font: fontBold, color: darkColor });

  y -= 18;
  page.drawText(subBanner, { x: 50, y, size: 9, font: fontBold, color: invoiceData.isDemo ? rgb(0.7, 0.2, 0.2) : grayColor });
  page.drawText(`Invoice #: ${invoiceData.invoiceNumber}`, { x: width - 230, y, size: 10, font: fontBold, color: darkColor });

  y -= 15;
  const issueDateStr = new Date(invoiceData.issuedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
  page.drawText(`Date: ${issueDateStr}`, { x: width - 230, y, size: 9, font: fontRegular, color: grayColor });

  y -= 25;
  page.drawLine({ start: { x: 50, y }, end: { x: width - 50, y }, thickness: 1, color: rgb(0.85, 0.88, 0.92) });

  y -= 25;
  // Seller and Buyer Columns
  page.drawText('ISSUED BY:', { x: 50, y, size: 9, font: fontBold, color: grayColor });
  page.drawText('JOB & CUSTOMER DETAILS:', { x: 300, y, size: 9, font: fontBold, color: grayColor });

  y -= 16;
  page.drawText(invoiceData.sellerName, { x: 50, y, size: 11, font: fontBold, color: darkColor });
  page.drawText(`Job ID: ${invoiceData.printJobShortId}`, { x: 300, y, size: 10, font: fontBold, color: darkColor });

  y -= 14;
  if (invoiceData.isDemo) {
    page.drawText('Classification: 1-Click Simulation', { x: 50, y, size: 9, font: fontRegular, color: grayColor });
  } else if (invoiceData.sellerGstin) {
    page.drawText(`GSTIN: ${invoiceData.sellerGstin}`, { x: 50, y, size: 9, font: fontRegular, color: darkColor });
  } else {
    page.drawText('GST: Unregistered Supplier (SAC 9989)', { x: 50, y, size: 9, font: fontRegular, color: grayColor });
  }
  page.drawText(`Document: ${(invoiceData.documentName || 'Document.pdf').substring(0, 32)}`, { x: 300, y, size: 9, font: fontRegular, color: darkColor });

  y -= 14;
  page.drawText(`State: ${invoiceData.sellerState || 'Telangana'}`, { x: 50, y, size: 9, font: fontRegular, color: darkColor });
  page.drawText(`Payment: ${invoiceData.paymentMethod || 'Online'} (${invoiceData.paymentStatus})`, { x: 300, y, size: 9, font: fontRegular, color: darkColor });

  y -= 30;

  // Line Items Table Header
  page.drawRectangle({
    x: 50,
    y: y - 5,
    width: width - 100,
    height: 24,
    color: lightBg
  });

  page.drawText('ITEM DESCRIPTION', { x: 60, y: y + 2, size: 9, font: fontBold, color: darkColor });
  page.drawText('SAC', { x: 340, y: y + 2, size: 9, font: fontBold, color: darkColor });
  page.drawText('COPIES', { x: 410, y: y + 2, size: 9, font: fontBold, color: darkColor });
  page.drawText('AMOUNT (INR)', { x: 480, y: y + 2, size: 9, font: fontBold, color: darkColor });

  y -= 25;

  // Render Line Items
  const items = Array.isArray(invoiceData.lineItems) ? invoiceData.lineItems : [];
  for (const item of items) {
    page.drawText(item.description ? item.description.substring(0, 48) : 'Print Job', { x: 60, y, size: 9, font: fontRegular, color: darkColor });
    page.drawText(invoiceData.sacCode || '9989', { x: 340, y, size: 9, font: fontRegular, color: darkColor });
    page.drawText(String(item.copies || 1), { x: 420, y, size: 9, font: fontRegular, color: darkColor });
    page.drawText(`Rs. ${Number(item.amount || invoiceData.totalAmount).toFixed(2)}`, { x: 485, y, size: 9, font: fontBold, color: darkColor });
    y -= 20;
  }

  y -= 10;
  page.drawLine({ start: { x: 50, y }, end: { x: width - 50, y }, thickness: 1, color: rgb(0.85, 0.88, 0.92) });

  y -= 25;
  // Totals Section
  const totalsX = 340;
  const valuesX = 485;

  page.drawText('Subtotal (Taxable Value):', { x: totalsX, y, size: 9, font: fontRegular, color: grayColor });
  page.drawText(`Rs. ${invoiceData.taxableAmount.toFixed(2)}`, { x: valuesX, y, size: 9, font: fontRegular, color: darkColor });

  if (invoiceData.cgstAmount > 0 || invoiceData.sgstAmount > 0) {
    y -= 16;
    page.drawText(`CGST (${invoiceData.cgstRate}%):`, { x: totalsX, y, size: 9, font: fontRegular, color: grayColor });
    page.drawText(`Rs. ${invoiceData.cgstAmount.toFixed(2)}`, { x: valuesX, y, size: 9, font: fontRegular, color: darkColor });

    y -= 16;
    page.drawText(`SGST (${invoiceData.sgstRate}%):`, { x: totalsX, y, size: 9, font: fontRegular, color: grayColor });
    page.drawText(`Rs. ${invoiceData.sgstAmount.toFixed(2)}`, { x: valuesX, y, size: 9, font: fontRegular, color: darkColor });
  }

  if (invoiceData.convenienceFee > 0) {
    y -= 16;
    page.drawText('Convenience Fee:', { x: totalsX, y, size: 9, font: fontRegular, color: grayColor });
    page.drawText(`Rs. ${invoiceData.convenienceFee.toFixed(2)}`, { x: valuesX, y, size: 9, font: fontRegular, color: darkColor });
  }

  y -= 20;
  page.drawRectangle({
    x: totalsX - 10,
    y: y - 5,
    width: width - totalsX - 35,
    height: 25,
    color: invoiceData.isDemo ? rgb(0.92, 0.98, 0.92) : rgb(0.92, 0.96, 1.0)
  });

  page.drawText('Total Amount Paid:', { x: totalsX, y: y + 2, size: 10, font: fontBold, color: primaryColor });
  page.drawText(`Rs. ${invoiceData.totalAmount.toFixed(2)}`, { x: valuesX, y: y + 2, size: 11, font: fontBold, color: primaryColor });

  // Footer
  const footerY = 50;
  page.drawLine({ start: { x: 50, y: footerY + 15 }, end: { x: width - 50, y: footerY + 15 }, thickness: 0.5, color: rgb(0.85, 0.88, 0.92) });
  page.drawText('This is a computer-generated receipt/invoice. No physical signature required.', {
    x: 120,
    y: footerY,
    size: 8,
    font: fontRegular,
    color: grayColor
  });

  const pdfBytes = await pdfDoc.save();
  fs.writeFileSync(filePath, pdfBytes);
  return filePath;
};

/**
 * Generates a clean 1-page PDF Credit Note using pdf-lib.
 */
const generateCreditNotePdf = async (creditData, filePath) => {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([595.28, 841.89]);
  const { width, height } = page.getSize();

  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);

  const alertColor = rgb(0.85, 0.2, 0.2); // Alert red
  const darkColor = rgb(0.12, 0.14, 0.18);
  const grayColor = rgb(0.45, 0.48, 0.52);
  const lightBg = rgb(0.95, 0.96, 0.98);

  let y = height - 50;

  // Header Banner
  page.drawText('PrintGo', { x: 50, y, size: 24, font: fontBold, color: alertColor });
  page.drawText('CREDIT NOTE', { x: width - 230, y, size: 14, font: fontBold, color: darkColor });

  y -= 18;
  page.drawText('Goods / Service Refund Acknowledgment (Section 34 CGST Act)', { x: 50, y, size: 9, font: fontRegular, color: grayColor });
  page.drawText(`Credit Note #: ${creditData.creditNoteNumber}`, { x: width - 230, y, size: 10, font: fontBold, color: darkColor });

  y -= 15;
  const issueDateStr = new Date(creditData.issuedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
  page.drawText(`Date: ${issueDateStr}`, { x: width - 230, y, size: 9, font: fontRegular, color: grayColor });

  y -= 25;
  page.drawLine({ start: { x: 50, y }, end: { x: width - 50, y }, thickness: 1, color: rgb(0.85, 0.88, 0.92) });

  y -= 25;
  page.drawText('ORIGINAL INVOICE REFERENCE:', { x: 50, y, size: 9, font: fontBold, color: grayColor });
  page.drawText('REFUND REASON:', { x: 300, y, size: 9, font: fontBold, color: grayColor });

  y -= 16;
  page.drawText(`Invoice #: ${creditData.originalInvoiceNumber}`, { x: 50, y, size: 11, font: fontBold, color: darkColor });
  page.drawText(creditData.reason.substring(0, 45), { x: 300, y, size: 10, font: fontBold, color: darkColor });

  y -= 30;
  // Refund Amount Box
  page.drawRectangle({
    x: 50,
    y: y - 50,
    width: width - 100,
    height: 60,
    color: rgb(0.98, 0.94, 0.94)
  });

  page.drawText('Total Amount Credited / Refunded:', { x: 70, y: y - 20, size: 12, font: fontBold, color: alertColor });
  page.drawText(`Rs. ${creditData.totalAmount.toFixed(2)}`, { x: 380, y: y - 20, size: 16, font: fontBold, color: alertColor });

  y -= 75;
  // Tax breakdown
  page.drawText('Taxable Value Adjustment:', { x: 300, y, size: 9, font: fontRegular, color: grayColor });
  page.drawText(`Rs. ${creditData.subtotal.toFixed(2)}`, { x: 480, y, size: 9, font: fontRegular, color: darkColor });

  if (creditData.cgstAmount > 0 || creditData.sgstAmount > 0) {
    y -= 16;
    page.drawText('CGST Reversal:', { x: 300, y, size: 9, font: fontRegular, color: grayColor });
    page.drawText(`Rs. ${creditData.cgstAmount.toFixed(2)}`, { x: 480, y, size: 9, font: fontRegular, color: darkColor });

    y -= 16;
    page.drawText('SGST Reversal:', { x: 300, y, size: 9, font: fontRegular, color: grayColor });
    page.drawText(`Rs. ${creditData.sgstAmount.toFixed(2)}`, { x: 480, y, size: 9, font: fontRegular, color: darkColor });
  }

  const pdfBytes = await pdfDoc.save();
  fs.writeFileSync(filePath, pdfBytes);
  return filePath;
};

/**
 * Generates an authoritative customer invoice for a verified paid job.
 * Enforces strict financial eligibility, idempotency, and concurrency safety.
 */
const generateInvoiceForJob = async (jobId, buyerInfo = {}) => {
  const job = await prisma.printJob.findUnique({
    where: { shortId: jobId },
    include: {
      document: true,
      machine: { include: { company: true } },
      customer: true,
      payment: true,
      invoice: true
    }
  });

  if (!job) throw new AppError('Job not found', 404);

  // Idempotency: Return existing invoice if already issued
  if (job.invoice) {
    return job.invoice;
  }

  // 1. STRICT PAYMENT STATUS & ELIGIBILITY VERIFICATION
  if (job.status === 'PENDING_PAYMENT') {
    logger.warn(`Security alert: Invoice generation rejected for job ${job.shortId}: Job is pending payment`);
    throw new AppError('Cannot generate invoice: Job is pending payment and unpaid', 400);
  }

  if (!job.payment) {
    logger.warn(`Security alert: Invoice generation rejected for job ${job.shortId}: No payment record exists`);
    throw new AppError('Cannot generate invoice: No payment record found for job', 400);
  }

  if (job.payment.status !== 'SUCCESS') {
    logger.warn(`Security alert: Invoice generation rejected for job ${job.shortId}: Payment is in '${job.payment.status}' state`);
    throw new AppError(`Cannot generate invoice: Payment is in '${job.payment.status}' state, not SUCCESS`, 400);
  }

  // 2. STRICT AMOUNT INTEGRITY VERIFICATION
  if (Math.abs(job.cost - job.payment.amount) > 0.01) {
    logger.error(`CRITICAL: Invoice generation rejected for job ${job.shortId}: Authoritative cost (Rs. ${job.cost}) != payment amount (Rs. ${job.payment.amount})`);
    throw new AppError('Cannot generate invoice: Authoritative job cost does not match payment amount', 400);
  }

  // 3. DEMO PAYMENT CLASSIFICATION
  const isDemo = Boolean(
    job.payment?.gatewayOrderId?.startsWith('demo_order_') ||
    job.payment?.paymentMethod === 'demo'
  );

  // Fetch business profile
  const business = await getBusinessProfile(job.machine?.companyId);

  // Parse pricing snapshot
  let snapshot = {};
  if (job.pricingSnapshot) {
    try {
      snapshot = JSON.parse(job.pricingSnapshot);
    } catch {
      snapshot = {};
    }
  }

  const calc = snapshot.calculation || {};
  const lineItems = snapshot.lineItems || [
    {
      description: `Printing Job ${job.shortId} (${job.color === 'color' ? 'Colour' : 'B&W'}, ${job.duplex === 'double' ? 'Duplex' : 'Single-sided'})`,
      copies: job.copies,
      amount: job.cost
    }
  ];

  // If demo, taxes are zeroed out (no real tax liability on simulation)
  const taxableAmount = isDemo ? job.cost : (calc.taxableAmount || job.cost);
  const cgstAmount = isDemo ? 0.0 : (calc.cgstAmount || 0.0);
  const sgstAmount = isDemo ? 0.0 : (calc.sgstAmount || 0.0);
  const igstAmount = isDemo ? 0.0 : (calc.igstAmount || 0.0);
  const totalTax = isDemo ? 0.0 : (calc.totalTax || 0.0);
  const cgstRate = (isDemo || !calc.gstEnabled) ? 0.0 : (calc.gstRatePercent / 2);
  const sgstRate = (isDemo || !calc.gstEnabled) ? 0.0 : (calc.gstRatePercent / 2);
  const totalAmount = job.cost;

  // 4. TRANSACTIONAL IDEMPOTENCY & CONCURRENCY-SAFE INVOICE NUMBERING
  const result = await prisma.$transaction(async (tx) => {
    // Acquire PostgreSQL transaction-scoped advisory lock to serialize sequential invoice numbering across concurrent workers
    await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtext('invoice_sequence_generator'))");

    // Re-check inside transaction to eliminate race conditions
    const freshInvoice = await tx.invoice.findUnique({
      where: { printJobId: job.id }
    });
    if (freshInvoice) return freshInvoice;

    const nowYear = new Date().getFullYear();
    const invoiceCount = await tx.invoice.count();
    const baseSeq = (business.nextInvoiceNumber || 1000) + invoiceCount;
    let invoiceNumber = `${business.invoicePrefix || 'INV-PG-'}${nowYear}-${baseSeq}`;

    let counter = 0;
    while (await tx.invoice.findUnique({ where: { invoiceNumber } })) {
      counter++;
      invoiceNumber = `${business.invoicePrefix || 'INV-PG-'}${nowYear}-${baseSeq + counter}`;
    }

    const invoiceData = {
      invoiceNumber,
      printJobId: job.id,
      printJobShortId: job.shortId,
      paymentId: job.paymentId,
      documentName: job.document?.originalName,
      paymentMethod: job.payment?.paymentMethod || 'Online',
      paymentStatus: job.payment?.status || 'SUCCESS',
      subtotal: taxableAmount,
      discountAmount: 0.0,
      taxableAmount,
      cgstRate,
      cgstAmount,
      sgstRate,
      sgstAmount,
      igstRate: 0.0,
      igstAmount,
      totalTax,
      convenienceFee: calc.ratesApplied?.convenienceFee || 0,
      totalAmount,
      currency: 'INR',
      status: 'ISSUED',
      isDemo,
      sellerName: isDemo ? 'PrintGo Demo Kiosk (Simulated)' : (business.legalName || 'PrintGo Self-Service Kiosks'),
      sellerGstin: isDemo ? null : (business.gstin || null),
      sellerState: business.state || 'Telangana',
      buyerName: buyerInfo.name || job.customer?.name || 'Walk-in Customer',
      buyerPhone: buyerInfo.phone || job.customer?.phone || null,
      buyerEmail: buyerInfo.email || job.customer?.email || null,
      sacCode: business.sacCode || '9989',
      pricingSnapshot: JSON.stringify(snapshot),
      lineItems,
      issuedAt: new Date()
    };

    const pdfFileName = `${invoiceNumber}.pdf`;
    const pdfFilePath = path.join(INVOICE_DIR, pdfFileName);

    // Generate physical PDF file
    await generateInvoicePdf(invoiceData, pdfFilePath);

    // Persist Invoice record
    const invoice = await tx.invoice.create({
      data: {
        invoiceNumber: invoiceData.invoiceNumber,
        printJobId: invoiceData.printJobId,
        paymentId: invoiceData.paymentId,
        subtotal: invoiceData.subtotal,
        discountAmount: invoiceData.discountAmount,
        taxableAmount: invoiceData.taxableAmount,
        cgstRate: invoiceData.cgstRate,
        cgstAmount: invoiceData.cgstAmount,
        sgstRate: invoiceData.sgstRate,
        sgstAmount: invoiceData.sgstAmount,
        igstRate: invoiceData.igstRate,
        igstAmount: invoiceData.igstAmount,
        totalTax: invoiceData.totalTax,
        convenienceFee: invoiceData.convenienceFee,
        totalAmount: invoiceData.totalAmount,
        currency: invoiceData.currency,
        status: 'ISSUED',
        isDemo,
        sellerName: invoiceData.sellerName,
        sellerGstin: invoiceData.sellerGstin,
        sellerState: invoiceData.sellerState,
        buyerName: invoiceData.buyerName,
        buyerPhone: invoiceData.buyerPhone,
        buyerEmail: invoiceData.buyerEmail,
        sacCode: invoiceData.sacCode,
        pricingSnapshot: invoiceData.pricingSnapshot,
        lineItems: JSON.stringify(invoiceData.lineItems),
        pdfPath: `/uploads/invoices/${pdfFileName}`,
        issuedAt: invoiceData.issuedAt
      }
    });

    logger.info(`Invoice issued: ${invoiceNumber} for job ${job.shortId} (amount: Rs. ${totalAmount}, isDemo: ${isDemo})`);
    return invoice;
  });

  return result;
};

/**
 * Issues a legally compliant Credit Note for an issued invoice upon refund.
 * Supports both full and partial refunds with cumulative bounds enforcement.
 * Preserves the original invoice and its financial details.
 */
const issueCreditNoteForInvoice = async (invoiceId, options = {}) => {
  const { reason = 'Print Service Refund / Cancellation', user = null, refundId = null, amount = null } = options;

  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    include: { printJob: true, payment: true, creditNotes: true }
  });

  if (!invoice) throw new AppError('Invoice not found', 404);

  // Demo payments must never generate real statutory credit notes
  if (invoice.isDemo) {
    throw new AppError('Demo/simulated transactions do not qualify for statutory GST Credit Notes', 400);
  }

  // Idempotency: If this exact refund already generated a credit note, return it
  if (refundId) {
    const existingCnForRefund = invoice.creditNotes.find(cn => cn.refundId === refundId);
    if (existingCnForRefund) return existingCnForRefund;
  }

  // Calculate existing cumulative credited amount
  const existingCreditedTotal = invoice.creditNotes.reduce((sum, cn) => sum + Number(cn.totalAmount), 0);
  const remainingCreditable = Math.max(0, Math.round((invoice.totalAmount - existingCreditedTotal) * 100) / 100);

  if (remainingCreditable <= 0.009) {
    // If invoice is already fully credited, return existing credit note if no specific amount requested
    if (invoice.creditNotes.length > 0 && amount === null && !refundId) {
      return invoice.creditNotes[0];
    }
    throw new AppError('Invoice is already fully refunded and credited', 400);
  }

  // Determine credit note total amount
  const creditAmount = amount !== null ? Number(amount) : remainingCreditable;
  if (isNaN(creditAmount) || creditAmount <= 0) {
    throw new AppError('Credit note amount must be greater than zero', 400);
  }
  if (creditAmount > remainingCreditable + 0.01) {
    throw new AppError(
      `Credit note amount (Rs. ${creditAmount.toFixed(2)}) exceeds remaining creditable invoice balance (Rs. ${remainingCreditable.toFixed(2)})`,
      400
    );
  }

  // Proportionate tax breakdown
  const ratio = creditAmount / invoice.totalAmount;
  const rawSubtotal = Math.round(invoice.subtotal * ratio * 100) / 100;
  const rawCgst = Math.round(invoice.cgstAmount * ratio * 100) / 100;
  const rawSgst = Math.round(invoice.sgstAmount * ratio * 100) / 100;
  const rawIgst = Math.round(invoice.igstAmount * ratio * 100) / 100;
  const rawTotalTax = Math.round((rawCgst + rawSgst + rawIgst) * 100) / 100;

  // Rounding adjustment: ensure subtotal + totalTax exactly equals creditAmount
  const calculatedSum = Math.round((rawSubtotal + rawTotalTax) * 100) / 100;
  const roundingDiff = Math.round((creditAmount - calculatedSum) * 100) / 100;
  const finalSubtotal = Math.round((rawSubtotal + roundingDiff) * 100) / 100;

  const business = await getBusinessProfile();

  const creditNote = await prisma.$transaction(async (tx) => {
    // Acquire PostgreSQL transaction-scoped advisory lock to serialize credit note numbering
    await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtext('credit_note_sequence_generator'))");

    // Re-verify cumulative sum inside transaction to eliminate race conditions
    const freshCreditNotes = await tx.creditNote.findMany({ where: { invoiceId: invoice.id } });
    if (refundId) {
      const existingFresh = freshCreditNotes.find(cn => cn.refundId === refundId);
      if (existingFresh) return existingFresh;
    }
    const freshCredited = freshCreditNotes.reduce((sum, cn) => sum + Number(cn.totalAmount), 0);
    if (freshCredited + creditAmount > invoice.totalAmount + 0.01) {
      throw new AppError('Concurrent credit note request exceeds invoice balance', 400);
    }

    // Generate Credit Note Number
    const nowYear = new Date().getFullYear();
    const cnCount = await tx.creditNote.count();
    const cnSeq = 1000 + cnCount + 1;
    let creditNoteNumber = `CN-PG-${nowYear}-${cnSeq}`;

    let counter = 0;
    while (await tx.creditNote.findUnique({ where: { creditNoteNumber } })) {
      counter++;
      creditNoteNumber = `CN-PG-${nowYear}-${cnSeq + counter}`;
    }

    const cnData = {
      creditNoteNumber,
      invoiceId: invoice.id,
      originalInvoiceNumber: invoice.invoiceNumber,
      printJobId: invoice.printJobId,
      paymentId: invoice.paymentId,
      refundId: refundId || null,
      reason,
      subtotal: finalSubtotal,
      cgstAmount: rawCgst,
      sgstAmount: rawSgst,
      igstAmount: rawIgst,
      totalTax: rawTotalTax,
      totalAmount: creditAmount,
      currency: invoice.currency,
      issuedBy: user?.id || 'SYSTEM',
      issuedAt: new Date()
    };

    const pdfFileName = `${creditNoteNumber}.pdf`;
    const pdfFilePath = path.join(INVOICE_DIR, pdfFileName);

    // Generate physical PDF Credit Note
    await generateCreditNotePdf(cnData, pdfFilePath);

    // Update Invoice status according to remaining balance
    const newCumulative = freshCredited + creditAmount;
    const isFullRefund = Math.abs(newCumulative - invoice.totalAmount) <= 0.01;
    const nextStatus = isFullRefund ? (options.invoiceStatus || 'CANCELLED') : 'PARTIALLY_REFUNDED';

    await tx.invoice.update({
      where: { id: invoice.id },
      data: { status: nextStatus }
    });

    // Create Credit Note record
    const createdCn = await tx.creditNote.create({
      data: {
        creditNoteNumber: cnData.creditNoteNumber,
        invoiceId: cnData.invoiceId,
        printJobId: cnData.printJobId,
        paymentId: cnData.paymentId,
        refundId: cnData.refundId,
        reason: cnData.reason,
        subtotal: cnData.subtotal,
        cgstAmount: cnData.cgstAmount,
        sgstAmount: cnData.sgstAmount,
        igstAmount: cnData.igstAmount,
        totalTax: cnData.totalTax,
        totalAmount: cnData.totalAmount,
        currency: cnData.currency,
        pdfPath: `/uploads/invoices/${pdfFileName}`,
        issuedBy: cnData.issuedBy,
        issuedAt: cnData.issuedAt
      }
    });

    logger.info(`Credit Note issued: ${creditNoteNumber} for Invoice ${invoice.invoiceNumber} (amount: Rs. ${cnData.totalAmount})`);
    return createdCn;
  });

  return creditNote;
};

/**
 * Retrieves invoice by job shortId.
 */
const getInvoiceByShortId = async (shortId) => {
  const job = await prisma.printJob.findUnique({
    where: { shortId },
    include: { invoice: true, payment: true, document: true }
  });

  if (!job) throw new AppError('Job not found', 404);

  if (!job.invoice) {
    if (job.status !== 'PENDING_PAYMENT' && job.payment && job.payment.status === 'SUCCESS') {
      return await generateInvoiceForJob(shortId);
    }
    throw new AppError('Invoice not available: Job has not been successfully paid', 400);
  }

  return job.invoice;
};

module.exports = {
  generateInvoiceForJob,
  getInvoiceByShortId,
  issueCreditNoteForInvoice,
  getBusinessProfile,
  INVOICE_DIR
};
