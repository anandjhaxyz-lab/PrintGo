import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { io } from 'socket.io-client';
import { AdminLogin } from '../components/admin/AdminLogin';
import { AdminSidebar } from '../components/admin/AdminSidebar';
import { AdminTopbar } from '../components/admin/AdminTopbar';

// Views
import { OverviewView } from '../components/admin/views/OverviewView';
import { JobsView } from '../components/admin/views/JobsView';
import { PrintersView } from '../components/admin/views/PrintersView';
import { CustomersView } from '../components/admin/views/CustomersView';
import { PaymentsView } from '../components/admin/views/PaymentsView';
import { RefundsView } from '../components/admin/views/RefundsView';
import { InvoicesView } from '../components/admin/views/InvoicesView';
import { PricingView } from '../components/admin/views/PricingView';
import { AdvertisementsView } from '../components/admin/views/AdvertisementsView';
import { ReconciliationView } from '../components/admin/views/ReconciliationView';
import { ShopOperatorsView } from '../components/admin/views/ShopOperatorsView';
import { ReportsView } from '../components/admin/views/ReportsView';
import { AuditLogsView } from '../components/admin/views/AuditLogsView';

const API_URL = import.meta.env.VITE_API_URL || '';

const AdminDashboard = () => {
  // Authentication & Session
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [currentUser, setCurrentUser] = useState(null);
  const [authError, setAuthError] = useState('');

  // Navigation & Filters
  const [currentTab, setCurrentTab] = useState('overview');
  const [period, setPeriod] = useState('30d');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);

  // Authoritative Data States
  const [overviewStats, setOverviewStats] = useState(null);
  const [chartsData, setChartsData] = useState(null);
  const [jobs, setJobs] = useState([]);
  const [machines, setMachines] = useState([]);
  const [payments, setPayments] = useState([]);
  const [refunds, setRefunds] = useState([]);
  const [invoices, setInvoices] = useState([]);
  const [creditNotes, setCreditNotes] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [operators, setOperators] = useState([]);
  const [pricingProfiles, setPricingProfiles] = useState([]);
  const [reconciliationRecords, setReconciliationRecords] = useState([]);
  const [auditLogs, setAuditLogs] = useState([]);
  const [companies, setCompanies] = useState([]);

  // Telemetry & Hardware Realtime
  const [printerStatus, setPrinterStatus] = useState({ isError: false, message: 'Online' });
  const [telemetryHistory, setTelemetryHistory] = useState([]);

  // Verify stored token on mount
  useEffect(() => {
    const token = localStorage.getItem('adminToken');
    if (token) {
      axios.defaults.headers.common['Authorization'] = `Bearer ${token}`;
      verifyToken();
    }
  }, []);

  const verifyToken = async () => {
    try {
      const res = await axios.get(`${API_URL}/api/auth/me`);
      if (res.data?.success && res.data.user) {
        setIsAuthenticated(true);
        setCurrentUser(res.data.user);
      } else {
        throw new Error('Invalid token');
      }
    } catch {
      setIsAuthenticated(false);
      setCurrentUser(null);
      localStorage.removeItem('adminToken');
    }
  };

  const handleLogin = async (email, password) => {
    setAuthError('');
    try {
      const response = await axios.post(`${API_URL}/api/auth/login`, { email, password });
      if (response.data.success) {
        const token = response.data.token;
        localStorage.setItem('adminToken', token);
        axios.defaults.headers.common['Authorization'] = `Bearer ${token}`;
        setIsAuthenticated(true);
        setCurrentUser(response.data.user);
      }
    } catch (err) {
      setAuthError(err.response?.data?.error || 'Authentication failed. Please check your credentials.');
    }
  };

  const handleLogout = () => {
    localStorage.removeItem('adminToken');
    delete axios.defaults.headers.common['Authorization'];
    setIsAuthenticated(false);
    setCurrentUser(null);
  };

  // Primary data loader
  const loadDashboardData = async () => {
    if (!isAuthenticated) return;
    setIsRefreshing(true);
    try {
      const [
        overviewRes,
        chartsRes,
        jobsRes,
        machinesRes,
        paymentsRes,
        refundsRes,
        invoicesRes,
        creditNotesRes,
        customersRes,
        pricingRes,
        reconciliationRes,
        operatorsRes,
        auditLogsRes
      ] = await Promise.allSettled([
        axios.get(`${API_URL}/api/admin/analytics/overview?period=${period}`),
        axios.get(`${API_URL}/api/admin/analytics/sales-charts?period=${period}`),
        axios.get(`${API_URL}/api/jobs`),
        currentUser?.role === 'SUPERADMIN'
          ? axios.get(`${API_URL}/api/admin/machines`)
          : axios.get(`${API_URL}/api/machines/my-machines`),
        axios.get(`${API_URL}/api/admin/payments`),
        axios.get(`${API_URL}/api/admin/refunds`),
        axios.get(`${API_URL}/api/admin/invoices`),
        axios.get(`${API_URL}/api/admin/credit-notes`),
        axios.get(`${API_URL}/api/admin/customers`),
        axios.get(`${API_URL}/api/admin/pricing`),
        axios.get(`${API_URL}/api/admin/reconciliation`),
        axios.get(`${API_URL}/api/admin/operators`),
        axios.get(`${API_URL}/api/admin/audit-logs`),
      ]);

      if (overviewRes.status === 'fulfilled' && overviewRes.value.data?.success) {
        setOverviewStats(overviewRes.value.data.data);
      }
      if (chartsRes.status === 'fulfilled' && chartsRes.value.data?.success) {
        setChartsData(chartsRes.value.data.data);
      }
      if (jobsRes.status === 'fulfilled' && jobsRes.value.data?.success) {
        setJobs(jobsRes.value.data.jobs || []);
      }
      if (machinesRes.status === 'fulfilled' && machinesRes.value.data?.data) {
        setMachines(machinesRes.value.data.data.machines || machinesRes.value.data.machines || []);
      }
      if (paymentsRes.status === 'fulfilled' && paymentsRes.value.data?.success) {
        setPayments(paymentsRes.value.data.payments || []);
      }
      if (refundsRes.status === 'fulfilled' && refundsRes.value.data?.success) {
        setRefunds(refundsRes.value.data.refunds || []);
      }
      if (invoicesRes.status === 'fulfilled' && invoicesRes.value.data?.success) {
        setInvoices(invoicesRes.value.data.invoices || []);
      }
      if (creditNotesRes.status === 'fulfilled' && creditNotesRes.value.data?.success) {
        setCreditNotes(creditNotesRes.value.data.creditNotes || []);
      }
      if (customersRes.status === 'fulfilled' && customersRes.value.data?.success) {
        setCustomers(customersRes.value.data.customers || []);
      }
      if (pricingRes.status === 'fulfilled' && pricingRes.value.data?.data) {
        setPricingProfiles(pricingRes.value.data.data.profiles || []);
      }
      if (reconciliationRes.status === 'fulfilled' && reconciliationRes.value.data?.success) {
        setReconciliationRecords(reconciliationRes.value.data.records || []);
      }
      if (operatorsRes.status === 'fulfilled' && operatorsRes.value.data?.success) {
        setOperators(operatorsRes.value.data.operators || []);
      }
      if (auditLogsRes.status === 'fulfilled' && auditLogsRes.value.data?.success) {
        setAuditLogs(auditLogsRes.value.data.logs || []);
      }

      // Fetch companies if Superadmin
      if (currentUser?.role === 'SUPERADMIN') {
        const compRes = await axios.get(`${API_URL}/api/admin/companies`).catch(() => null);
        if (compRes?.data?.data?.companies) setCompanies(compRes.data.data.companies);
      }
    } catch (err) {
      console.error('Failed to load dashboard data:', err);
    } finally {
      setIsRefreshing(false);
    }
  };

  // Re-fetch when authenticated or period changes
  useEffect(() => {
    if (isAuthenticated) {
      loadDashboardData();
    }
  }, [isAuthenticated, period]);

  // Socket.IO Realtime integration
  useEffect(() => {
    if (!isAuthenticated) return;
    const token = localStorage.getItem('adminToken');
    const socket = io(API_URL || undefined, {
      transports: ['websocket'],
      auth: { token }
    });

    let overviewRefreshTimer = null;

    const scheduleOverviewRefresh = () => {
      if (overviewRefreshTimer) {
        clearTimeout(overviewRefreshTimer);
      }
      overviewRefreshTimer = setTimeout(() => {
        axios.get(`${API_URL}/api/admin/analytics/overview?period=${period}`)
          .then(res => {
            if (res.data?.success && res.data?.data) {
              setOverviewStats(res.data.data);
            }
          })
          .catch(() => {});
      }, 400);
    };

    socket.on('job_status_changed', (updatedJob) => {
      setJobs(prev => {
        const exists = prev.find(j => j.id === updatedJob.id);
        if (exists) return prev.map(j => {
          if (j.id !== updatedJob.id) return j;
          const merged = { ...j, ...updatedJob };
          // Status-only Prisma updates may omit relations. Preserve the previously
          // loaded payment relation so a recorded Service Value is not shown as Unpaid.
          if (!Object.prototype.hasOwnProperty.call(updatedJob, 'payment')) {
            merged.payment = j.payment;
          }
          return merged;
        });
        return [updatedJob, ...prev];
      });
      // Refresh KPIs softly
      axios.get(`${API_URL}/api/admin/analytics/overview?period=${period}`)
        .then(res => res.data?.success && setOverviewStats(res.data.data))
        .catch(() => {});
    });

    socket.on('printer_status_update', (status) => {
      setPrinterStatus({ isError: status.isError, message: status.errorMessage || 'Online' });
      if (status.telemetry) {
        setTelemetryHistory(prev => {
          const now = new Date();
          const timeLabel = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
          const memVal = parseFloat(status.telemetry.memoryUsage) || 0;
          const newPoint = { ...status, time: timeLabel, memVal };
          const updated = [...prev, newPoint];
          return updated.slice(Math.max(0, updated.length - 30));
        });
      }
      if (status?.machineId) {
        setMachines(prev => prev.map(m => {
          if (m.id === status.machineId) {
            return {
              ...m,
              printerModel: status.printerModel || status.printerName || m.printerModel || 'Unknown',
              connectionType: status.connectionType || m.connectionType || 'Unknown',
              paymentMode: status.paymentMode || m.paymentMode || 'CASH_AT_COUNTER',
              isOnline: typeof status.isReady === 'boolean' ? status.isReady : !status.isError,
              hardwareStatus: status.status || m.hardwareStatus,
              statusMessage: status.statusMessage || m.statusMessage,
              lastOnline: new Date().toISOString(),
            };
          }
          return m;
        }));
        scheduleOverviewRefresh();
      }
    });

    return () => {
      if (overviewRefreshTimer) {
        clearTimeout(overviewRefreshTimer);
      }
      socket.disconnect();
    };
  }, [isAuthenticated, period]);

  // Actions
  const handleSavePricingProfile = async (profileData) => {
    const res = await axios.post(`${API_URL}/api/admin/pricing`, profileData);
    if (res.data?.status === 'success') {
      const updated = await axios.get(`${API_URL}/api/admin/pricing`);
      if (updated.data?.data?.profiles) setPricingProfiles(updated.data.data.profiles);
    }
    return res.data;
  };

  const handleInitiateRefund = async (refundPayload) => {
    const res = await axios.post(`${API_URL}/api/admin/refunds`, refundPayload);
    if (res.data?.success) {
      loadDashboardData();
    }
    return res.data;
  };

  const handleRunReconciliation = async (options) => {
    const res = await axios.post(`${API_URL}/api/admin/reconciliation/run`, options);
    if (res.data?.success) {
      const updated = await axios.get(`${API_URL}/api/admin/reconciliation`);
      if (updated.data?.success) setReconciliationRecords(updated.data.records);
    }
    return res.data;
  };

  const handleResolveDiscrepancy = async (recordId, resolutionNotes) => {
    const res = await axios.post(`${API_URL}/api/admin/reconciliation/${recordId}/resolve`, { resolutionNotes });
    if (res.data?.success) {
      setReconciliationRecords(prev => prev.map(r => r.id === recordId ? { ...r, resolved: true, resolutionNotes } : r));
    }
    return res.data;
  };

  if (!isAuthenticated) {
    return <AdminLogin onLogin={handleLogin} authError={authError} />;
  }

  const isSuperadmin = currentUser?.role === 'SUPERADMIN';

  // Tab Header Details
  const getTabHeader = () => {
    switch (currentTab) {
      case 'overview': return { title: 'Executive Overview', subtitle: 'Live business performance, real collections, and hardware status' };
      case 'jobs': return { title: 'Print Jobs Ledger', subtitle: 'Filter, inspect, and trace physical print jobs across all shops' };
      case 'printers': return { title: 'Printers & Hardware Fleet', subtitle: 'Real-time telemetry, paper/toner supplies, and connection status' };
      case 'customers': return { title: 'Customer Directory', subtitle: 'Customer contact records, printing history, and engagement' };
      case 'payments': return { title: 'Payments Ledger', subtitle: 'Gateway transactions, verified collections, and simulated test receipts' };
      case 'refunds': return { title: 'Refunds & Recovery', subtitle: 'Customer refund tracking and statutory credit note issuance' };
      case 'invoices': return { title: 'Invoices & Statutory Credit Notes', subtitle: 'GST tax invoices, credit adjustment records, and downloadable PDFs' };
      case 'pricing': return { title: 'Dynamic Pricing Profiles', subtitle: 'Admin-controlled print rates, paper surcharges, and live price simulator' };
      case 'advertisements': return { title: 'Advertisement Display Management', subtitle: 'Upload promotional photos & videos, configure duration, and reorder kiosk slides' };
      case 'reconciliation': return { title: 'Financial Reconciliation Engine', subtitle: 'Automated ledger anomaly detection, gateway checks, and dispute resolution' };
      case 'shop': return { title: 'Shop & Operators Management', subtitle: 'Company profiles, kiosk assignments, and operator access controls' };
      case 'reports': return { title: 'Data Export Center', subtitle: 'Download authoritative CSV records for accounting and tax audits' };
      case 'audit': return { title: 'System & Security Audit Logs', subtitle: 'Append-only activity ledger and security events trail' };
      default: return { title: 'Admin Dashboard', subtitle: '' };
    }
  };

  const header = getTabHeader();

  return (
    <div className="admin-wrapper">
      {/* Dark Navy Sidebar */}
      <AdminSidebar
        currentTab={currentTab}
        onSelectTab={setCurrentTab}
        user={currentUser}
        onLogout={handleLogout}
        isOpen={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
      />

      {/* Main Workspace Canvas */}
      <div className="admin-content-area">
        <AdminTopbar
          title={header.title}
          subtitle={header.subtitle}
          period={period}
          onPeriodChange={currentTab === 'overview' || currentTab === 'reports' ? setPeriod : null}
          onRefresh={loadDashboardData}
          isRefreshing={isRefreshing}
          onToggleSidebar={() => setSidebarOpen(!sidebarOpen)}
          isLive={!printerStatus.isError}
        />

        <main className="admin-main-body">
          {currentTab === 'overview' && (
            <OverviewView stats={overviewStats} charts={chartsData} isLoading={isRefreshing && !overviewStats} />
          )}

          {currentTab === 'jobs' && (
            <JobsView jobs={jobs} machines={machines} onRefresh={loadDashboardData} />
          )}

          {currentTab === 'printers' && (
            <PrintersView
              machines={machines}
              telemetryHistory={telemetryHistory}
              printerStatus={printerStatus}
              currentUser={currentUser}
              onRefresh={loadDashboardData}
            />
          )}

          {currentTab === 'customers' && (
            <CustomersView customers={customers} />
          )}

          {currentTab === 'payments' && (
            <PaymentsView payments={payments} onRefresh={loadDashboardData} />
          )}

          {currentTab === 'refunds' && (
            <RefundsView refunds={refunds} onInitiateRefund={handleInitiateRefund} isSuperadmin={isSuperadmin} />
          )}

          {currentTab === 'invoices' && (
            <InvoicesView invoices={invoices} creditNotes={creditNotes} onRefresh={loadDashboardData} />
          )}

          {currentTab === 'pricing' && (
            <PricingView pricingProfiles={pricingProfiles} onSaveProfile={handleSavePricingProfile} isSuperadmin={isSuperadmin} />
          )}

          {currentTab === 'advertisements' && (
            <AdvertisementsView isSuperadmin={isSuperadmin} />
          )}

          {currentTab === 'reconciliation' && (
            <ReconciliationView
              records={reconciliationRecords}
              onRunReconciliation={handleRunReconciliation}
              onResolveDiscrepancy={handleResolveDiscrepancy}
              isSuperadmin={isSuperadmin}
            />
          )}

          {currentTab === 'shop' && (
            <ShopOperatorsView companies={companies} machines={machines} operators={operators} isSuperadmin={isSuperadmin} />
          )}

          {currentTab === 'reports' && (
            <ReportsView period={period} />
          )}

          {currentTab === 'audit' && (
            <AuditLogsView logs={auditLogs} />
          )}
        </main>
      </div>
    </div>
  );
};

export default AdminDashboard;
