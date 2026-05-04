'use client';

import { useEffect, useState, useMemo, useCallback } from 'react';
import {
  BarChart3, DollarSign,
  Package, CheckCircle2, Download, Filter, Truck,
  ClipboardList, BookOpen, X, FileSpreadsheet,
} from 'lucide-react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer, PieChart, Pie, Cell,
} from 'recharts';

/* ── palette ─────────────────────────────────────────────────────── */
const RED = '#ef4444';
const ROSE = '#f87171';
const CRIMSON = '#dc2626';
const DARK_RED = '#991b1b';
const SOFT_RED = '#fca5a5';
const PIE_COLORS = [RED, ROSE, CRIMSON, DARK_RED, SOFT_RED, '#b91c1c', '#fee2e2'];

/* ── types ───────────────────────────────────────────────────────── */
interface ReportRow {
  id: string;
  po_number: string;
  season: string;
  type: string;
  mode: string;
  courier: string;
  booking_number: string;
  supplier: string;
  expected_units: number;
  received_units: number;
  discrepancy: number;
  invoice_value: number;
  duty: number;
  freight: number;
  total_cost: number;
  status: string;
  etd: string;
  eta: string;
  lot_number: number | null;
}

/* ── helpers ─────────────────────────────────────────────────────── */
function unique(arr: string[]) {
  return [...new Set(arr.filter(Boolean))].sort();
}

