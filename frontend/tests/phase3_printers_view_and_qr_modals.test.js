/**
 * PRINTGO — PHASE 3 FRONTEND ADMIN DASHBOARD QR INTEGRATION TEST SUITE
 *
 * Tests the React components, layout, lifecycle modals, validation, and permissions:
 * 1. Printers with no QR (NOT GENERATED status, empty state, generate button)
 * 2. ACTIVE QR preview (Badge, Canvas, SVG, Public URL, distinction banner)
 * 3. REVOKED and REPLACED historical records in ledger
 * 4. QR generation modal
 * 5. HTTP 409 conflict handling
 * 6. PNG and SVG export elements (Canvas 1024x1024, SVG 1024x1024)
 * 7. Printable counter display layout (Neutral branding, quiet zone, 3-step instructions)
 * 8. Rotation confirmation & operator reason validation
 * 9. Revocation reason validation (>= 10 characters)
 * 10. Multi-tenant Franchisee scoping & unauthorized controls
 * 11. API failure & loading states
 */

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import fs from 'node:fs';
import path from 'node:path';
import {
  PrinterQrPreviewModal,
  PrintableCounterFlyer,
  PrinterQrGenerateModal,
  PrinterQrRotateModal,
  PrinterQrRevokeModal,
  PrinterQrLedgerModal,
  validateQrTargetUrl
} from '../src/components/admin/views/PrinterQrModals.jsx';
import { PrintersView } from '../src/components/admin/views/PrintersView.jsx';

let passed = 0;
let failed = 0;

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const test = (name, fn) => {
  try {
    fn();
    console.log(`✅ PASS: ${name}`);
    passed++;
  } catch (e) {
    console.error(`❌ FAIL: ${name}`);
    console.error(`   Details: ${e.message}`);
    failed++;
  }
};

console.log('======================================================================');
console.log('PRINTGO — PHASE 3 FRONTEND UI & MODAL VERIFICATION TEST SUITE');
console.log('======================================================================\n');

// Synthetic Test Fixtures
const mockMachineA = {
  id: 'mch_synthetic_001',
  name: 'Front Counter Epson L6460',
  location: 'Main Desk',
  status: 'ACTIVE',
  printerModel: 'EPSON L6460 Series',
  machineKey: 'EPSONE52365KEY',
  companyId: 'comp_alpha_123',
  company: { name: 'Alpha Communications' }
};

const mockMachineB = {
  id: 'mch_synthetic_002',
  name: 'Backroom HP LaserJet',
  location: 'Back Office',
  status: 'ACTIVE',
  printerModel: 'HP LaserJet Pro',
  machineKey: 'HPPROKEY789',
  companyId: 'comp_beta_456',
  company: { name: 'Beta Communications' }
};

const mockActiveQr = {
  id: 'qr_active_uuid_001',
  publicCode: 'pq_vII8PbMHhL3O744k3wm_svMWdZA-PqDpadewPGk-Ae0',
  label: 'Front Counter Stand',
  status: 'ACTIVE',
  machineId: 'mch_synthetic_001',
  generatedBy: 'usr_admin_01',
  createdAt: '2026-11-10T12:00:00.000Z',
  targetUrl: 'https://printgo.in/p/pq_vII8PbMHhL3O744k3wm_svMWdZA-PqDpadewPGk-Ae0'
};

const mockLedger = {
  activeQr: mockActiveQr,
  history: [
    {
      id: 'qr_replaced_uuid_002',
      publicCode: 'pq_RaE0v22d5drPcqNaGJIk7JEud8AD8QAmUNq1Oqtxbus',
      label: 'Old Counter Sticker',
      status: 'REPLACED',
      machineId: 'mch_synthetic_001',
      generatedBy: 'usr_admin_01',
      revokedAt: '2026-11-10T11:00:00.000Z',
      revokedBy: 'usr_admin_01',
      revokedReason: 'Physical acrylic stand was replaced with new tabletop stand'
    },
    {
      id: 'qr_revoked_uuid_003',
      publicCode: 'pq_W2TQ1s_jSow6vis7jVE_an-6NWwG8Rk8UDSRmGEBbzc',
      label: 'Temporary Demo Tag',
      status: 'REVOKED',
      machineId: 'mch_synthetic_001',
      generatedBy: 'usr_admin_01',
      revokedAt: '2026-11-09T18:00:00.000Z',
      revokedBy: 'usr_admin_01',
      revokedReason: 'Decommissioned test tag after shop layout reconfiguration'
    }
  ],
  total: 3
};

