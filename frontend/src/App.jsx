import React, { Suspense } from 'react';
import { BrowserRouter as Router, Routes, Route, Link, useLocation } from 'react-router-dom';
import { Printer, Loader } from 'lucide-react';

const KioskView = React.lazy(() => import('./pages/KioskView'));
const MobileView = React.lazy(() => import('./pages/MobileView'));
const AdminDashboard = React.lazy(() => import('./pages/AdminDashboard'));
const ActivateAccount = React.lazy(() => import('./pages/ActivateAccount'));
const ContactUs = React.lazy(() => import('./pages/ContactUs'));
const Terms = React.lazy(() => import('./pages/Terms'));
const Refunds = React.lazy(() => import('./pages/Refunds'));

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  componentDidCatch(error, info) {
    console.error('ErrorBoundary:', error, info);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: '3rem', textAlign: 'center', marginTop: '15vh' }}>
          <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>⚠️</div>
          <h2 style={{ marginBottom: '0.5rem', fontSize: '1.5rem' }}>Something went wrong</h2>
          <p style={{ color: 'var(--text-muted)', marginBottom: '1.5rem' }}>
            The application encountered an unexpected error.
          </p>
          <button className="btn btn-primary" onClick={() => window.location.reload()}>
            Reload Page
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

const LoadingFallback = () => (
  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '50vh', gap: '1rem' }}>
    <Loader size={32} className="animate-spin" style={{ color: 'var(--primary-color)' }} />
    <p className="text-muted text-sm">Loading...</p>
  </div>
);

const isAdminOnlyMode = import.meta.env.VITE_APP_MODE === 'admin';

const AppLayout = ({ children }) => {
  const location = useLocation();
  const isAdmin = isAdminOnlyMode || location.pathname.startsWith('/admin') || location.pathname.startsWith('/login') || location.pathname.startsWith('/activate');
  const isMobile = location.pathname.startsWith('/m/') || location.pathname.startsWith('/p/');

  // In Admin Mode or for Admin Workspace, give dedicated full-screen layout without Kiosk header/footer
  if (isAdmin) {
    return (
      <main className="admin-full-layout">
        {children}
      </main>
    );
  }

  // S3K Mobile Customer Portal dedicated mobile-first full-screen viewport layout
  if (isMobile) {
    return (
      <div className="s3k-portal-root">
        {children}
      </div>
    );
  }

  return (
    <div className="container" style={isMobile ? { padding: 0, maxWidth: '100%' } : {}}>
      <header className="app-header" style={isMobile ? { padding: '0.75rem 1rem' } : {}}>
        <Link 
          to={isMobile ? "#" : "/kiosk"} 
          className="logo" 
          style={{ textDecoration: 'none', pointerEvents: isMobile ? 'none' : 'auto' }}
        >
          <div style={{
            background: 'linear-gradient(135deg, #1D4ED8 0%, #0F172A 100%)',
            border: '1.5px solid #D4AF37',
            borderRadius: 'var(--radius-md)',
            padding: '5px 8px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: '0 0 8px rgba(212, 175, 55, 0.3)'
          }}>
            <span style={{ color: '#D4AF37', fontWeight: 900, fontSize: '0.85rem', letterSpacing: '0.04em' }}>S3K</span>
          </div>
          <span style={{ color: 'var(--text-main)', fontWeight: 800 }}>
            Print <span style={{ color: '#D4AF37' }}>Yourself</span>
          </span>
          {isMobile && (
            <span style={{ 
              fontSize: '0.65rem', 
              background: 'var(--primary-50)', 
              color: 'var(--primary-600)', 
              padding: '2px 8px', 
              borderRadius: 'var(--radius-full)',
              fontWeight: 600,
              letterSpacing: '0.02em'
            }}>
              MOBILE
            </span>
          )}
        </Link>
        {!isAdmin && !isMobile && (
          <Link
            to="/admin"
            className="btn"
            style={{ fontSize: '0.8125rem', padding: '0.5rem 1rem' }}
          >
            Admin
          </Link>
        )}
      </header>

      <main className="main-content" style={isMobile ? { padding: 0 } : {}}>
        {children}
      </main>

      <footer style={{
        textAlign: 'center',
        padding: '1rem 0',
        marginTop: 'auto',
        display: 'flex',
        justifyContent: 'center',
        flexWrap: 'wrap',
        gap: '0.25rem',
        borderTop: '1px solid var(--gray-100)'
      }}>
        <Link to="/contact">Contact Us</Link>
        <Link to="/terms">Terms & Conditions</Link>
        <Link to="/refunds">Refunds & Cancellations</Link>
      </footer>
    </div>
  );
};

const App = () => {
  return (
    <Router>
      <AppLayout>
        <ErrorBoundary>
          <Suspense fallback={<LoadingFallback />}>
            {isAdminOnlyMode ? (
              <Routes>
                <Route path="/" element={<AdminDashboard />} />
                <Route path="/admin" element={<AdminDashboard />} />
                <Route path="/login" element={<AdminDashboard />} />
                <Route path="/activate" element={<ActivateAccount />} />
                <Route path="*" element={<AdminDashboard />} />
              </Routes>
            ) : (
              <Routes>
                <Route path="/" element={<KioskView />} />
                <Route path="/kiosk" element={<KioskView />} />
                <Route path="/m/:sessionId" element={<MobileView />} />
                <Route path="/m" element={<MobileView />} />
                <Route path="/p/:publicCode" element={<MobileView />} />
                <Route path="/admin" element={<AdminDashboard />} />
                <Route path="/login" element={<AdminDashboard />} />
                <Route path="/activate" element={<ActivateAccount />} />
                <Route path="/contact" element={<ContactUs />} />
                <Route path="/terms" element={<Terms />} />
                <Route path="/refunds" element={<Refunds />} />
              </Routes>
            )}
          </Suspense>
        </ErrorBoundary>
      </AppLayout>
    </Router>
  );
};

export default App;
