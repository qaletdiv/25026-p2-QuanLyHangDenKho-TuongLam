'use client';

import { useMemo, useRef, useState } from 'react';
import { BarChart3, Download, Filter, ChevronDown } from 'lucide-react';
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from 'recharts';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import type { MainlineReportRow, TransitTimesReport, ProductionScheduleRow } from '@/modules/mainline/types';
import { getPoLegLines } from '@/modules/mainline/actions';
import { downloadCsv } from '@/lib/downloadCsv';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import TransitTimes from './TransitTimes';
import CopyButton, { copyTable } from './CopyButton';
import CopyImageButton from '../CopyImageButton';
import ReportsTabs from '../ReportsTabs';

// Item-lines export columns (all SKU allocations across every leg — full PO detail).
const ITEM_COLS = [
  { key: 'po_number', label: 'PO Number' }, { key: 'trn_number', label: 'TRN' },
  { key: 'supplier', label: 'Supplier' }, { key: 'season', label: 'Season' }, { key: 'mode', label: 'Mode' },
  { key: 'receiving_warehouse', label: 'Destination' }, { key: 'allocation_channel', label: 'Channel' },
  // planned (leg / WIP) and actual (shipment) dates sit side by side — see
  // poController.getAllLegLines; merging them would hide the slip.
  { key: 'crd', label: 'CRD' }, { key: 'e_del', label: 'E-DEL (planned)' },
  // NOTE: the leg's planned etd_pol IS on the API payload as `etd_pol_planned`, but
  // it is null on all 86 legs — the WIP sheets in use never supply it — so it is
  // left out here rather than shipping a column that is blank in every row.
  { key: 'shipment_numbers', label: 'Shipment(s)' }, { key: 'shipment_count', label: 'Shipment Count' },
  { key: 'etd_pol', label: 'ETD POL (actual)' }, { key: 'eta_pod', label: 'ETA POD' },
  { key: 'e_del_actual', label: 'E-DEL (actual)' },
  { key: 'cargo_received_date', label: 'Received at Port' },
  { key: 'expected_ata', label: 'Expected ATA' }, { key: 'ata', label: 'ATA' },
  { key: 'leg_id', label: 'Leg ID' },
  { key: 'sku_code', label: 'SKU' }, { key: 'item_name', label: 'Item' }, { key: 'style_color', label: 'Style/Color' },
  { key: 'size', label: 'Size' }, { key: 'allocated_qty', label: 'Allocated Qty' }, { key: 'unit_price', label: 'Unit Price' },
];

/* ── KPI buckets (manager's column order) ─────────────────────────── */
const BUCKET_ORDER = ['Delivered', 'At Risk', 'Late', 'On Time', 'Received'];

const BUCKET_TEXT: Record<string, string> = {
  'Delivered': 'text-emerald-600',
  'At Risk':   'text-amber-600',
  'Late':      'text-red-600',
  'On Time':   'text-green-600',
  'Received':  'text-blue-600',
  'Unknown':   'text-muted-foreground',
};

const TOOLTIP_STYLE = {
  borderRadius: '12px',
  border: '1px solid var(--color-border)',
  backgroundColor: 'var(--color-card)',
  color: 'var(--color-foreground)',
  boxShadow: '0 8px 32px rgba(0,0,0,0.15)',
};

// pie slice colors — match the BUCKET_TEXT semantics
const BUCKET_COLORS: Record<string, string> = {
  'Received':  '#3B82F6',
  'Delivered': '#10B981',
  'On Time':   '#22C55E',
  'At Risk':   '#F59E0B',
  'Late':      '#EF4444',
  'Unknown':   '#9CA3AF',
};
// stage = WHERE the qty is (the "why" axis): pre-booking states first, then the
// shipment pipeline. Rows appear in this order in the Stage × Timeliness pivot.
const STAGE_ORDER = ['Awaiting Booking', 'Booking Pending', 'Ready to Ship', 'In Transit', 'At Port', 'Delivered', 'Received', 'Cancelled'];
const TIMELINESS_ORDER = ['On Time', 'At Risk', 'Late', 'Unknown'];

const fmt = (n: number) => n.toLocaleString();
// CSV field escaping (reason strings contain commas)
const csv = (v: unknown) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