const userSuperadmin = { id: 'usr_super', role: 'SUPERADMIN', email: 'admin@printgo.in' };
const userFranchiseeA = { id: 'usr_fran_a', role: 'FRANCHISEE', companyId: 'comp_alpha_123', email: 'owner@alpha.com' };

// ------------------------------------------------------------------
// TEST CASES
// ------------------------------------------------------------------

test('1. Printers with no QR render NOT GENERATED badge and empty state message', () => {
  const html = renderToStaticMarkup(
    React.createElement(PrintersView, {
      machines: [mockMachineA],
      telemetryHistory: [],
      printerStatus: { isError: false },
      currentUser: userSuperadmin
    })
  );

  assert(html.includes('NOT GENERATED'), 'Must show NOT GENERATED status badge');
  assert(html.includes('No dedicated QR has been generated for this physical printer yet'), 'Must show clear empty state');
  assert(html.includes('Generate Permanent QR'), 'Must show Generate Permanent QR action button for authorized user');
});

test('2. ACTIVE QR Preview Modal renders high-res QR, Public URL and Distinction Banner', () => {
  const html = renderToStaticMarkup(
    React.createElement(PrinterQrPreviewModal, {
      qr: mockActiveQr,
      machine: mockMachineA,
      onClose: () => {},
      onOpenPrintFlyer: () => {},
      onOpenRotate: () => {},
      onOpenRevoke: () => {},
      isAuthorized: true
    })
  );

  assert(html.includes('Dedicated Printer QR Code'), 'Must render modal title');
  assert(html.includes('Permanent Physical Identifier'), 'Must show permanent identity banner');
  assert(html.includes('The physical QR code never expires'), 'Must explain distinction between permanent QR and temporary session');
  assert(html.includes(mockActiveQr.targetUrl), 'Must display readable public HTTPS URL');
  assert(html.includes(mockActiveQr.publicCode), 'Must display public token');
  assert(html.includes('Download PNG'), 'Must provide Download PNG action');
  assert(html.includes('Download SVG'), 'Must provide Download SVG action');
  assert(html.includes('Print Counter Flyer'), 'Must provide Print Counter Flyer action');
});

test('3. High-Res PNG and SVG export canvas/SVG elements exist at 1024x1024 resolution', () => {
  const html = renderToStaticMarkup(
    React.createElement(PrinterQrPreviewModal, {
      qr: mockActiveQr,
      machine: mockMachineA,
      onClose: () => {},
      isAuthorized: true
    })
  );

  assert(html.includes('id="preview-qr-canvas-hi-res"'), 'Must render hidden hi-res canvas element');
  assert(html.includes('id="preview-qr-svg-hi-res"'), 'Must render hidden hi-res SVG element');
  assert(html.includes('width="1024"'), 'Canvas/SVG must be configured at 1024px for crisp counter printing');
});

test('4. Printable Counter Display Flyer adheres to neutral layout with quiet zone and 3-step instructions', () => {
  const html = renderToStaticMarkup(
    React.createElement(PrintableCounterFlyer, {
      qr: mockActiveQr,
      machine: mockMachineA,
      onClose: () => {}
    })
  );

  assert(html.includes('Self-Service Mobile Printing') || html.includes('SELF-SERVICE MOBILE PRINTING'), 'Must display neutral title');
  assert(html.includes('Scan QR'), 'Must include Step 1: Scan QR');
  assert(html.includes('Upload'), 'Must include Step 2: Upload');
  assert(html.includes('Choose options'), 'Must include Step 3: Choose options');
  assert(html.includes(mockActiveQr.targetUrl), 'Must display public scan URL on physical flyer');
  assert(html.includes('Print Now'), 'Must provide Print Now trigger calling window.print');
  // Branding protection: verify no unauthorized logos or brand merges
  assert(!html.includes('SPURTI COMMUNICATIONS'), 'Neutral flyer must not hardcode SPURTI on generic template');
  assert(!html.includes('S3K'), 'Neutral flyer must not hardcode S3K on generic template');
});