function exportCsv(rows: ReportRow[], filename: string) {
  const headers = [
    'PO #', 'Season', 'Type', 'Mode', 'Carrier', 'Booking #', 'Supplier',
    'Expected', 'Received', 'Discrepancy', 'Invoice', 'Duty', 'Freight',
    'Total Cost', 'Status', 'ETD', 'ETA', 'Lot',
  ];
  const csvRows = [headers.join(',')];
  rows.forEach(r => {
    csvRows.push([
      r.po_number, r.season, r.type, r.mode, r.courier, r.booking_number,
      `"${(r.supplier || '').replace(/"/g, '""')}"`,
      r.expected_units, r.received_units, r.discrepancy,
      r.invoice_value.toFixed(2), r.duty.toFixed(2), r.freight.toFixed(2),
      r.total_cost.toFixed(2), r.status, r.etd, r.eta, r.lot_number ?? '',
    ].join(','));
  });
  const blob = new Blob([csvRows.join('\n')], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/* ── filter chip ─────────────────────────────────────────────────── */
function FilterSelect({
  label, value, options, onChange,
}: {
  label: string; value: string; options: string[]; onChange: (v: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] font-bold uppercase tracking-widest" style={{ color: '#9ca3af' }}>{label}</span>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        className="rounded-lg px-3 py-2 text-xs font-semibold text-white outline-none cursor-pointer"
        style={{
          background: 'rgba(255,255,255,0.06)',
          border: '1px solid rgba(239,68,68,0.3)',
        }}
      >
        <option value="">All</option>
        {options.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
    </div>
  );
}

/* ── KPI card ────────────────────────────────────────────────────── */
function KpiCard({
  title, value, sub, icon: Icon, accent = false, color,
}: {
  title: string; value: string; sub: string; icon: any; accent?: boolean; color?: string;
}) {
  const bg = accent
    ? 'linear-gradient(135deg, #ef4444 0%, #dc2626 50%, #b91c1c 100%)'
    : 'linear-gradient(135deg, #1f2937 0%, #111827 100%)';
  const border = accent ? '1px solid #f87171' : `1px solid ${color || 'rgba(239,68,68,0.3)'}`;
  const iconBg = accent ? 'rgba(255,255,255,0.15)' : `${color || 'rgba(239,68,68,0.2)'}25`;
  const iconColor = accent ? '#ffffff' : (color || '#ef4444');
  const titleColor = accent ? 'rgba(255,255,255,0.75)' : '#9ca3af';
  const subColor = accent ? 'rgba(255,255,255,0.7)' : (color || '#fca5a5');

  return (
    <div className="rounded-2xl p-5 shadow-2xl" style={{ background: bg, border }}>
      <div className="flex justify-between items-start">
        <div className="space-y-1">
          <p className="text-[10px] font-bold uppercase tracking-widest" style={{ color: titleColor }}>{title}</p>
          <p className="text-2xl font-black text-white">{value}</p>
          <p className="text-[11px] font-medium mt-1 flex items-center gap-1" style={{ color: subColor }}>
            {sub}
          </p>
        </div>
        <div className="p-2.5 rounded-xl" style={{ background: iconBg }}>
          <Icon className="w-5 h-5" style={{ color: iconColor }} />
        </div>
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════
   MAIN PAGE
   ════════════════════════════════════════════════════════════════════ */
export default function ReportsPage() {
  const [reports, setReports] = useState<ReportRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // filters
  const [fSeason, setFSeason] = useState('');
  const [fType, setFType] = useState('');
  const [fMode, setFMode] = useState('');
  const [fCarrier, setFCarrier] = useState('');
  const [fStatus, setFStatus] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('http://127.0.0.1:5000/reports');
        const data = await res.json();
        setReports(data || []);
      } catch (e) {
        console.error(e);
      } finally {
        setIsLoading(false);
      }
    })();
  }, []);

  /* ── filter options derived from data ─────────────────────────── */
  const seasons = useMemo(() => unique(reports.map(r => r.season)), [reports]);
  const types = useMemo(() => unique(reports.map(r => r.type)), [reports]);
  const modes = useMemo(() => unique(reports.map(r => r.mode)), [reports]);
  const carriers = useMemo(() => unique(reports.map(r => r.courier)), [reports]);
  const statuses = useMemo(() => unique(reports.map(r => r.status)), [reports]);

  const hasActiveFilter = fSeason || fType || fMode || fCarrier || fStatus;

  const clearFilters = useCallback(() => {
    setFSeason(''); setFType(''); setFMode(''); setFCarrier(''); setFStatus('');
  }, []);

  /* ── filtered data ────────────────────────────────────────────── */
  const filtered = useMemo(() => {
    return reports.filter(r =>
      (!fSeason || r.season === fSeason) &&
      (!fType || r.type === fType) &&
      (!fMode || r.mode === fMode) &&
      (!fCarrier || r.courier === fCarrier) &&
      (!fStatus || r.status === fStatus)
    );
  }, [reports, fSeason, fType, fMode, fCarrier, fStatus]);

  /* ── KPIs ─────────────────────────────────────────────────────── */
  const stats = useMemo(() => {
    const uniquePOs = new Set(filtered.map(r => r.po_number));
    const uniqueBookings = new Set(filtered.map(r => r.booking_number).filter(Boolean));
    let totalExpected = 0, totalReceived = 0, totalCost = 0, discrepancyCount = 0;

    filtered.forEach(r => {
      totalExpected += r.expected_units;
      totalReceived += r.received_units;
      totalCost += r.total_cost;
      if (r.discrepancy !== 0) discrepancyCount++;
    });

    const accuracy = totalExpected > 0
      ? ((totalExpected - Math.abs(totalExpected - totalReceived)) / totalExpected) * 100
      : 100;

    return {
      totalPOs: uniquePOs.size,
      totalBookings: uniqueBookings.size,
      totalShipments: filtered.length,
      totalExpected,
      totalReceived,
      totalCost,
      discrepancyCount,
      accuracy: Math.max(0, Math.min(100, accuracy)),
    };
  }, [filtered]);

  /* ── chart: shipments by season ───────────────────────────────── */
  const seasonChartData = useMemo(() => {
    const map: Record<string, { season: string; shipments: number; units: number; value: number }> = {};
    filtered.forEach(r => {
      const s = r.season || 'Unknown';
      if (!map[s]) map[s] = { season: s, shipments: 0, units: 0, value: 0 };
      map[s].shipments++;
      map[s].units += r.expected_units;
      map[s].value += r.total_cost;
    });
    return Object.values(map).sort((a, b) => a.season.localeCompare(b.season));
  }, [filtered]);

  /* ── chart: shipments by mode ─────────────────────────────────── */
  const modeChartData = useMemo(() => {
    const map: Record<string, number> = {};
    filtered.forEach(r => {
      const m = r.mode || 'Unknown';
      map[m] = (map[m] || 0) + 1;
    });
    return Object.entries(map).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
  }, [filtered]);

  /* ── chart: shipments by status ───────────────────────────────── */
  const statusChartData = useMemo(() => {
    const map: Record<string, number> = {};
    filtered.forEach(r => {
      const st = r.status || 'Unknown';
      map[st] = (map[st] || 0) + 1;
    });
    return Object.entries(map).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
  }, [filtered]);

  /* ── chart: value by supplier (pie) ───────────────────────────── */
  const supplierPieData = useMemo(() => {
    const map: Record<string, number> = {};
    filtered.forEach(r => {
      const sup = r.supplier || 'Unknown';
      map[sup] = (map[sup] || 0) + (r.total_cost || 0);
    });
    return Object.entries(map)
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 5);
  }, [filtered]);

  /* ════════════════════════════════════════════════════════════════
     RENDER
     ════════════════════════════════════════════════════════════════ */
  return (
    <div className="flex h-full min-h-screen" style={{ background: 'linear-gradient(135deg, #1a0000 0%, #2d0505 40%, #1a0000 100%)' }}>
      <div className="flex-1 overflow-y-auto p-6 space-y-6">

        {/* ── Header ─────────────────────────────────────────────── */}
        <div className="animate-in fade-in slide-in-from-bottom-4 duration-300">
          <div
            className="flex items-center gap-4 rounded-2xl px-6 py-5"
            style={{ background: 'linear-gradient(135deg, #7f1d1d 0%, #991b1b 50%, #7f1d1d 100%)', border: '1px solid #ef4444' }}
          >
            <div className="p-3 rounded-xl" style={{ background: 'rgba(239,68,68,0.3)' }}>
              <BarChart3 className="w-6 h-6" style={{ color: '#fca5a5' }} />
            </div>
            <div>
              <h1 className="text-2xl font-black text-white tracking-tight">Supply Chain Reports</h1>
              <p className="text-sm mt-0.5" style={{ color: '#fca5a5' }}>
                Detailed analytics by season, type, carrier, and transport mode.
              </p>
            </div>
            <div className="ml-auto flex items-center gap-3">
              <button
                onClick={() => exportCsv(filtered, `tentree-report-filtered-${new Date().toISOString().slice(0, 10)}.csv`)}
                className="flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold uppercase tracking-widest transition-all hover:scale-105"
                style={{
                  background: 'rgba(239,68,68,0.25)',
                  color: '#fca5a5',
                  border: '1px solid rgba(239,68,68,0.4)',
                }}
              >
                <Download className="w-4 h-4" />
                Export Filtered ({filtered.length})
              </button>
              <button
                onClick={() => exportCsv(reports, `tentree-report-all-${new Date().toISOString().slice(0, 10)}.csv`)}
                className="flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold uppercase tracking-widest transition-all hover:scale-105"
                style={{
                  background: 'rgba(255,255,255,0.06)',
                  color: '#d1d5db',
                  border: '1px solid rgba(255,255,255,0.15)',
                }}
              >
                <FileSpreadsheet className="w-4 h-4" />
                Export All ({reports.length})
              </button>
            </div>
          </div>
        </div>

        {/* ── Filter Bar ─────────────────────────────────────────── */}
        <div
          className="rounded-2xl px-6 py-4 animate-in fade-in slide-in-from-bottom-5 duration-400"
          style={{ background: 'linear-gradient(135deg, #1f2937 0%, #111827 100%)', border: '1px solid rgba(239,68,68,0.2)' }}
        >
          <div className="flex items-end gap-4 flex-wrap">
            <div className="flex items-center gap-2 mr-2 self-end pb-2">
              <Filter className="w-4 h-4" style={{ color: '#fca5a5' }} />
              <span className="text-xs font-bold uppercase tracking-widest" style={{ color: '#fca5a5' }}>Filters</span>
            </div>
            <FilterSelect label="Season" value={fSeason} options={seasons} onChange={setFSeason} />
            <FilterSelect label="Type" value={fType} options={types} onChange={setFType} />
            <FilterSelect label="Mode" value={fMode} options={modes} onChange={setFMode} />
            <FilterSelect label="Carrier" value={fCarrier} options={carriers} onChange={setFCarrier} />
            <FilterSelect label="Status" value={fStatus} options={statuses} onChange={setFStatus} />
            {hasActiveFilter && (
              <button
                onClick={clearFilters}
                className="flex items-center gap-1 self-end mb-1 px-3 py-1.5 rounded-lg text-xs font-bold transition-all hover:scale-105"
                style={{ background: 'rgba(239,68,68,0.2)', color: '#fca5a5', border: '1px solid rgba(239,68,68,0.3)' }}
              >
                <X className="w-3 h-3" /> Clear
              </button>
            )}
          </div>
        </div>

        {/* ── KPI Cards ──────────────────────────────────────────── */}
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4 animate-in fade-in slide-in-from-bottom-6 duration-500">
          <KpiCard title="Total POs" value={stats.totalPOs.toString()} sub="unique purchase orders" icon={ClipboardList} color="#f87171" />
          <KpiCard title="Total Bookings" value={stats.totalBookings.toString()} sub="unique bookings" icon={BookOpen} color="#fb923c" />
          <KpiCard title="Total Shipments" value={stats.totalShipments.toString()} sub="shipment lines" icon={Package} color="#a78bfa" />
          <KpiCard title="Total Units" value={stats.totalExpected.toLocaleString()} sub={`${stats.totalReceived.toLocaleString()} received`} icon={Truck} color="#34d399" />
          <KpiCard title="Total Value" value={`$${stats.totalCost.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`} sub="landed cost" icon={DollarSign} color="#34d399" />
          <KpiCard title="Accuracy" value={`${stats.accuracy.toFixed(1)}%`} sub={`${stats.discrepancyCount} with issues`} icon={CheckCircle2} accent />
        </div>

        {/* ── Charts Row ─────────────────────────────────────────── */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 animate-in fade-in slide-in-from-bottom-8 duration-700">

          {/* Bar: Season breakdown */}
          <div className="col-span-2 rounded-2xl shadow-2xl overflow-hidden" style={{ background: 'linear-gradient(135deg, #1f2937 0%, #111827 100%)', border: '1px solid rgba(239,68,68,0.25)' }}>
            <div className="px-6 pt-5 pb-2">
              <p className="text-base font-black text-white">Shipments & Units by Season</p>
              <p className="text-xs mt-0.5" style={{ color: '#9ca3af' }}>Volume and unit count per season</p>
            </div>
            <div className="px-4 pb-5">
              <div className="h-[300px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={seasonChartData} margin={{ top: 20, right: 20, left: 0, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="rgba(255,255,255,0.08)" />
                    <XAxis dataKey="season" axisLine={false} tickLine={false} tick={{ fontSize: 11, fill: '#9ca3af', fontWeight: 600 }} />
                    <YAxis yAxisId="left" axisLine={false} tickLine={false} tick={{ fontSize: 11, fill: '#9ca3af' }} />
                    <YAxis yAxisId="right" orientation="right" axisLine={false} tickLine={false} tick={{ fontSize: 11, fill: '#9ca3af' }} />
                    <Tooltip
                      cursor={{ fill: 'rgba(239,68,68,0.08)' }}
                      contentStyle={{ borderRadius: '12px', border: '1px solid rgba(239,68,68,0.4)', backgroundColor: '#1f2937', color: '#fff', boxShadow: '0 8px 32px rgba(0,0,0,0.6)' }}
                      labelStyle={{ color: '#fca5a5', fontWeight: 700 }}
                    />
                    <Legend iconType="circle" wrapperStyle={{ fontSize: '12px', fontWeight: 700, color: '#d1d5db' }} />
                    <Bar yAxisId="left" dataKey="shipments" name="Shipments" fill="rgba(239,68,68,0.35)" radius={[4, 4, 0, 0]} barSize={28} />
                    <Bar yAxisId="right" dataKey="units" name="Units" fill="#ef4444" radius={[4, 4, 0, 0]} barSize={28} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>

          {/* Pie: Value by Supplier */}
          <div className="rounded-2xl shadow-2xl overflow-hidden" style={{ background: 'linear-gradient(135deg, #1f2937 0%, #111827 100%)', border: '1px solid rgba(239,68,68,0.25)' }}>
            <div className="px-6 pt-5 pb-2">
              <p className="text-base font-black text-white">Spend by Supplier</p>
              <p className="text-xs mt-0.5" style={{ color: '#9ca3af' }}>Top 5 vendors by landed cost</p>
            </div>
            <div className="px-4 pb-4">
              <div className="h-[220px] w-full relative">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={supplierPieData} innerRadius={60} outerRadius={85} paddingAngle={4} dataKey="value" stroke="none">
                      {supplierPieData.map((_, index) => (
                        <Cell key={`cell-${index}`} fill={PIE_COLORS[index % PIE_COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip
                      contentStyle={{ borderRadius: '10px', border: '1px solid rgba(239,68,68,0.4)', backgroundColor: '#1f2937', color: '#fff', boxShadow: '0 8px 32px rgba(0,0,0,0.6)' }}
                      formatter={(value: number) => [`$${value.toLocaleString()}`, 'Spend']}
                    />
                  </PieChart>
                </ResponsiveContainer>
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                  <div className="text-center">
                    <p className="text-xs font-bold" style={{ color: '#9ca3af' }}>TOTAL</p>
                    <p className="text-base font-black text-white">
                      ${(supplierPieData.reduce((s, d) => s + d.value, 0) / 1000).toFixed(0)}K
                    </p>
                  </div>
                </div>
              </div>
              <div className="mt-2 flex flex-col gap-1">
                {supplierPieData.map((entry, index) => (
                  <div key={entry.name} className="flex items-center justify-between gap-2 py-1.5" style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                    <div className="flex items-center gap-2">
                      <div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: PIE_COLORS[index % PIE_COLORS.length] }} />
                      <span className="text-xs font-medium truncate max-w-[120px]" style={{ color: '#d1d5db' }}>{entry.name}</span>
                    </div>
                    <span className="text-xs font-black text-white">${(entry.value / 1000).toFixed(1)}K</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* ── Charts Row 2: Mode + Status ────────────────────────── */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 animate-in fade-in slide-in-from-bottom-9 duration-800">

          {/* Shipments by Mode */}
          <div className="rounded-2xl shadow-2xl overflow-hidden" style={{ background: 'linear-gradient(135deg, #1f2937 0%, #111827 100%)', border: '1px solid rgba(239,68,68,0.25)' }}>
            <div className="px-6 pt-5 pb-2">
              <p className="text-base font-black text-white">Shipments by Transport Mode</p>
              <p className="text-xs mt-0.5" style={{ color: '#9ca3af' }}>Ocean vs Air vs Courier</p>
            </div>
            <div className="px-4 pb-5">
              <div className="h-[250px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={modeChartData} layout="vertical" margin={{ top: 10, right: 20, left: 60, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="rgba(255,255,255,0.08)" />
                    <XAxis type="number" axisLine={false} tickLine={false} tick={{ fontSize: 11, fill: '#9ca3af' }} />
                    <YAxis type="category" dataKey="name" axisLine={false} tickLine={false} tick={{ fontSize: 12, fill: '#d1d5db', fontWeight: 600 }} />
                    <Tooltip
                      cursor={{ fill: 'rgba(239,68,68,0.08)' }}
                      contentStyle={{ borderRadius: '12px', border: '1px solid rgba(239,68,68,0.4)', backgroundColor: '#1f2937', color: '#fff' }}
                    />
                    <Bar dataKey="value" name="Shipments" fill="#ef4444" radius={[0, 4, 4, 0]} barSize={20} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>

          {/* Shipments by Status */}
          <div className="rounded-2xl shadow-2xl overflow-hidden" style={{ background: 'linear-gradient(135deg, #1f2937 0%, #111827 100%)', border: '1px solid rgba(239,68,68,0.25)' }}>
            <div className="px-6 pt-5 pb-2">
              <p className="text-base font-black text-white">Shipments by Status</p>
              <p className="text-xs mt-0.5" style={{ color: '#9ca3af' }}>Pipeline visibility</p>
            </div>
            <div className="px-4 pb-5">
              <div className="h-[250px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={statusChartData} layout="vertical" margin={{ top: 10, right: 20, left: 100, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="rgba(255,255,255,0.08)" />
                    <XAxis type="number" axisLine={false} tickLine={false} tick={{ fontSize: 11, fill: '#9ca3af' }} />
                    <YAxis type="category" dataKey="name" axisLine={false} tickLine={false} tick={{ fontSize: 12, fill: '#d1d5db', fontWeight: 600 }} width={95} />
                    <Tooltip
                      cursor={{ fill: 'rgba(239,68,68,0.08)' }}
                      contentStyle={{ borderRadius: '12px', border: '1px solid rgba(239,68,68,0.4)', backgroundColor: '#1f2937', color: '#fff' }}
                    />
                    <Bar dataKey="value" name="Shipments" fill={ROSE} radius={[0, 4, 4, 0]} barSize={20} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>
        </div>

      </div>
    </div>
  );
}
