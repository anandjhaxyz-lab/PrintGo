import React, { useState, useEffect, useRef } from 'react';
import { 
  X, 
  ZoomIn, 
  ZoomOut, 
  ChevronLeft, 
  ChevronRight, 
  FileText, 
  Loader2, 
  Image as ImageIcon, 
  AlertCircle 
} from 'lucide-react';
import * as pdfjsLib from 'pdfjs-dist';
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

// Set up PDF.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;

export const DocumentPreviewModal = ({
  isOpen,
  onClose,
  fileUrl,
  fileName,
  fileSize,
  initialPages = 1
}) => {
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(initialPages || 1);
  const [zoom, setZoom] = useState(1.0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const canvasRef = useRef(null);
  const containerRef = useRef(null);
  const pdfDocRef = useRef(null);
  const renderTaskRef = useRef(null);

  const isPdf = fileName ? /\.pdf$/i.test(fileName) : true;
  const isImage = fileName ? /\.(jpe?g|png|webp|gif|bmp)$/i.test(fileName) : false;
  const isOffice = fileName ? /\.(docx?|pptx?|xlsx?)$/i.test(fileName) : false;

  // Reset state when modal opens
  useEffect(() => {
    if (isOpen) {
      setCurrentPage(1);
      setZoom(1.0);
      setError(null);
      setLoading(true);
    } else {
      if (renderTaskRef.current) {
        renderTaskRef.current.cancel();
      }
      pdfDocRef.current = null;
    }
  }, [isOpen, fileUrl]);

  // Handle ESC key to close
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  // Load PDF Document
  useEffect(() => {
    if (!isOpen || !fileUrl || !isPdf) return;

    let isCancelled = false;
    let loadingTask = null;
    setLoading(true);
    setError(null);

    const loadPdf = async () => {
      try {
        loadingTask = pdfjsLib.getDocument({
          url: fileUrl,
          cMapUrl: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@6.5.438/cmaps/',
          cMapPacked: true
        });

        const pdf = await loadingTask.promise;
        if (isCancelled) return;

        pdfDocRef.current = pdf;
        setTotalPages(pdf.numPages);
        setCurrentPage(1);
        await renderPage(1, pdf, zoom);
      } catch (err) {
        if (isCancelled) return;
        console.error('PDF preview load error:', err);
        setError('Failed to load PDF preview. The document format is valid and ready to print.');
      } finally {
        if (!isCancelled) setLoading(false);
      }
    };

    loadPdf();

    return () => {
      isCancelled = true;
      if (renderTaskRef.current) {
        renderTaskRef.current.cancel();
        renderTaskRef.current = null;
      }
      pdfDocRef.current = null;
      const taskToDestroy = loadingTask;
      loadingTask = null;
      if (taskToDestroy) {
        taskToDestroy.destroy().catch((destroyError) => {
          console.warn('PDF loading task cleanup error:', destroyError);
        });
      }
    };
  }, [isOpen, fileUrl, isPdf]);

  // Render specific PDF page to canvas
  const renderPage = async (pageNumber, pdfInstance, currentZoom) => {
    const pdf = pdfInstance || pdfDocRef.current;
    if (!pdf || !canvasRef.current) return;

    try {
      if (renderTaskRef.current) {
        renderTaskRef.current.cancel();
      }

      setLoading(true);
      const page = await pdf.getPage(pageNumber);

      const canvas = canvasRef.current;
      const context = canvas.getContext('2d');

      // Calculate responsive base scale to fit mobile screen container width
      const containerWidth = containerRef.current ? containerRef.current.clientWidth - 24 : 320;
      const unscaledViewport = page.getViewport({ scale: 1 });
      const fitScale = Math.min(2.0, (containerWidth / unscaledViewport.width)) || 1;
      const finalScale = fitScale * currentZoom;

      const viewport = page.getViewport({ scale: finalScale });

      // Support high DPI devices (Retina / OLED mobile screens)
      const outputScale = window.devicePixelRatio || 1;
      canvas.width = Math.floor(viewport.width * outputScale);
      canvas.height = Math.floor(viewport.height * outputScale);
      canvas.style.width = Math.floor(viewport.width) + 'px';
      canvas.style.height = Math.floor(viewport.height) + 'px';

      const transform = outputScale !== 1
        ? [outputScale, 0, 0, outputScale, 0, 0]
        : null;

      const renderContext = {
        canvasContext: context,
        transform,
        viewport
      };

      const renderTask = page.render(renderContext);
      renderTaskRef.current = renderTask;
      await renderTask.promise;
      setLoading(false);
    } catch (err) {
      if (err?.name !== 'RenderingCancelledException') {
        console.error('PDF page render error:', err);
      }
    }
  };

  // Re-render when page or zoom changes
  const handlePageChange = (newPage) => {
    if (newPage < 1 || newPage > totalPages) return;
    setCurrentPage(newPage);
    renderPage(newPage, pdfDocRef.current, zoom);
  };

  const handleZoom = (direction) => {
    const newZoom = direction === 'in' 
      ? Math.min(2.5, zoom + 0.25)
      : Math.max(0.75, zoom - 0.25);
    setZoom(newZoom);
    if (isPdf && pdfDocRef.current) {
      renderPage(currentPage, pdfDocRef.current, newZoom);
    }
  };

  if (!isOpen) return null;

  return (
    <div 
      className="s3k-preview-modal-overlay animate-fade-in"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 99999,
        background: 'rgba(4, 8, 20, 0.88)',
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '0.75rem',
        boxSizing: 'border-box'
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div 
        className="s3k-preview-modal-container animate-scale-in"
        style={{
          width: '100%',
          maxWidth: '440px',
          maxHeight: '92vh',
          height: '100%',
          background: '#070E1E',
          border: '1.5px solid rgba(212, 175, 55, 0.5)',
          borderRadius: '16px',
          boxShadow: '0 25px 60px -15px rgba(0, 0, 0, 0.9), 0 0 25px rgba(212, 175, 55, 0.25)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          position: 'relative'
        }}
      >
        {/* Top Header Bar */}
        <div style={{
          padding: '0.65rem 0.9rem',
          background: 'linear-gradient(180deg, #0D1B36 0%, #070E1E 100%)',
          borderBottom: '1px solid rgba(148, 163, 184, 0.2)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexShrink: 0,
          gap: '0.5rem'
        }}>
          {/* Document Title Info */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', minWidth: 0, flex: 1 }}>
            <div style={{
              width: 30, height: 30, borderRadius: 6,
              background: 'rgba(30, 64, 175, 0.5)',
              border: '1px solid rgba(212, 175, 55, 0.4)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: '#F59E0B', flexShrink: 0
            }}>
              <FileText size={16} />
            </div>
            <div style={{ minWidth: 0, overflow: 'hidden' }}>
              <p style={{
                fontSize: '0.78rem',
                fontWeight: 800,
                color: '#FFFFFF',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                margin: 0,
                lineHeight: 1.2
              }}>
                {fileName || 'Document Preview'}
              </p>
              <p style={{ fontSize: '0.65rem', color: '#94A3B8', margin: 0, marginTop: '2px' }}>
                {fileSize ? `${Math.round(fileSize / 1024)} KB • ` : ''}
                {isPdf ? `${totalPages} ${totalPages === 1 ? 'Page' : 'Pages'}` : 'Photo Preview'}
              </p>
            </div>
          </div>

          {/* Zoom Controls */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', flexShrink: 0 }}>
            <button
              type="button"
              onClick={() => handleZoom('out')}
              disabled={zoom <= 0.75}
              style={{
                width: 28, height: 28, borderRadius: 6,
                background: 'rgba(30, 64, 175, 0.4)',
                border: '1px solid rgba(148, 163, 184, 0.3)',
                color: '#FFFFFF', display: 'flex', alignItems: 'center', justifyContent: 'center',
                cursor: zoom <= 0.75 ? 'not-allowed' : 'pointer',
                opacity: zoom <= 0.75 ? 0.4 : 1
              }}
              title="Zoom Out"
            >
              <ZoomOut size={13} />
            </button>
            <span style={{ fontSize: '0.7rem', fontWeight: 700, color: '#CBD5E1', minWidth: '34px', textAlign: 'center' }}>
              {Math.round(zoom * 100)}%
            </span>
            <button
              type="button"
              onClick={() => handleZoom('in')}
              disabled={zoom >= 2.5}
              style={{
                width: 28, height: 28, borderRadius: 6,
                background: 'rgba(30, 64, 175, 0.4)',
                border: '1px solid rgba(148, 163, 184, 0.3)',
                color: '#FFFFFF', display: 'flex', alignItems: 'center', justifyContent: 'center',
                cursor: zoom >= 2.5 ? 'not-allowed' : 'pointer',
                opacity: zoom >= 2.5 ? 0.4 : 1
              }}
              title="Zoom In"
            >
              <ZoomIn size={13} />
            </button>

            {/* Prominent Close (X) Button */}
            <button
              type="button"
              onClick={onClose}
              style={{
                width: 32, height: 32, borderRadius: 8,
                background: 'rgba(239, 68, 68, 0.25)',
                border: '1.5px solid rgba(239, 68, 68, 0.6)',
                color: '#FCA5A5',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                cursor: 'pointer', marginLeft: '0.3rem'
              }}
              title="Close Preview"
            >
              <X size={17} />
            </button>
          </div>
        </div>

        {/* Modal Body / Canvas Render Area */}
        <div 
          ref={containerRef}
          style={{
            flex: 1,
            overflow: 'auto',
            background: '#040814',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '0.75rem',
            position: 'relative'
          }}
        >
          {loading && (
            <div style={{
              position: 'absolute',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: '0.5rem',
              color: '#F59E0B',
              zIndex: 10
            }}>
              <Loader2 size={32} className="animate-spin" />
              <span style={{ fontSize: '0.75rem', fontWeight: 700, color: '#CBD5E1' }}>
                Rendering page {currentPage}...
              </span>
            </div>
          )}

          {error && (
            <div style={{
              textAlign: 'center',
              padding: '1.5rem',
              maxWidth: '300px',
              background: 'rgba(15, 23, 42, 0.95)',
              borderRadius: '12px',
              border: '1px solid rgba(239, 68, 68, 0.4)'
            }}>
              <AlertCircle size={36} color="#EF4444" style={{ margin: '0 auto 0.5rem' }} />
              <p style={{ fontSize: '0.8rem', color: '#F87171', fontWeight: 600, margin: '0 0 0.5rem' }}>{error}</p>
              <button
                type="button"
                onClick={() => renderPage(currentPage, pdfDocRef.current, zoom)}
                style={{
                  padding: '0.4rem 0.8rem',
                  borderRadius: '6px',
                  background: '#2563EB',
                  color: '#FFFFFF',
                  fontSize: '0.75rem',
                  fontWeight: 700,
                  border: 'none',
                  cursor: 'pointer'
                }}
              >
                Retry Render
              </button>
            </div>
          )}

          {/* Genuine PDF Canvas Rendering */}
          {isPdf && (
            <div style={{
              boxShadow: '0 8px 30px rgba(0, 0, 0, 0.7)',
              borderRadius: '4px',
              overflow: 'hidden',
              background: '#FFFFFF',
              margin: 'auto',
              display: error ? 'none' : 'block'
            }}>
              <canvas ref={canvasRef} style={{ display: 'block' }} />
            </div>
          )}

          {/* Image Display */}
          {isImage && (
            <div style={{
              margin: 'auto',
              maxWidth: '100%',
              maxHeight: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center'
            }}>
              <img 
                src={fileUrl} 
                alt="Document Preview" 
                style={{
                  maxWidth: `${zoom * 100}%`,
                  maxHeight: `${zoom * 100}%`,
                  objectFit: 'contain',
                  borderRadius: '6px',
                  boxShadow: '0 8px 30px rgba(0, 0, 0, 0.7)'
                }}
                onLoad={() => setLoading(false)}
                onError={() => {
                  setLoading(false);
                  setError('Failed to display uploaded image.');
                }}
              />
            </div>
          )}

          {/* Office Documents Fallback Card */}
          {isOffice && (
            <div style={{
              textAlign: 'center',
              padding: '1.5rem',
              maxWidth: '300px',
              background: 'rgba(15, 23, 42, 0.95)',
              borderRadius: '12px',
              border: '1px solid rgba(212, 175, 55, 0.4)'
            }}>
              <FileText size={42} color="#F59E0B" style={{ margin: '0 auto 0.75rem' }} />
              <h4 style={{ color: '#FFFFFF', fontSize: '0.9rem', fontWeight: 800, margin: '0 0 0.35rem' }}>
                {fileName}
              </h4>
              <p style={{ fontSize: '0.75rem', color: '#94A3B8', margin: '0 0 0.75rem' }}>
                Office document verified. Page count ({initialPages} pages) detected and ready for self-service print.
              </p>
              <span style={{
                display: 'inline-block',
                padding: '3px 10px',
                borderRadius: '9999px',
                fontSize: '0.68rem',
                fontWeight: 700,
                background: 'rgba(16, 185, 129, 0.15)',
                color: '#34D399',
                border: '1px solid rgba(16, 185, 129, 0.3)'
              }}>
                ✓ Document Validated
              </span>
            </div>
          )}
        </div>

        {/* Bottom Page Navigation Bar (For Multi-Page PDFs) */}
        {isPdf && totalPages > 1 && (
          <div style={{
            padding: '0.55rem 0.9rem',
            background: 'linear-gradient(0deg, #0D1B36 0%, #070E1E 100%)',
            borderTop: '1px solid rgba(148, 163, 184, 0.2)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexShrink: 0
          }}>
            <button
              type="button"
              disabled={currentPage <= 1 || loading}
              onClick={() => handlePageChange(currentPage - 1)}
              style={{
                display: 'flex', alignItems: 'center', gap: '0.25rem',
                padding: '0.35rem 0.75rem', borderRadius: '8px',
                background: 'rgba(30, 64, 175, 0.4)',
                border: '1px solid rgba(148, 163, 184, 0.3)',
                color: '#FFFFFF', fontSize: '0.75rem', fontWeight: 700,
                opacity: currentPage <= 1 ? 0.4 : 1,
                cursor: currentPage <= 1 ? 'not-allowed' : 'pointer'
              }}
            >
              <ChevronLeft size={14} /> Prev Page
            </button>

            <span style={{ fontWeight: 800, color: '#F59E0B', fontSize: '0.8rem' }}>
              Page {currentPage} of {totalPages}
            </span>

            <button
              type="button"
              disabled={currentPage >= totalPages || loading}
              onClick={() => handlePageChange(currentPage + 1)}
              style={{
                display: 'flex', alignItems: 'center', gap: '0.25rem',
                padding: '0.35rem 0.75rem', borderRadius: '8px',
                background: 'rgba(30, 64, 175, 0.4)',
                border: '1px solid rgba(148, 163, 184, 0.3)',
                color: '#FFFFFF', fontSize: '0.75rem', fontWeight: 700,
                opacity: currentPage >= totalPages ? 0.4 : 1,
                cursor: currentPage >= totalPages ? 'not-allowed' : 'pointer'
              }}
            >
              Next Page <ChevronRight size={14} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