/* ── pivot helper: facility rows × bucket cols (+ grand totals) ──────── */
function buildPivot(rows: MainlineReportRow[], buckets: string[]) {
  const byFac: Record<string, Record<string, number>> = {};
  rows.forEach((r) => {
    const f = r.facility || 'Unknown';
    (byFac[f] = byFac[f] || {})[r.kpi_status] = (byFac[f]?.[r.kpi_status] || 0) + r.qty;
  });
  const facilities = Object.keys(byFac).sort();
  const body = facilities.map((f) => {
    const cells = buckets.map((b) => byFac[f][b] || 0);
    return { facility: f, cells, total: cells.reduce((a, c) => a + c, 0) };
  });
  const totals = buckets.map((_, i) => body.reduce((a, r) => a + r.cells[i], 0));
  return { body, totals, grand: totals.reduce((a, c) => a + c, 0) };
}

/* ── one segment KPI table ───────────────────────────────────────────── */
function KpiTable({ title, subtitle, rows, buckets }: {
  title: string; subtitle: string; rows: MainlineReportRow[]; buckets: string[];
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const { body, totals, grand } = useMemo(() => buildPivot(rows, buckets), [rows, buckets]);
  const copy = () => copyTable(
    [title, ...buckets, 'Grand Total'],
    [
      ...body.map((r) => [r.facility, ...r.cells.map((c) => (c ? fmt(c) : '—')), fmt(r.total)]),
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
              <th className="text-left px-4 py-2 font-bold text-[11px] uppercase tracking-widest text-muted-foreground">QTY WIP</th>
              {buckets.map((b) => (
                <th key={b} className={cn('text-right px-4 py-2 font-bold text-[11px] uppercase tracking-widest', BUCKET_TEXT[b] || 'text-muted-foreground')}>{b}</th>
              ))}
              <th className="text-right px-4 py-2 font-bold text-[11px] uppercase tracking-widest text-foreground">Grand Total</th>
            </tr>
          </thead>
          <tbody>
            {body.length === 0 && (
              <tr><td colSpan={buckets.length + 2} className="px-4 py-6 text-center text-muted-foreground">No shipments</td></tr>
            )}
            {body.map((r) => (
              <tr key={r.facility} className="border-b border-border hover:bg-muted/30">
                <td className="px-4 py-2 font-medium text-foreground">{r.facility}</td>
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

/* ── per-channel KPI donut: units by Late / At Risk / On Time / … ─────── */
function ChannelPie({ title, subtitle, rows }: { title: string; subtitle: string; rows: MainlineReportRow[] }) {
  const cardRef = useRef<HTMLDivElement>(null);
  const data = useMemo(() => {
    const agg: Record<string, number> = {};
    rows.forEach((r) => { agg[r.kpi_status] = (agg[r.kpi_status] || 0) + r.qty; });
    const order = [...BUCKET_ORDER, 'Unknown', ...Object.keys(agg).filter((b) => !BUCKET_ORDER.includes(b) && b !== 'Unknown').sort()];
    return order.filter((b) => agg[b]).map((b) => ({ name: b, value: agg[b] }));
  }, [rows]);
  const total = data.reduce((a, d) => a + d.value, 0);
  const copy = () => copyTable(
    [title, 'Units', '%'],
    [
      ...data.map((d) => [d.name, fmt(d.value), total ? `${Math.round((d.value / total) * 100)}%` : '0%']),
      ['Total', fmt(total), '100%'],
    ],
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
                {data.map((d) => <Cell key={d.name} fill={BUCKET_COLORS[d.name] || '#9CA3AF'} />)}
              </Pie>
              <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v: any, name: any) => [`${fmt(v)} units`, name]} />
            </PieChart>
          </ResponsiveContainer>
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="text-center">
              <p className="text-xs font-bold text-muted-foreground">TOTAL</p>
              <p className="text-base font-black text-foreground">{fmt(total)}</p>
            </div>
          </div>
        </div>
        <div className="mt-2 grid grid-cols-2 gap-x-6">
          {data.map((d) => (
            <div key={d.name} className="flex items-center justify-between gap-2 py-1.5 border-b border-border/50">
              <div className="flex items-center gap-2 min-w-0">
                <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: BUCKET_COLORS[d.name] || '#9CA3AF' }} />
                <span className="text-xs font-medium text-muted-foreground truncate">{d.name}</span>
              </div>
              <span className="text-xs font-black text-foreground whitespace-nowrap">{fmt(d.value)} · {total ? Math.round((d.value / total) * 100) : 0}%</span>
            </div>
          ))}
          {data.length === 0 && <p className="col-span-2 py-4 text-center text-xs text-muted-foreground">No units</p>}
        </div>
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════ */
export default function MainlineReportsClient({ rows, transit, schedules = [] }: {
  rows: MainlineReportRow[]; transit: TransitTimesReport | null; schedules?: ProductionScheduleRow[];
}) {
  const seasons = useMemo(() => [...new Set(rows.map((r) => r.season).filter(Boolean))].sort() as string[], [rows]);
  const [season, setSeason] = useState<string>('');

  // default to the first season once data arrives
  const activeSeason = season || seasons[0] || '';
  const filtered = useMemo(() => rows.filter((r) => !activeSeason || r.season === activeSeason), [rows, activeSeason]);

  const ws = useMemo(() => filtered.filter((r) => r.segment === 'WS'), [filtered]);
  const ec = useMemo(() => filtered.filter((r) => r.segment === 'EC'), [filtered]);

  // shared column set across both tables, ordered per the manager's spec (+ extras like Unknown)
  const buckets = useMemo(() => {
    const present = new Set(filtered.map((r) => r.kpi_status));
    const cols = BUCKET_ORDER.filter((b) => present.has(b));
    [...present].filter((b) => !BUCKET_ORDER.includes(b)).sort().forEach((b) => cols.push(b));
    return cols.length ? cols : BUCKET_ORDER;
  }, [filtered]);

  // secondary: stage × timeliness pivot — the "why" axis. Late qty in the
  // Awaiting Booking row is late because nobody booked it yet.
  const stagePivot = useMemo(() => {
    const stages = STAGE_ORDER.filter((p) => filtered.some((r) => r.stage === p));
    const cols = TIMELINESS_ORDER.filter((t) => filtered.some((r) => r.timeliness === t));
    const cell = (p: string, t: string) => filtered.filter((r) => r.stage === p && r.timeliness === t).reduce((a, r) => a + r.qty, 0);
    return { stages, cols, cell };
  }, [filtered]);

  // Combined PO × Booking × Shipment rows (the report grain), respects the season filter.
  function exportCsv() {
    const headers = ['PO', 'TRN', 'Supplier', 'Season', 'Facility', 'Channel', 'Segment', 'Mode', 'Qty',
      'Stage', 'Booking', 'Shipment', 'CRD', 'E-DEL', 'Expected ATA', 'ATA', 'Timeliness', 'KPI Status'];
    const lines = [headers.join(',')];
    filtered.forEach((r) => lines.push([
      r.po_number, r.trn_number, r.supplier, r.season, r.facility, r.channel, r.segment, r.mode, r.qty,
      r.stage, r.booking_number, r.shipment_number, r.crd, r.e_del, r.expected_ata, r.ata,
      r.timeliness, r.kpi_status,
    ].map(csv).join(',')));
    const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `mainline-report-${activeSeason || 'all'}.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  const [dlOpen, setDlOpen] = useState(false);
  const [dlBusy, setDlBusy] = useState(false);
  const stageCardRef = useRef<HTMLDivElement>(null);
  async function exportItemLines() {
    setDlBusy(true);
    try {
      const rows = await getPoLegLines();
      if (!rows.length) { toast.info('No item lines to download.'); return; }
      downloadCsv('mainline-po-item-lines.csv', ITEM_COLS, rows);
    } catch { toast.error('Download failed'); } finally { setDlBusy(false); }
  }

  return (
    <div className="flex h-full min-h-screen bg-background">
      <div className="flex-1 overflow-y-auto p-4 md:p-6 space-y-6">

        <ReportsTabs />

        {/* ── Header ── */}
        <div className="flex flex-col gap-4 md:flex-row md:items-center rounded-2xl px-4 py-4 sm:px-6 sm:py-5 bg-primary border border-primary/50">
          <div className="p-3 rounded-xl bg-primary-foreground/15 self-start"><BarChart3 className="w-6 h-6 text-primary-foreground" /></div>
          <div>
            <h1 className="text-xl sm:text-2xl font-black text-primary-foreground tracking-tight">Season Delivery KPI</h1>
            <div className="text-sm mt-0.5 text-primary-foreground/70">
              {(() => {
                const sched = schedules.find((s) => s.season === activeSeason);
                return sched?.ontime_by && sched?.atrisk_by
                  ? <>
                      <p className="font-semibold text-primary-foreground">{activeSeason}:</p>
                      <p>On Time ≤ {sched.ontime_by}</p>
                      <p>At Risk ≤ {sched.atrisk_by}</p>
                      <p>Late = {sched.atrisk_by}</p>
                    </>
                  : <p>No production schedule set for {activeSeason || 'this season'} — grades show as Unknown. Set the cutoffs in Settings → Production Schedule.</p>;
              })()}
            </div>
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
                  Report rows — PO × Booking × Shipment <span className="text-muted-foreground">({filtered.length})</span>
                </button>
                <button onClick={() => { setDlOpen(false); exportItemLines(); }} className="w-full text-left px-3 py-2 text-sm rounded-md hover:bg-muted transition-colors">
                  PO item lines (SKUs)
                </button>
              </PopoverContent>
            </Popover>
          </div>
        </div>

        {/* ── Per-channel KPI donuts ── */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <ChannelPie title="Wholesale (Reserved)" subtitle="Units by delivery status" rows={ws} />
          <ChannelPie title="Ecomm (First)"        subtitle="Units by delivery status" rows={ec} />
        </div>

        {/* ── Stage × Timeliness pivot ── */}
        <div ref={stageCardRef} className="rounded-2xl shadow-2xl overflow-hidden bg-card border border-border">
            <div className="px-6 pt-5 pb-3 flex items-start justify-between gap-4">
              <div>
                <p className="text-base font-black text-foreground">Stage × Timeliness</p>
                <p className="text-xs mt-0.5 text-muted-foreground">Where the units are vs schedule status — late qty on the Awaiting Booking row is late because it isn&apos;t booked yet</p>
              </div>
              <div className="flex items-center gap-2">
                <CopyImageButton target={stageCardRef} name="Stage x Timeliness" />
                <CopyButton onCopy={() => copyTable(
                  ['Stage', ...stagePivot.cols],
                  stagePivot.stages.map((p) => [p, ...stagePivot.cols.map((t) => { const v = stagePivot.cell(p, t); return v ? fmt(v) : '—'; })]),
                )} />
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm bg-card">
                <thead>
                  <tr className="bg-card/80 border-y border-border">
                    <th className="text-left px-4 py-2 font-bold text-[11px] uppercase tracking-widest text-muted-foreground">Stage</th>
                    {stagePivot.cols.map((t) => (
                      <th key={t} className={cn('text-right px-4 py-2 font-bold text-[11px] uppercase tracking-widest', BUCKET_TEXT[t] || 'text-muted-foreground')}>{t}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {stagePivot.stages.length === 0 && (
                    <tr><td colSpan={stagePivot.cols.length + 1} className="px-4 py-6 text-center text-muted-foreground">No data</td></tr>
                  )}
                  {stagePivot.stages.map((p) => (
                    <tr key={p} className="border-b border-border hover:bg-muted/30">
                      <td className="px-4 py-2 font-medium text-foreground">{p}</td>
                      {stagePivot.cols.map((t) => {
                        const v = stagePivot.cell(p, t);
                        return <td key={t} className="px-4 py-2 text-right tabular-nums text-foreground">{v ? fmt(v) : '—'}</td>;
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

        {/* ── The two segment KPI tables — side by side on wide screens ── */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <KpiTable title="Wholesale (Reserved)" subtitle="Status KPI Proj — units by destination facility" rows={ws} buckets={buckets} />
          <KpiTable title="Ecomm (First)"        subtitle="Status KPI Proj — units by destination facility" rows={ec} buckets={buckets} />
        </div>

        {/* ── Transit times: actual vs standard per lane ── */}
        {transit && <TransitTimes data={transit} />}
      </div>
    </div>
  );
}
