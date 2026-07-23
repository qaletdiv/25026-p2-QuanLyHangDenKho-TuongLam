'use client';

// SMS season KPI report — PO-grained full order book. SMS has no production
// schedule (that's a mainline concept); its time anchor is HOD (the handover-by
// date). Sections: funnel (ordered → shipped → received), HOD-timeliness and
// fulfillment donuts, supplier / channel pivots, CSV export. Mirrors the mainline
// report's copy-as-table affordance for the weekly slide deck.

import { useMemo, useRef, useState } from 'react';
import { Boxes, Download, Filter, ChevronDown } from 'lucide-react';
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from 'recharts';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import type { SmsReportRow } from '@/modules/sms/types';
import { getSmsPoLines } from '@/modules/sms/actions';
import { downloadCsv } from '@/lib/downloadCsv';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { facilityLabel, seasonRank } from '@/modules/sms/components/smsStatus';
import CopyButton, { copyTable } from '../mainline/CopyButton';
import CopyImageButton from '../CopyImageButton';
import ReportsTabs from '../ReportsTabs';

// Item-lines export columns (all SKU order lines across every SMS PO).
const ITEM_COLS = [
  { key: 'po_number', label: 'PO Number' }, { key: 'trn_number', label: 'TRN' },
  { key: 'supplier', label: 'Supplier' }, { key: 'season', label: 'Season' },
  { key: 'facility', label: 'Destination' }, { key: 'allocation_channel', label: 'Channel' },
  { key: 'hod', label: 'HOD' }, { key: 'expected_received_date', label: 'Expected Receive' },
  { key: 'sku_code', label: 'SKU' }, { key: 'item_name', label: 'Item' }, { key: 'size', label: 'Size' },
  { key: 'ordered_qty', label: 'Ordered Qty' }, { key: 'unit_price', label: 'Unit Price' },
];

// deterministic thousands (avoids SSR/CSR locale mismatch — see hydration notes)
const fmt = (n: number) => n.toLocaleString('en-US');
const pct = (num: number, den: number) => (den > 0 ? Math.round((num / den) * 100) : 0);
const csv = (v: unknown) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

/* ── fulfillment KPI cascade (mutually exclusive; reconciles to PO total) ──── */
const KPI_ORDER = ['Overdue', 'Not Shipped', 'Partially Shipped', 'Fully Shipped', 'Received'];
const KPI_TEXT: Record<string, string> = {
  'Received':          'text-blue-600',
  'Fully Shipped':     'text-emerald-600',
  'Partially Shipped': 'text-amber-600',
  'Not Shipped':       'text-slate-500',
  'Overdue':           'text-red-600',
};
const KPI_COLORS: Record<string, string> = {
  'Received': '#3B82F6', 'Fully Shipped': '#10B981', 'Partially Shipped': '#F59E0B',
  'Not Shipped': '#64748B', 'Overdue': '#EF4444',
};

/* ── HOD timeliness ───────────────────────────────────────────────────────── */
const TL_ORDER = ['Overdue', 'Late', 'On Track', 'On Time', 'Unknown'];
const TL_TEXT: Record<string, string> = {
  'On Time':  'text-green-600',
  'On Track': 'text-blue-600',
  'Late':     'text-red-600',
  'Overdue':  'text-orange-600',
  'Unknown':  'text-muted-foreground',
};
const TL_COLORS: Record<string, string> = {
  'On Time': '#22C55E', 'On Track': '#3B82F6', 'Late': '#EF4444', 'Overdue': '#F97316', 'Unknown': '#9CA3AF',
};

const TOOLTIP_STYLE = {
  borderRadius: '12px',
  border: '1px solid var(--color-border)',
  backgroundColor: 'var(--color-card)',
  color: 'var(--color-foreground)',
  boxShadow: '0 8px 32px rgba(0,0,0,0.15)',
};

