import '@testing-library/jest-dom';
import React from 'react';
import { vi } from 'vitest';

if (!globalThis.URL.createObjectURL) {
  globalThis.URL.createObjectURL = vi.fn(() => 'blob:http://localhost:5173/mock-preview-url');
}
if (!globalThis.URL.revokeObjectURL) {
  globalThis.URL.revokeObjectURL = vi.fn();
}

// Stub PDFDocument preview canvas workers cleanly for jsdom tests
vi.mock('../components/DocumentPreviewModal', () => ({
  DocumentPreviewModal: ({ isOpen, fileUrl, fileName }) =>
    isOpen
      ? React.createElement(
          'div',
          {
            'data-testid': 'mock-preview-modal',
            'data-url': fileUrl || '',
            'data-name': fileName || '',
          },
          'Preview Modal'
        )
      : null,
}));
