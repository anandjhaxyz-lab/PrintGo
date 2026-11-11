import React from 'react';
import { 
  DollarSign, 
  ShoppingBag, 
  CheckCircle2, 
  Printer, 
  AlertTriangle, 
  RotateCcw, 
  TrendingUp, 
  Layers, 
  CreditCard,
  Clock
} from 'lucide-react';
import { 
  ResponsiveContainer, 
  AreaChart, 
  Area, 
  BarChart, 
  Bar, 
  XAxis, 
  YAxis, 
  CartesianGrid, 
  Tooltip, 
  Legend, 
  PieChart, 
  Pie, 
  Cell 
} from 'recharts';

const COLORS = ['#6366f1', '#10b981', '#f59e0b', '#ec4899', '#8b5cf6'];

export const OverviewView = ({ stats, charts, isLoading }) => {
  if (isLoading || !stats) {
    return (
      <div style={{ padding: '3rem', textAlign: 'center', color: '#64748b' }}>
        <div className="animate-spin" style={{ display: 'inline-block', marginBottom: '1rem' }}>⌛</div>
        <p>Loading enterprise analytics & financial metrics...</p>
      </div>
    );
  }

  const { financials, orders, hardware } = stats;

  return (
    <div>
      {/* KPI Cards Grid */}
      <div className="admin-kpi-grid">
        {/* Net Collections */}
        <div className="admin-kpi-card" style={{ borderLeft: '4px solid #10b981' }}>
          <div className="admin-kpi-header">
            <span>Net Commercial Collections</span>
            <DollarSign size={18} color="#10b981" />
          </div>
          <div className="admin-kpi-value" style={{ color: '#059669' }}>
            ₹{financials.netCollections.toLocaleString('en-IN')}
          </div>
          <div className="admin-kpi-sub">
            <span>Gross: ₹{financials.grossCollections}</span>
            <span style={{ color: '#ef4444' }}>· Refunds: -₹{financials.totalRefunds}</span>
          </div>
        </div>

        {/* Total Orders */}
        <div className="admin-kpi-card" style={{ borderLeft: '4px solid #6366f1' }}>
          <div className="admin-kpi-header">
            <span>Total Print Orders</span>
            <ShoppingBag size={18} color="#6366f1" />
          </div>
          <div className="admin-kpi-value">
            {orders.total}
          </div>
          <div className="admin-kpi-sub">
            <span style={{ color: '#10b981', fontWeight: 600 }}>{orders.completed} completed</span>
            <span>· {orders.printing} printing</span>
          </div>
        </div>

        {/* Failed / Attention Jobs */}
        <div className="admin-kpi-card" style={{ borderLeft: '4px solid #f59e0b' }}>
          <div className="admin-kpi-header">
            <span>Jobs Needing Review</span>
            <AlertTriangle size={18} color="#f59e0b" />
          </div>
          <div className="admin-kpi-value" style={{ color: orders.failed > 0 ? '#d97706' : '#1e293b' }}>
            {orders.failed}
          </div>
          <div className="admin-kpi-sub">
            <span>Failed / Cancelled jobs</span>
          </div>
        </div>

        {/* Hardware Status */}
        <div className="admin-kpi-card" style={{ borderLeft: '4px solid #8b5cf6' }}>
          <div className="admin-kpi-header">
            <span>Printer Fleet Status</span>
            <Printer size={18} color="#8b5cf6" />
          </div>
          <div className="admin-kpi-value">
            {hardware.activePrinters} <span style={{ fontSize: '0.875rem', fontWeight: 400, color: '#64748b' }}>/ {hardware.totalMachines} online</span>
          </div>
          <div className="admin-kpi-sub">
            <span style={{ color: hardware.offlinePrinters > 0 ? '#ef4444' : '#10b981' }}>
              {hardware.offlinePrinters} offline / error
            </span>
          </div>
        </div>
      </div>

      {/* Secondary Metrics Bar */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
        gap: '0.75rem',
        marginBottom: '1.5rem',
        background: '#ffffff',
        padding: '1rem',
        borderRadius: '12px',
        border: '1px solid #e2e8f0'
      }}>
        <div>
          <span style={{ fontSize: '0.75rem', color: '#64748b' }}>Successful Payments</span>
          <div style={{ fontSize: '1.125rem', fontWeight: 600, color: '#0f172a' }}>{financials.successfulPayments}</div>
        </div>
        <div>
          <span style={{ fontSize: '0.75rem', color: '#64748b' }}>Average Order Value</span>
          <div style={{ fontSize: '1.125rem', fontWeight: 600, color: '#0f172a' }}>₹{financials.averageOrderValue}</div>
        </div>
        <div>
          <span style={{ fontSize: '0.75rem', color: '#64748b' }}>Simulated Demo Volume</span>
          <div style={{ fontSize: '1.125rem', fontWeight: 600, color: '#d97706' }}>
            ₹{financials.demoCollections} <span style={{ fontSize: '0.6875rem', fontWeight: 400 }}>(Isolated)</span>
          </div>
        </div>
        <div>
          <span style={{ fontSize: '0.75rem', color: '#64748b' }}>Pending / In-Flight</span>
          <div style={{ fontSize: '1.125rem', fontWeight: 600, color: '#64748b' }}>{financials.pendingPayments}</div>
        </div>
      </div>

      {/* Charts Section */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(450px, 1fr))', gap: '1.5rem', marginBottom: '1.5rem' }}>
        {/* Daily Sales Trend Chart */}
        <div style={{ background: '#ffffff', border: '1px solid #e2e8f0', borderRadius: '12px', padding: '1.25rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem' }}>
            <div>
              <h3 style={{ fontSize: '0.9375rem', fontWeight: 600, color: '#0f172a', margin: 0 }}>Daily Commercial Revenue</h3>
              <p style={{ fontSize: '0.75rem', color: '#64748b', margin: 0 }}>Authoritative INR collections over time</p>
            </div>
            <TrendingUp size={18} color="#6366f1" />
          </div>
          
          <div style={{ height: 260, width: '100%' }}>
            {charts?.dailyTrend && charts.dailyTrend.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={charts.dailyTrend}>
                  <defs>
                    <linearGradient id="colorRevenue" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#4f46e5" stopOpacity={0.3}/>
                      <stop offset="95%" stopColor="#4f46e5" stopOpacity={0}/>
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis dataKey="date" tick={{ fontSize: 11, fill: '#64748b' }} />
                  <YAxis tick={{ fontSize: 11, fill: '#64748b' }} tickFormatter={(v) => `₹${v}`} />
                  <Tooltip formatter={(value) => [`₹${value}`, 'Gross Revenue']} />
                  <Area type="monotone" dataKey="grossRevenue" stroke="#4f46e5" strokeWidth={2} fillOpacity={1} fill="url(#colorRevenue)" />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#94a3b8', fontSize: '0.875rem' }}>
                No sales data recorded for the selected period
              </div>
            )}
          </div>
        </div>

        {/* Print Modes Breakdown */}
        <div style={{ background: '#ffffff', border: '1px solid #e2e8f0', borderRadius: '12px', padding: '1.25rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem' }}>
            <div>
              <h3 style={{ fontSize: '0.9375rem', fontWeight: 600, color: '#0f172a', margin: 0 }}>Print Mode Utilization</h3>
              <p style={{ fontSize: '0.75rem', color: '#64748b', margin: 0 }}>B&W vs Colour and Single vs Duplex split</p>
            </div>
            <Layers size={18} color="#10b981" />
          </div>

          <div style={{ height: 260, width: '100%' }}>
            {charts?.printModes && charts.printModes.some(m => m.count > 0) ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={charts.printModes} layout="vertical">
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis type="number" tick={{ fontSize: 11, fill: '#64748b' }} />
                  <YAxis dataKey="name" type="category" tick={{ fontSize: 11, fill: '#334155' }} width={130} />
                  <Tooltip />
                  <Bar dataKey="count" fill="#6366f1" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#94a3b8', fontSize: '0.875rem' }}>
                No print jobs found in this date window
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Row 2: Payment Methods & Machine Revenue */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(400px, 1fr))', gap: '1.5rem' }}>
        {/* Payment Methods */}
        <div style={{ background: '#ffffff', border: '1px solid #e2e8f0', borderRadius: '12px', padding: '1.25rem' }}>
          <h3 style={{ fontSize: '0.9375rem', fontWeight: 600, color: '#0f172a', marginBottom: '0.5rem' }}>Payment Methods Distribution</h3>
          <div style={{ height: 220 }}>
            {charts?.paymentMethods && charts.paymentMethods.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={charts.paymentMethods}
                    cx="50%"
                    cy="50%"
                    innerRadius={50}
                    outerRadius={80}
                    paddingAngle={4}
                    dataKey="count"
                  >
                    {charts.paymentMethods.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip />
                  <Legend />
                </PieChart>
              </ResponsiveContainer>
            ) : (
              <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#94a3b8', fontSize: '0.875rem' }}>
                No payment transactions recorded
              </div>
            )}
          </div>
        </div>

        {/* Paper Size Distribution */}
        <div style={{ background: '#ffffff', border: '1px solid #e2e8f0', borderRadius: '12px', padding: '1.25rem' }}>
          <h3 style={{ fontSize: '0.9375rem', fontWeight: 600, color: '#0f172a', marginBottom: '0.5rem' }}>Paper Size Demand</h3>
          <div style={{ height: 220 }}>
            {charts?.paperSizes && charts.paperSizes.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={charts.paperSizes}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis dataKey="name" tick={{ fontSize: 11, fill: '#64748b' }} />
                  <YAxis tick={{ fontSize: 11, fill: '#64748b' }} />
                  <Tooltip />
                  <Bar dataKey="count" fill="#10b981" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#94a3b8', fontSize: '0.875rem' }}>
                No paper size telemetry recorded
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