/* ── donut: units by a categorical field ──────────────────────────────────── */
function Donut({ title, subtitle, rows, bucketOf, order, colors }: {
  title: string; subtitle: string; rows: SmsReportRow[];
  bucketOf: (r: SmsReportRow) => string; order: string[]; colors: Record<string, string>;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const data = useMemo(() => {
    const agg: Record<string, number> = {};
    rows.forEach((r) => { agg[bucketOf(r)] = (agg[bucketOf(r)] || 0) + r.ordered_qty; });
    const cols = [...order.filter((b) => agg[b]), ...Object.keys(agg).filter((b) => !order.includes(b)).sort()];
    return cols.map((b) => ({ name: b, value: agg[b] }));
  }, [rows, bucketOf, order]);
  const total = data.reduce((a, d) => a + d.value, 0);
  const copy = () => copyTable(
    [title, 'Units', '%'],
    [...data.map((d) => [d.name, fmt(d.value), `${pct(d.value, total)}%`]), ['Total', fmt(total), '100%']],
  );
  return (
    <div ref={cardRef} className="rounded-2xl shadow-2xl overflow-hidden bg-card border border-border">
      <div className="px-6 pt-5 pb-2 flex items-start justify-between gap-4">
        <div>
          <p className="text-base font-black text-foreground">{title}</p>
          <p className="text-xs mt-0.5 text-muted-foreground">{subtitle}</p>
        </div>
        <div className="flex items-center gap-2">
          <CopyImageButton target={cardRef} name={title} />
          <CopyButton onCopy={copy} />
        </div>
      </div>
      <div className="px-4 pb-4">
        <div className="h-[200px] w-full relative">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie data={data} innerRadius={55} outerRadius={80} paddingAngle={3} dataKey="value" stroke="none">
                {data.map((d) => <Cell key={d.name} fill={colors[d.name] || '#9CA3AF'} />)}
              </Pie>
              <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v: any, name: any) => [`${fmt(v)} units`, name]} />
            </PieChart>
          </ResponsiveContainer>
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="text-center">
              <p className="text-xs font-bold text-muted-foreground">UNITS</p>
              <p className="text-base font-black text-foreground">{fmt(total)}</p>
            </div>
          </div>
        </div>
        <div className="mt-2 grid grid-cols-2 gap-x-6">
          {data.map((d) => (
            <div key={d.name} className="flex items-center justify-between gap-2 py-1.5 border-b border-border/50">
              <div className="flex items-center gap-2 min-w-0">
                <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: colors[d.name] || '#9CA3AF' }} />
                <span className="text-xs font-medium text-muted-foreground truncate">{d.name}</span>
              </div>
              <span className="text-xs font-black text-foreground whitespace-nowrap">{fmt(d.value)} · {pct(d.value, total)}%</span>
            </div>
          ))}
          {data.length === 0 && <p className="col-span-2 py-4 text-center text-xs text-muted-foreground">No units</p>}
        </div>
      </div>
    </div>
  );
}