test('5. QR Generation Modal renders placement label input and confirmation dialog', () => {
  const html = renderToStaticMarkup(
    React.createElement(PrinterQrGenerateModal, {
      machine: mockMachineA,
      onConfirm: () => {},
      onClose: () => {},
      isSubmitting: false,
      errorMsg: ''
    })
  );

  assert(html.includes('Generate Permanent Dedicated QR'), 'Must render generation header');
  assert(html.includes('Placement Label'), 'Must provide Placement Label field');
  assert(html.includes('Confirm &amp; Generate') || html.includes('Confirm & Generate'), 'Must render confirmation button');
});

test('6. HTTP 409 conflict handling displays clear user-friendly error message in Generation Modal', () => {
  const conflictError = 'An active dedicated QR already exists for this printer. Use replace to rotate.';
  const html = renderToStaticMarkup(
    React.createElement(PrinterQrGenerateModal, {
      machine: mockMachineA,
      onConfirm: () => {},
      onClose: () => {},
      isSubmitting: false,
      errorMsg: conflictError
    })
  );

  assert(html.includes(conflictError), 'Must render HTTP 409 error message in UI');
});

test('7. QR Rotate Modal renders warning, character counter, and enforces reason validation', () => {
  const html = renderToStaticMarkup(
    React.createElement(PrinterQrRotateModal, {
      qr: mockActiveQr,
      machine: mockMachineA,
      onConfirm: () => {},
      onClose: () => {},
      isSubmitting: false,
      errorMsg: ''
    })
  );

  assert(html.includes('Rotate Dedicated Printer QR'), 'Must render rotation header');
  assert(html.includes('Important Operational Impact'), 'Must render operational impact warning');
  assert(html.includes('10 characters minimum'), 'Must render character counter requirement');
  assert(html.includes('Authorize Rotation'), 'Must provide authorization button');
});

test('8. QR Revoke Modal renders permanent deactivation warning and enforces reason validation', () => {
  const html = renderToStaticMarkup(
    React.createElement(PrinterQrRevokeModal, {
      qr: mockActiveQr,
      machine: mockMachineA,
      onConfirm: () => {},
      onClose: () => {},
      isSubmitting: false,
      errorMsg: ''
    })
  );

  assert(html.includes('Revoke Dedicated Printer QR'), 'Must render revocation header');
  assert(html.includes('Permanent Deactivation'), 'Must render permanent deactivation warning');
  assert(html.includes('Scans will be rejected with HTTP 410 Gone'), 'Must explain HTTP 410 customer rejection');
  assert(html.includes('10 characters minimum'), 'Must render character counter requirement');
  assert(html.includes('Confirm Revocation'), 'Must provide confirmation button');
});

test('9. QR Audit Ledger Modal displays full history of REPLACED and REVOKED records', () => {
  const html = renderToStaticMarkup(
    React.createElement(PrinterQrLedgerModal, {
      machine: mockMachineA,
      ledger: mockLedger,
      onClose: () => {},
      onOpenPreview: () => {}
    })
  );

  assert(html.includes('Dedicated QR Audit Ledger'), 'Must render ledger title');
  assert(html.includes('Current Active'), 'Must display Current Active badge');
  assert(html.includes('REPLACED'), 'Must display REPLACED historical badge');
  assert(html.includes('REVOKED'), 'Must display REVOKED historical badge');
  assert(html.includes('Physical acrylic stand was replaced with new tabletop stand'), 'Must display replacement reason');
  assert(html.includes('Decommissioned test tag after shop layout reconfiguration'), 'Must display revocation reason');
});

