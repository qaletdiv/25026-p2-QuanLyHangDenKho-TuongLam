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

/* ── fulfillment at UNIT grain (mutually exclusive; reconciles to ordered) ────
 * Where the units ARE, not which stage their PO is in. The backend's `unitSplit`
 * guarantees the four fields sum to ordered_qty per PO, so every cell, row total
 * and grand total reconciles.
 *
 * This replaced pivoting on `kpi_status`, which is a PO-level state: summing
 * ordered_qty by status filed a PO's WHOLE quantity under one label, so Shanghai
 * Pucci FW27 read "Partially Shipped 230" when 929 of its 937 units had arrived and
 * only 8 were outstanding. `kpi_status` is still on every row and in the CSV — it
 * answers "which POs need attention", which is a different question from "where are
 * the units". */
const UNIT_ORDER = ['Overdue', 'To Ship', 'In Transit', 'Received'];
const UNIT_FIELD: Record<string, 'units_overdue' | 'units_to_ship' | 'units_in_transit' | 'units_received'> = {
  'Overdue':    'units_overdue',      // not shipped and HOD has passed
  'To Ship':    'units_to_ship',      // not shipped, still inside HOD
  'In Transit': 'units_in_transit',   // shipped, no Item Receipt yet
  'Received':   'units_received',     // booked in by NetSuite
};
const UNIT_TEXT: Record<string, string> = {
  'Received':   'text-blue-600',
  'In Transit': 'text-emerald-600',
  'To Ship':    'text-slate-500',
  'Overdue':    'text-red-600',
};
const UNIT_COLORS: Record<string, string> = {
  'Received': '#3B82F6', 'In Transit': '#10B981', 'To Ship': '#64748B', 'Overdue': '#EF4444',
};
// one row → its unit buckets. Zeros are dropped so empty buckets never render.
const unitsOf = (r: SmsReportRow): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const b of UNIT_ORDER) {
    const v = r[UNIT_FIELD[b]] ?? 0;
    if (v) out[b] = v;
  }
  return out;
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
// `splitOf` returns the buckets ONE row contributes to, with its units in each.
// A PO-level axis (HOD) returns a single bucket carrying the whole ordered qty;
// the unit-grain axis returns up to four. Same aggregation either way.
function Donut({ title, subtitle, rows, splitOf, order, colors }: {
  title: string; subtitle: string; rows: SmsReportRow[];
  splitOf: (r: SmsReportRow) => Record<string, number>; order: string[]; colors: Record<string, string>;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const data = useMemo(() => {
    const agg: Record<string, number> = {};
    rows.forEach((r) => {
      const s = splitOf(r);
      for (const b in s) if (s[b]) agg[b] = (agg[b] || 0) + s[b];
    });
    const cols = [...order.filter((b) => agg[b]), ...Object.keys(agg).filter((b) => !order.includes(b)).sort()];
    return cols.map((b) => ({ name: b, value: agg[b] }));
  }, [rows, splitOf, order]);
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
function PivotTable({ title, subtitle, rowHeader, rows, rowOf, buckets, splitOf, bucketText }: {
  title: string; subtitle: string; rowHeader: string; rows: SmsReportRow[];
  rowOf: (r: SmsReportRow) => string; buckets: string[];
  splitOf: (r: SmsReportRow) => Record<string, number>; bucketText: Record<string, string>;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const { body, totals, grand } = useMemo(() => {
    const map: Record<string, Record<string, number>> = {};
    rows.forEach((r) => {
      const k = rowOf(r) || 'Unknown';
      const m = (map[k] = map[k] || {});
      const s = splitOf(r);
      for (const b in s) m[b] = (m[b] || 0) + s[b];
    });
    const keys = Object.keys(map).sort();
    const b = keys.map((k) => {
      const cells = buckets.map((bk) => map[k][bk] || 0);
      return { label: k, cells, total: cells.reduce((a, c) => a + c, 0) };
    });
    const t = buckets.map((_, i) => b.reduce((a, r) => a + r.cells[i], 0));
    return { body: b, totals: t, grand: t.reduce((a, c) => a + c, 0) };
  }, [rows, rowOf, buckets, splitOf]);

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

  // a unit bucket shows only if some PO has units in it (Σ > 0, not "any row
  // mentions it") — otherwise an all-zero column would sit there permanently
  const unitBuckets = useMemo(() => {
    const total: Record<string, number> = {};
    filtered.forEach((r) => { const s = unitsOf(r); for (const b in s) total[b] = (total[b] || 0) + s[b]; });
    return UNIT_ORDER.filter((b) => total[b]);
  }, [filtered]);
  const tlBuckets = useMemo(() => {
    const present = new Set<string>(filtered.map((r) => r.hod_timeliness));
    return TL_ORDER.filter((b) => present.has(b));
  }, [filtered]);
  // HOD is a PO-level axis: one bucket per row, carrying its whole ordered qty
  const hodSplit = useMemo(() => (r: SmsReportRow) => ({ [r.hod_timeliness]: r.ordered_qty }), []);

  function exportCsv() {
    // New columns go at the END so existing column positions in anyone's sheet
    // don't shift. "Shipped (recorded)" + "Shipment Record" are the cleanup
    // worklist: they differ from Shipped exactly on POs received in NetSuite
    // with no consignment entered here.
    const headers = ['PO', 'TRN', 'Supplier', 'Season', 'Destination', 'Channel', 'HOD', 'Ship Method',
      'Ordered', 'Shipped', 'Received', 'Remaining', 'Lots', 'First Ship', 'Fulfillment', 'HOD Timeliness', 'KPI Status',
      'Shipped (recorded)', 'Shipment Record'];
    const lines = [headers.join(',')];
    filtered.forEach((r) => lines.push([
      r.po_number, r.trn_number, r.supplier, r.season, facilityLabel(r.facility), r.channel, r.hod, r.ship_method,
      r.ordered_qty, r.shipped_qty, r.received_qty, r.remaining_qty, r.lot_count, r.earliest_ship_date,
      r.fulfillment, r.hod_timeliness, r.kpi_status,
      r.shipped_recorded_qty ?? '', r.has_shipment_record === false ? 'missing' : 'yes',
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
          <Donut title="HOD Timeliness" subtitle="Ordered units of POs by handover status vs HOD"
                 rows={filtered} splitOf={hodSplit} order={TL_ORDER} colors={TL_COLORS} />
          <Donut title="Fulfillment" subtitle="Units by where they are — received, in transit, still to ship"
                 rows={filtered} splitOf={unitsOf} order={UNIT_ORDER} colors={UNIT_COLORS} />
        </div>

        {/* ── Pivots ── */}
        <PivotTable
          title="By Supplier" subtitle="Units by where they are — each row sums to that supplier's ordered units"
          rowHeader="Supplier"
          rows={filtered} rowOf={(r) => r.supplier || 'Unknown'}
          buckets={unitBuckets} splitOf={unitsOf} bucketText={UNIT_TEXT}
        />
        <PivotTable
          title="By Channel" subtitle="Ordered units of POs by HOD timeliness — where the risk is" rowHeader="Channel"
          rows={filtered} rowOf={(r) => r.channel || 'Unassigned'}
          buckets={tlBuckets} splitOf={hodSplit} bucketText={TL_TEXT}
        />
      </div>
    </div>
  );
}