/* ── pivot: rows (a category) × buckets, summing units ────────────────────── */
function PivotTable({ title, subtitle, rowHeader, rows, rowOf, buckets, bucketOf, bucketText }: {
  title: string; subtitle: string; rowHeader: string; rows: SmsReportRow[];
  rowOf: (r: SmsReportRow) => string; buckets: string[];
  bucketOf: (r: SmsReportRow) => string; bucketText: Record<string, string>;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const { body, totals, grand } = useMemo(() => {
    const map: Record<string, Record<string, number>> = {};
    rows.forEach((r) => {
      const k = rowOf(r) || 'Unknown';
      (map[k] = map[k] || {})[bucketOf(r)] = (map[k]?.[bucketOf(r)] || 0) + r.ordered_qty;
    });
    const keys = Object.keys(map).sort();
    const b = keys.map((k) => {
      const cells = buckets.map((bk) => map[k][bk] || 0);
      return { label: k, cells, total: cells.reduce((a, c) => a + c, 0) };
    });
    const t = buckets.map((_, i) => b.reduce((a, r) => a + r.cells[i], 0));
    return { body: b, totals: t, grand: t.reduce((a, c) => a + c, 0) };
  }, [rows, rowOf, buckets, bucketOf]);

  const copy = () => copyTable(
    [rowHeader, ...buckets, 'Grand Total'],
    [
      ...body.map((r) => [r.label, ...r.cells.map((c) => (c ? fmt(c) : '—')), fmt(r.total)]),
      ['Grand Total', ...totals.map((t) => (t ? fmt(t) : '—')), fmt(grand)],
    ],
  );
  return (
    <div ref={cardRef} className="rounded-2xl shadow-2xl overflow-hidden bg-card border border-border">
      <div className="px-6 pt-5 pb-3 flex items-start justify-between gap-4">
        <div>
          <p className="text-base font-black text-foreground">{title}</p>
          <p className="text-xs mt-0.5 text-muted-foreground">{subtitle}</p>
        </div>
        <div className="flex items-center gap-2">
          <CopyImageButton target={cardRef} name={title} />
          <CopyButton onCopy={copy} />
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm bg-card">
          <thead>
            <tr className="bg-card/80 border-y border-border">
              <th className="text-left px-4 py-2 font-bold text-[11px] uppercase tracking-widest text-muted-foreground">{rowHeader}</th>
              {buckets.map((b) => (
                <th key={b} className={cn('text-right px-4 py-2 font-bold text-[11px] uppercase tracking-widest', bucketText[b] || 'text-muted-foreground')}>{b}</th>
              ))}
              <th className="text-right px-4 py-2 font-bold text-[11px] uppercase tracking-widest text-foreground">Grand Total</th>
            </tr>
          </thead>
          <tbody>
            {body.length === 0 && (
              <tr><td colSpan={buckets.length + 2} className="px-4 py-6 text-center text-muted-foreground">No data</td></tr>
            )}
            {body.map((r) => (
              <tr key={r.label} className="border-b border-border hover:bg-muted/30">
                <td className="px-4 py-2 font-medium text-foreground">{r.label}</td>
                {r.cells.map((c, i) => (
                  <td key={buckets[i]} className="px-4 py-2 text-right tabular-nums text-foreground">{c ? fmt(c) : '—'}</td>
                ))}
                <td className="px-4 py-2 text-right tabular-nums font-bold text-foreground">{fmt(r.total)}</td>
              </tr>
            ))}
          </tbody>
          {body.length > 0 && (
            <tfoot>
              <tr className="bg-card/80 border-t-2 border-border">
                <td className="px-4 py-2 font-bold text-foreground">Grand Total</td>
                {totals.map((t, i) => (
                  <td key={buckets[i]} className="px-4 py-2 text-right tabular-nums font-bold text-foreground">{t ? fmt(t) : '—'}</td>
                ))}
                <td className="px-4 py-2 text-right tabular-nums font-black text-foreground">{fmt(grand)}</td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}

/* ── funnel stat card ─────────────────────────────────────────────────────── */
function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-2xl bg-card border border-border px-5 py-4">
      <p className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground">{label}</p>
      <p className="text-2xl font-black text-foreground mt-1 tabular-nums">{value}</p>
      {sub && <p className="text-xs text-muted-foreground mt-0.5">{sub}</p>}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════ */
export default function SmsReportsClient({ rows }: { rows: SmsReportRow[] }) {
  const seasons = useMemo(
    () => [...new Set(rows.map((r) => r.season).filter(Boolean) as string[])].sort((a, b) => seasonRank(b) - seasonRank(a)),
    [rows],
  );
  const [season, setSeason] = useState<string>('');
  const activeSeason = season || seasons[0] || '';
  const filtered = useMemo(() => rows.filter((r) => !activeSeason || r.season === activeSeason), [rows, activeSeason]);

  const sum = (f: (r: SmsReportRow) => number) => filtered.reduce((a, r) => a + f(r), 0);
  const ordered = sum((r) => r.ordered_qty);
  const shipped = sum((r) => r.shipped_qty);
  const received = sum((r) => r.received_qty);
  const remaining = sum((r) => r.remaining_qty);

  const kpiBuckets = useMemo(() => {
    const present = new Set<string>(filtered.map((r) => r.kpi_status));
    return KPI_ORDER.filter((b) => present.has(b));
  }, [filtered]);
  const tlBuckets = useMemo(() => {
    const present = new Set<string>(filtered.map((r) => r.hod_timeliness));
    return TL_ORDER.filter((b) => present.has(b));
  }, [filtered]);

  function exportCsv() {
    const headers = ['PO', 'TRN', 'Supplier', 'Season', 'Destination', 'Channel', 'HOD', 'Ship Method',
      'Ordered', 'Shipped', 'Received', 'Remaining', 'Lots', 'First Ship', 'Fulfillment', 'HOD Timeliness', 'KPI Status'];
    const lines = [headers.join(',')];
    filtered.forEach((r) => lines.push([
      r.po_number, r.trn_number, r.supplier, r.season, facilityLabel(r.facility), r.channel, r.hod, r.ship_method,
      r.ordered_qty, r.shipped_qty, r.received_qty, r.remaining_qty, r.lot_count, r.earliest_ship_date,
      r.fulfillment, r.hod_timeliness, r.kpi_status,
    ].map(csv).join(',')));
    const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `sms-report-${activeSeason || 'all'}.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  const [dlOpen, setDlOpen] = useState(false);
  const [dlBusy, setDlBusy] = useState(false);
  async function exportItemLines() {
    setDlBusy(true);
    try {
      const rows = await getSmsPoLines();
      if (!rows.length) { toast.info('No item lines to download.'); return; }
      const mapped = rows.map((r) => ({ ...r, facility: facilityLabel(r.facility as string) }));
      downloadCsv('sms-po-item-lines.csv', ITEM_COLS, mapped);
    } catch { toast.error('Download failed'); } finally { setDlBusy(false); }
  }

  return (
    <div className="flex h-full min-h-screen bg-background">
      <div className="flex-1 overflow-y-auto p-4 md:p-6 space-y-6">

        <ReportsTabs />

        {/* ── Header ── */}
        <div className="flex flex-col gap-4 md:flex-row md:items-center rounded-2xl px-4 py-4 sm:px-6 sm:py-5 bg-primary border border-primary/50">
          <div className="p-3 rounded-xl bg-primary-foreground/15 self-start"><Boxes className="w-6 h-6 text-primary-foreground" /></div>
          <div>
            <h1 className="text-xl sm:text-2xl font-black text-primary-foreground tracking-tight">SMS Delivery KPI</h1>
            <p className="text-sm mt-0.5 text-primary-foreground/70">
              Courier shipments — the full SMS order book, one row per PO. Timeliness is graded against HOD
              (the handover-by date): shipped on/before HOD is On Time; unshipped POs are On Track until HOD, then Overdue.
            </p>
          </div>
          <div className="md:ml-auto flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2">
              <Filter className="w-4 h-4 text-primary-foreground/80" />
              <select
                value={activeSeason}
                onChange={(e) => setSeason(e.target.value)}
                className="rounded-lg px-3 py-2 text-xs font-semibold outline-none cursor-pointer bg-primary-foreground/15 text-primary-foreground border border-primary-foreground/30"
              >
                {seasons.length === 0 && <option value="">No data</option>}
                {seasons.map((s) => <option key={s} value={s} className="text-foreground">{s}</option>)}
              </select>
            </div>
            <Popover open={dlOpen} onOpenChange={setDlOpen}>
              <PopoverTrigger asChild>
                <button className="flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold uppercase tracking-widest transition-all hover:scale-105 bg-primary-foreground/20 text-primary-foreground border border-primary-foreground/30">
                  <Download className="w-4 h-4" /> {dlBusy ? 'Preparing…' : 'Download'} <ChevronDown className="w-3.5 h-3.5" />
                </button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-72 p-1">
                <button onClick={() => { setDlOpen(false); exportCsv(); }} className="w-full text-left px-3 py-2 text-sm rounded-md hover:bg-muted transition-colors">
                  Report rows — PO × Shipment <span className="text-muted-foreground">({filtered.length})</span>
                </button>
                <button onClick={() => { setDlOpen(false); exportItemLines(); }} className="w-full text-left px-3 py-2 text-sm rounded-md hover:bg-muted transition-colors">
                  PO item lines (SKUs)
                </button>
              </PopoverContent>
            </Popover>
          </div>
        </div>

        {/* ── Funnel ── */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
          <Stat label="Purchase Orders" value={fmt(filtered.length)} sub={`${activeSeason || 'all seasons'}`} />
          <Stat label="Ordered" value={fmt(ordered)} sub="units" />
          <Stat label="Shipped" value={fmt(shipped)} sub={`${pct(shipped, ordered)}% of ordered`} />
          <Stat label="Received" value={fmt(received)} sub={`${pct(received, ordered)}% of ordered`} />
          <Stat label="Remaining" value={fmt(remaining)} sub="to ship" />
        </div>

        {/* ── Donuts ── */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Donut title="HOD Timeliness" subtitle="Units by handover status vs HOD"
                 rows={filtered} bucketOf={(r) => r.hod_timeliness} order={TL_ORDER} colors={TL_COLORS} />
          <Donut title="Fulfillment" subtitle="Units by fulfillment stage"
                 rows={filtered} bucketOf={(r) => r.kpi_status} order={KPI_ORDER} colors={KPI_COLORS} />
        </div>

        {/* ── Pivots ── */}
        <PivotTable
          title="By Supplier" subtitle="Ordered units by fulfillment stage" rowHeader="Supplier"
          rows={filtered} rowOf={(r) => r.supplier || 'Unknown'}
          buckets={kpiBuckets} bucketOf={(r) => r.kpi_status} bucketText={KPI_TEXT}
        />
        <PivotTable
          title="By Channel" subtitle="Ordered units by HOD timeliness — where the risk is" rowHeader="Channel"
          rows={filtered} rowOf={(r) => r.channel || 'Unassigned'}
          buckets={tlBuckets} bucketOf={(r) => r.hod_timeliness} bucketText={TL_TEXT}
        />
      </div>
    </div>
  );
}