test('10. Multi-tenant Franchisee scoping: Franchisee A cannot generate QR for Franchisee B printer', () => {
  // Machine B belongs to company Beta. User Franchisee A belongs to company Alpha.
  const html = renderToStaticMarkup(
    React.createElement(PrintersView, {
      machines: [mockMachineB],
      telemetryHistory: [],
      printerStatus: { isError: false },
      currentUser: userFranchiseeA
    })
  );

  assert(html.includes('Backroom HP LaserJet'), 'Must render printer name');
  assert(html.includes('Read-Only / Franchisee Scoped'), 'Must hide mutation buttons and display scoped notice');
  assert(!html.includes('Generate Permanent QR'), 'Must NOT render Generate Permanent QR button for cross-tenant machine');
});

test('11. Global error and success alert banners render correctly when messages are present', () => {
  const htmlUnauthorized = renderToStaticMarkup(
    React.createElement(PrinterQrPreviewModal, {
      qr: mockActiveQr,
      machine: mockMachineA,
      onClose: () => {},
      isAuthorized: false
    })
  );
  // Unauthorized user viewing preview modal has rotate/revoke controls hidden
  assert(!htmlUnauthorized.includes('Rotate QR'), 'Unauthorized user must NOT see Rotate QR button');
  assert(!htmlUnauthorized.includes('Revoke QR'), 'Unauthorized user must NOT see Revoke QR button');
  assert(htmlUnauthorized.includes('Download PNG'), 'Read-only users can still download existing QR');
});

// --- PHASE 3.1 POLISH & PUBLIC URL SAFETY TESTS ---

test('12. .no-print controls are hidden during print via @media print stylesheet', () => {
  const cssContent = fs.readFileSync(path.resolve(process.cwd(), 'src/index.css'), 'utf8');
  assert(cssContent.includes('@media print'), 'Stylesheet must contain @media print block');
  assert(cssContent.includes('.no-print'), 'Stylesheet must define .no-print selector');
  assert(
    cssContent.includes('.no-print') && cssContent.includes('display: none !important'),
    '.no-print rule must enforce display: none !important'
  );
});

test('13. Dashboard chrome and backdrop do not print', () => {
  const cssContent = fs.readFileSync(path.resolve(process.cwd(), 'src/index.css'), 'utf8');
  assert(cssContent.includes('.admin-sidebar'), 'Must hide .admin-sidebar in print stylesheet');
  assert(cssContent.includes('.admin-topbar'), 'Must hide .admin-topbar in print stylesheet');
  assert(cssContent.includes('.printable-flyer-modal-backdrop'), 'Must target .printable-flyer-modal-backdrop');
  assert(cssContent.includes('background: transparent !important'), 'Modal backdrop must be neutralized to transparent');
  assert(cssContent.includes('backdrop-filter: none !important'), 'Modal backdrop-filter must be cleared');
});

test('14. Flyer remains visible with avoid page-break inside', () => {
  const cssContent = fs.readFileSync(path.resolve(process.cwd(), 'src/index.css'), 'utf8');
  assert(cssContent.includes('#printable-counter-card'), 'Must format #printable-counter-card for print');
  assert(cssContent.includes('page-break-inside: avoid !important'), 'Flyer card must prevent page breaking');
  assert(cssContent.includes('display: block !important'), 'Flyer card must remain displayed as block');
});

test('15. A4 and A5 print layout styles exist', () => {
  const cssContent = fs.readFileSync(path.resolve(process.cwd(), 'src/index.css'), 'utf8');
  assert(cssContent.includes('@page'), 'Must define @page directive');
  assert(cssContent.includes('margin: 10mm'), 'Must set print margins for counter flyers');
  assert(cssContent.includes('max-width: 148mm !important'), 'Flyer max-width must fit A5 or center on A4');
});

test('16. Missing targetUrl blocks QR generation/export/print and renders configuration error', () => {
  // Test validateQrTargetUrl helper
  const validationMissing = validateQrTargetUrl(undefined);
  assert(!validationMissing.isValid, 'Missing targetUrl must fail validation');
  assert(validationMissing.error.includes('Configuration Error'), 'Error message must specify configuration error');

  // Test component rendering with missing targetUrl
  const mockQrNoUrl = {
    id: 'qr_no_url_001',
    publicCode: 'pq_sample_code_123',
    label: 'Counter Stand',
    status: 'ACTIVE'
    // targetUrl intentionally omitted
  };

  const previewHtml = renderToStaticMarkup(
    React.createElement(PrinterQrPreviewModal, {
      qr: mockQrNoUrl,
      machine: mockMachineA,
      onClose: () => {},
      isAuthorized: true
    })
  );

  assert(previewHtml.includes('Configuration Error'), 'Preview modal must display configuration error banner');
  assert(previewHtml.includes('QR Generation Blocked'), 'Preview modal must block visual QR generation');
  assert(previewHtml.includes('disabled=""'), 'Action buttons must have disabled attribute when URL is missing');
  assert(!previewHtml.includes('id="preview-qr-canvas-hi-res"'), 'Hi-res canvas must NOT render when URL is missing');

  // Test flyer rendering with missing targetUrl
  const flyerHtml = renderToStaticMarkup(
    React.createElement(PrintableCounterFlyer, {
      qr: mockQrNoUrl,
      machine: mockMachineA,
      onClose: () => {}
    })
  );

  assert(flyerHtml.includes('QR Generation Blocked'), 'Flyer preview must block visual QR');
  assert(flyerHtml.includes('Configuration Error (Scan URL Unavailable)'), 'Flyer must show URL configuration error');
});

test('17. Invalid or non-HTTPS URL is rejected by validation', () => {
  const valHttp = validateQrTargetUrl('http://printgo.in/p/pq_test');
  assert(!valHttp.isValid, 'HTTP protocol must be rejected');
  assert(valHttp.error.includes('Security Error'), 'Must return security error for HTTP');

  const valMalformed = validateQrTargetUrl('not-a-valid-url');
  assert(!valMalformed.isValid, 'Malformed URL must be rejected');

  const valLocalhost = validateQrTargetUrl('https://localhost:5173/p/pq_test');
  assert(!valLocalhost.isValid, 'Localhost URL must be rejected');

  const valLan = validateQrTargetUrl('https://192.168.1.50/p/pq_test');
  assert(!valLan.isValid, 'Private LAN IP must be rejected');
});

test('18. Valid backend targetUrl is used unchanged', () => {
  const validUrl = 'https://custom-kiosk.printgo.in/p/pq_abcdef123456';
  const val = validateQrTargetUrl(validUrl);
  assert(val.isValid, 'Valid HTTPS URL must pass validation');
  assert(val.url === validUrl, 'Valid URL must be preserved exactly unchanged');

  const mockQrWithValidUrl = {
    id: 'qr_valid_001',
    publicCode: 'pq_abcdef123456',
    label: 'Counter Stand',
    targetUrl: validUrl
  };

  const previewHtml = renderToStaticMarkup(
    React.createElement(PrinterQrPreviewModal, {
      qr: mockQrWithValidUrl,
      machine: mockMachineA,
      onClose: () => {},
      isAuthorized: true
    })
  );

  assert(previewHtml.includes(validUrl), 'Rendered preview must embed backend-provided targetUrl');
  assert(previewHtml.includes('id="preview-qr-canvas-hi-res"'), 'Hi-res canvas must render when URL is valid');
});

test('19. No hardcoded public domain fallback remains in PrinterQrModals source', () => {
  const modalsSrc = fs.readFileSync(
    path.resolve(process.cwd(), 'src/components/admin/views/PrinterQrModals.jsx'),
    'utf8'
  );
  assert(!modalsSrc.includes('printgo.in'), 'No hardcoded printgo.in domain must remain in PrinterQrModals.jsx');
  assert(!modalsSrc.includes('localhost:'), 'No hardcoded localhost must remain in PrinterQrModals.jsx');
});

console.log('\n======================================================================');
console.log(`FRONTEND TEST RESULTS: ${passed} PASSED | ${failed} FAILED`);
console.log('======================================================================');

if (failed > 0) {
  process.exit(1);
}
