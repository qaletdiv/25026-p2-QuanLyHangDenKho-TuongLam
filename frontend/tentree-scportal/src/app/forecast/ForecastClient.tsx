'use client';

import React, { useMemo, useRef, useState } from 'react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select';
import { TrendingUp, PackageSearch, CalendarClock, Building2, Boxes as BoxesIcon, Package, Ship, Factory, Layers, ShieldCheck, ChevronRight, ChevronDown } from 'lucide-react';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { cn } from '@/lib/utils';
import ForecastTabs from './ForecastTabs';
import CopyImageButton from '../reports/CopyImageButton';

const TOOLTIP_STYLE = {
  borderRadius: '12px',
  border: '1px solid var(--color-border)',
  backgroundColor: 'var(--color-card)',
  color: 'var(--color-foreground)',
  boxShadow: '0 10px 40px rgba(0,0,0,0.15)',
};

// One PO#-grained row behind a forecast week, as emitted by
// mainlineForecastController's per-week `lines[]`.
type ForecastLine = {
  po_number: string;
  trn_number: string | null;
  supplier: string | null;
  mode: string | null;
  leg_id: string;
  crd: string | null;
  stage: string;
  date_basis: string;
  shipment_id: string | null;
  shipment_number: string | null;
  carrier_reference: string | null;
  warehouse: string;
  channel: string;
  units: number;
  cartons: number;
  plan_date: string | null;
  plan_week: string | null;
  actual_date: string;
  slip_days: number | null;
};

// One breakdown cell, and one series (plan or actual) of a week.
type Cell = { units: number; cartons: number };
type Series = {
  units: number;
  cartons: number;
  warehouses: Record<string, Cell>;
  warehouse_channels: Record<string, Cell>;
  suppliers: Record<string, Cell>;
};
// The three dimensions the matrix can toggle between. PO# is deliberately absent
// — it is the row drill-down, not a column set (63 POs, 26 in one week).
type BreakdownKey = 'warehouses' | 'warehouse_channels' | 'suppliers';

// A forecast week. The top-level units/cartons/maps MIRROR `actual` — the
// best-known answer — so the matrix cells, the drill-down and the Actual column
// all read one figure.
export type ForecastWeek = Series & {
  week: string;
  weekNum: number;
  plan: Series;
  actual: Series;
  // ⚠️ A SUBSET of `actual`, never an addend: the units resting on a real
  // shipment (an approved booking) rather than a date typed on a PO.
  // backed.units / actual.units is the week's confidence.
  backed: Series;
  lines: ForecastLine[];
};

// A line is shipment-backed when a shipment exists for it — landed or not. The
// evidence is the shipment, not the arrival.
const BACKED_STAGES = new Set(['Received', 'In Transit']);
const isBacked = (l: ForecastLine) => BACKED_STAGES.has(l.stage);

// Stage → pill styling, in confidence order: landed, on the water, approved with
// no consignment carrying it (its shipment was cancelled), booked but unapproved,
// and nobody has booked it. Only the first two are shipment-BACKED.
const STAGE_STYLE: Record<string, string> = {
  'Received':            'bg-emerald-500/20 text-emerald-700 dark:text-emerald-400',
  'In Transit':          'bg-primary/20 text-primary',
  'Booked — Not Shipped': 'bg-sky-500/20 text-sky-700 dark:text-sky-400',
  'Booking Pending':     'bg-amber-500/20 text-amber-700 dark:text-amber-400',
  'Awaiting Booking':    'bg-muted text-muted-foreground',
};

export default function ForecastClient({ seasons, bySeason }: { seasons: string[]; bySeason: Record<string, ForecastWeek[]> }) {
  const chartRef = useRef<HTMLDivElement>(null);
  const breakdownRef = useRef<HTMLDivElement>(null);

  // Season scope. Defaults to the newest season PRESENT IN THE ORDER BOOK (the
  // server already sorted them newest-first), never the newest in the seasons
  // master — FW27 exists there with no mainline legs, and defaulting to it would
  // open the page on an empty forecast. Same convention as the lifecycle tables'
  // SeasonScopeFilter. The rollup for every season is pre-computed server-side,
  // so switching is a lookup, not a refetch, and each view reconciles exactly.
  const [season, setSeason] = useState<string>(() => seasons[0] || 'all');
  // Memoised: the `||` fallback would otherwise mint a new array identity on
  // every render and defeat every useMemo below it.
  const forecast: ForecastWeek[] = useMemo(
    () => bySeason[season] || bySeason.all || [], [bySeason, season]);
  const totalCartons = useMemo(() => forecast.reduce((sum, item) => sum + item.cartons, 0), [forecast]);
  const totalUnits   = useMemo(() => forecast.reduce((sum, item) => sum + item.units,   0), [forecast]);
  // The PLAN total. It differs from the actual total by the genuine over-shipment
  // on three legs (+599), which is data, not a rounding artefact — see the
  // controller header. The two series are NEVER added together: each one covers
  // the whole order book, the same units on two different dates.
  const totalPlan = useMemo(() => forecast.reduce((sum, f) => sum + (f.plan?.units ?? 0), 0), [forecast]);

  const allLines: ForecastLine[] = useMemo(() => forecast.flatMap((f) => f.lines || []), [forecast]);

  // Already in the warehouse vs still to come. `/forecast` now covers the full
  // order book, so leading with the raw total would overstate what is inbound.
  const receivedUnits = useMemo(
    () => allLines.filter((l) => l.stage === 'Received').reduce((s, l) => s + l.units, 0), [allLines]);
  const toArriveUnits = totalUnits - receivedUnits;

  // Slippage = units whose best-known date landed in a different week from the
  // one the PO planned. Unbooked legs have actual == plan by construction, so
  // they contribute nothing here — an uncommitted leg has not slipped.
  const slipLater = useMemo(
    () => allLines.filter((l) => (l.slip_days ?? 0) > 0).reduce((s, l) => s + l.units, 0), [allLines]);
  const slipEarlier = useMemo(
    () => allLines.filter((l) => (l.slip_days ?? 0) < 0).reduce((s, l) => s + l.units, 0), [allLines]);

  const peakWeek = useMemo(() => {
    if (!forecast.length) return { week: '—', units: 0 };
    return forecast.reduce((max, f) => f.units > max.units ? f : max, forecast[0]);
  }, [forecast]);

  // Breakdown matrix toggles: metric (units/cartons) and dimension. The controller
  // emits `warehouses`, `warehouse_channels` and `suppliers` maps per week; `bkKey`
  // selects which one the matrix reads. PO# is deliberately NOT here — 63 POs (26
  // in one week) is not a column set; it is the drill-down below each week row.
  const [metric, setMetric] = useState<'units' | 'cartons'>('units');
  const [breakdown, setBreakdown] = useState<'warehouse' | 'channel' | 'supplier'>('warehouse');

  // Basis scope. 'all' = the best-known answer for every unit; 'backed' = only
  // the units a real shipment stands behind. In 'backed' the plan comparison is
  // DROPPED rather than recomputed: `plan` covers every leg, so setting it beside
  // a filtered subset would invent a slippage that isn't there. Backed mode is a
  // different question — "what is actually committed?" — not a filtered Δ.
  const [basis, setBasis] = useState<'all' | 'backed'>('all');
  const seriesKey: 'actual' | 'backed' = basis === 'backed' ? 'backed' : 'actual';
  const bkKey: BreakdownKey = breakdown === 'channel' ? 'warehouse_channels'
              : breakdown === 'supplier' ? 'suppliers'
              : 'warehouses';

  // Expanded weeks for the PO# drill-down, keyed by week label.
  const [openWeeks, setOpenWeeks] = useState<Set<string>>(() => new Set());
  const toggleWeek = (week: string) => setOpenWeeks((prev) => {
    const next = new Set(prev);
    if (next.has(week)) next.delete(week); else next.add(week);
    return next;
  });

  // Today at UTC midnight, for the overdue marker on drill-down rows. Most of the
  // live forecast is already in the past (unbooked legs whose E-DEL has gone by),
  // which is invisible at week × warehouse grain and glaring at PO# grain.
  const todayIso = new Date().toISOString().slice(0, 10);

  // Matrix columns: the union of keys in the SELECTED breakdown map across every week.
  const columns = useMemo(() => {
    const cols = new Set<string>();
    forecast.forEach(f => Object.keys(f[seriesKey]?.[bkKey] || {}).forEach(c => cols.add(c)));
    return Array.from(cols).sort();
  }, [forecast, bkKey, seriesKey]);

  // Cell value for (week, column) in the selected metric, read off the mirrored
  // (= actual) maps.
  const cell = (f: ForecastWeek, col: string): number => f[seriesKey]?.[bkKey]?.[col]?.[metric] ?? 0;
  // The week's total in the selected basis + metric.
  const rowTotal = (f: ForecastWeek): number => f[seriesKey]?.[metric] ?? 0;

  // Column totals and grand total in the selected metric.
  const colTotals = useMemo(() =>
    columns.map(col => forecast.reduce((sum, f) => sum + cell(f, col), 0)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [forecast, columns, metric, bkKey, seriesKey]);
  const grandTotal = useMemo(() => forecast.reduce((sum, f) => sum + rowTotal(f), 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [forecast, metric, seriesKey]);

  // The Projected / Δ / Backed block applies to UNITS on the 'all' basis only: a
  // plan has no cartons to compare against, and in 'backed' mode the plan covers
  // a wider set of legs than the rows on screen (see the `basis` note above).
  const showCompare = metric === 'units' && basis === 'all';
  const planOf = (f: { plan?: { units?: number } }) => f.plan?.units ?? 0;
  const backedOf = (f: ForecastWeek) => f.backed?.units ?? 0;

  // Overall confidence: the share of the pipeline a real shipment stands behind.
  const totalBacked = useMemo(() => forecast.reduce((s, f) => s + backedOf(f), 0), [forecast]);
  const confidencePct = totalUnits > 0 ? Math.round((totalBacked / totalUnits) * 100) : 0;

  // In backed mode a week with nothing booked would render as a row of dashes,
  // which says less than omitting it. Totals are unaffected — those weeks
  // contribute zero either way.
  const visibleWeeks = useMemo(
    () => (basis === 'backed' ? forecast.filter((f) => backedOf(f) > 0) : forecast),
    [forecast, basis]);

  // Units the backed view drops, and how far ahead the evidence actually runs.
  const unbackedUnits = totalUnits - totalBacked;
  const lastBackedWeek = useMemo(() => {
    const wks = forecast.filter((f) => backedOf(f) > 0);
    return wks.length ? wks[wks.length - 1].week : null;
  }, [forecast]);

  // Two series, not a stack: Projected is where the POs said the units would
  // land, Actual is where the best-known date puts them. They diverge exactly
  // where reality moved. The old Cartons line is gone — it tracked a quantity
  // that is only ever known for the shipped part, so it read as a flat zero
  // whenever nothing was mid-flight and told the reader nothing.
  const chartData = useMemo(() => forecast.map(f => ({
    week: f.week.split(' - ')[0],
    Projected: f.plan?.units ?? 0,
    Actual: f.units,
  })), [forecast]);

  return (
    <div className="flex h-full min-h-screen bg-background">
      <div className="flex-1 overflow-y-auto p-4 md:p-6 space-y-6">

        <ForecastTabs />

        {/* Page Header */}
        <div className="animate-in fade-in slide-in-from-bottom-4 duration-300">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center rounded-2xl px-4 py-4 sm:px-6 sm:py-5 bg-primary border border-primary/50">
            <div className="p-3 rounded-xl bg-primary-foreground/15 self-start">
              <TrendingUp className="w-6 h-6 text-primary-foreground" />
            </div>
            <div>
              <h1 className="text-xl sm:text-2xl font-black text-primary-foreground tracking-tight">Inventory Pipeline Forecast</h1>
              <p className="text-sm mt-0.5 text-primary-foreground/70">Planned arrival weeks vs the best-known dates — where the order book has moved.</p>
            </div>
            <div className="sm:ml-auto flex items-center gap-3">
              {/* Season scope — governs the WHOLE page (KPIs, chart, breakdown,
                  drill-down), which is why it sits in the header rather than on
                  the breakdown toolbar. Only seasons the order book actually
                  holds are offered. */}
              <Select value={season} onValueChange={(v) => v && setSeason(v)}>
                <SelectTrigger
                  className="w-36 h-9 bg-primary-foreground/15 border-primary-foreground/30 text-primary-foreground font-bold"
                  aria-label="Filter the forecast by season"
                >
                  {season === 'all' ? 'All Seasons' : season}
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Seasons</SelectItem>
                  {seasons.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                </SelectContent>
              </Select>
              <div className="px-4 py-1.5 rounded-full text-xs font-black uppercase tracking-widest bg-primary-foreground/20 text-primary-foreground border border-primary-foreground/30 whitespace-nowrap">
                {forecast.length} Weeks Scheduled
              </div>
            </div>
          </div>
        </div>

        {/* KPI Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4 animate-in fade-in slide-in-from-bottom-6 duration-500">

          {/* Total Units — hero. Units are the only figure that is always real:
              every part of the pipeline has a quantity, whereas cartons exist only
              once a packing list has been uploaded. Cartons used to be the hero
              card, which meant an empty in-transit window rendered a 0 in the
              largest type on the page and read as a failure. */}
          <div className="rounded-2xl p-6 shadow-2xl relative overflow-hidden bg-primary border border-primary/50">
            <div className="absolute -right-4 -top-4 opacity-10">
              <PackageSearch className="w-24 h-24 text-primary-foreground" />
            </div>
            <div className="relative z-10 space-y-1">
              <p className="text-xs font-black uppercase tracking-widest text-primary-foreground/75">Total Units</p>
              <p className="text-3xl font-black text-primary-foreground">{totalUnits.toLocaleString()}</p>
              <p className="text-xs font-medium text-primary-foreground/60">
                full order book · {totalPlan.toLocaleString()} planned
              </p>
            </div>
          </div>

          {/* Still to arrive. The page covers the whole order book now, so the
              hero total includes goods already in the warehouse — this card is
              what is actually still coming. */}
          <div className="rounded-2xl p-6 shadow-2xl bg-card border border-border">
            <div className="flex justify-between items-start">
              <div className="space-y-1">
                <p className="text-xs font-black uppercase tracking-widest text-muted-foreground">Still to Arrive</p>
                <p className="text-3xl font-black text-foreground">{toArriveUnits.toLocaleString()}</p>
                <p className="text-xs font-medium text-muted-foreground">
                  {receivedUnits.toLocaleString()} already received
                </p>
                <p className="text-xs font-medium text-muted-foreground/70">
                  {totalCartons.toLocaleString()} carton{totalCartons === 1 ? '' : 's'} packed
                </p>
              </div>
              <div className="p-3 rounded-xl bg-primary/15">
                <Ship className="w-5 h-5 text-primary" />
              </div>
            </div>
          </div>

          {/* Peak Week */}
          <div className="rounded-2xl p-6 shadow-2xl bg-card border border-border">
            <div className="flex justify-between items-start">
              <div className="space-y-1">
                <p className="text-xs font-black uppercase tracking-widest text-muted-foreground">Peak Week</p>
                <p className="text-3xl font-black text-foreground">{peakWeek.week.split(' - ')[0] || '—'}</p>
                <p className="text-xs font-medium text-primary">{peakWeek.units.toLocaleString()} units arriving</p>
              </div>
              <div className="p-3 rounded-xl bg-primary/15">
                <CalendarClock className="w-5 h-5 text-primary" />
              </div>
            </div>
          </div>

          {/* Confidence — how much of the pipeline a real shipment stands
              behind. This is the answer to "does the forecast have a
              foundation?", so it outranks the slippage figure, which moves to
              the subtitle. */}
          <div className="rounded-2xl p-6 shadow-2xl bg-card border border-border">
            <div className="flex justify-between items-start">
              <div className="space-y-1">
                <p className="text-xs font-black uppercase tracking-widest text-muted-foreground">Shipment-Backed</p>
                <p className={cn('text-3xl font-black',
                  confidencePct >= 50 ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400')}>
                  {confidencePct}%
                </p>
                <p className="text-xs font-medium text-muted-foreground">
                  {totalBacked.toLocaleString()} units on an approved booking
                </p>
                <p className="text-xs font-medium text-muted-foreground/70">
                  {slipLater.toLocaleString()} slipped later · {slipEarlier.toLocaleString()} early
                </p>
              </div>
              <div className="p-3 rounded-xl bg-accent/15">
                <ShieldCheck className="w-5 h-5 text-accent" />
              </div>
            </div>
          </div>
        </div>

        {/* Area Chart */}
        <div ref={chartRef} className="rounded-2xl shadow-2xl overflow-hidden animate-in fade-in slide-in-from-bottom-8 duration-700 bg-card border border-border">
          <div className="px-6 pt-5 pb-2 flex items-start justify-between gap-4">
            <div>
              <p className="text-base font-black text-foreground">Weekly Inbound Volume</p>
              <p className="text-xs mt-0.5 text-muted-foreground">
                Units per week — dashed is where the POs planned them, solid is where they actually land
              </p>
            </div>
            <CopyImageButton target={chartRef} name="Weekly Inbound Volume" />
          </div>
          <div className="px-4 pb-5">
            <div className="h-[350px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chartData} margin={{ top: 10, right: 30, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="fillActual" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%"  stopColor="var(--chart-1)" stopOpacity={0.5} />
                      <stop offset="95%" stopColor="var(--chart-1)" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--color-border)" />
                  <XAxis dataKey="week" axisLine={false} tickLine={false} tick={{ fill: 'var(--color-muted-foreground)', fontWeight: 600, fontSize: 12 }} dy={10} />
                  <YAxis axisLine={false} tickLine={false} tick={{ fill: 'var(--color-muted-foreground)', fontSize: 11 }} dx={-10} />
                  <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={{ color: 'var(--color-primary)', fontWeight: 700 }} itemStyle={{ fontWeight: 700 }} />
                  <Legend iconType="plainline" wrapperStyle={{ fontSize: 12, fontWeight: 700, paddingTop: 8 }} />
                  {/* Projected is drawn UNFILLED, dashed and NEUTRAL so it reads as
                      the plan rather than a second volume — only Actual is a real
                      quantity arriving, and two filled areas would imply a sum.
                      Neutral rather than --chart-2 because in the active theme
                      chart-1 (#ef4444) and chart-2 (#f87171) are both reds, so the
                      two lines separated only by their dash pattern. */}
                  <Area type="monotone" dataKey="Projected" stroke="var(--color-muted-foreground)" strokeWidth={2} strokeDasharray="5 3" fill="none" activeDot={{ r: 4, strokeWidth: 0, fill: 'var(--color-muted-foreground)' }} />
                  <Area type="monotone" dataKey="Actual"    stroke="var(--chart-1)" strokeWidth={3} fillOpacity={1} fill="url(#fillActual)" activeDot={{ r: 6, strokeWidth: 0, fill: 'var(--chart-1)' }} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>

        {/* Breakdown matrix — weeks (rows) × warehouse[/channel] (columns), toggled by metric */}
        <div ref={breakdownRef} className="rounded-2xl shadow-2xl overflow-hidden animate-in fade-in slide-in-from-bottom-10 duration-900 bg-card border border-border">
          <div className="px-6 py-5 flex items-center justify-between gap-4 border-b border-border flex-wrap">
            <div>
              <p className="text-base font-black text-foreground">Forecast Breakdown</p>
              <p className="text-xs mt-0.5 text-muted-foreground">
                {basis === 'backed' ? 'Only units a real shipment stands behind' : metric === 'cartons' ? 'Packed cartons' : 'Units on their best-known date'} per{' '}
                {breakdown === 'channel' ? 'warehouse + channel' : breakdown === 'supplier' ? 'supplier' : 'destination warehouse'}
                {showCompare ? ' · Projected is the same units on the date their PO planned' : ''}
                {' · '}open a week for the PO breakdown
              </p>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <CopyImageButton target={breakdownRef} name="Forecast Breakdown" />
              {/* Breakdown dimension: Warehouse / Warehouse + Channel / Supplier.
                  Supplier is the only other axis with column-sized cardinality
                  (13 suppliers, at most 5 in any one week); PO# and TRN are not,
                  which is why PO# is the row drill-down instead. */}
              <div className="flex items-center rounded-full border border-border p-0.5 bg-muted/30">
                {([['warehouse', 'Warehouse', Building2], ['channel', '+ Channel', Building2], ['supplier', 'Supplier', Factory]] as const).map(([key, label, Icon]) => (
                  <button
                    key={key}
                    onClick={() => setBreakdown(key)}
                    className={cn(
                      'flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-xs font-black uppercase tracking-wider transition-colors',
                      breakdown === key ? 'bg-primary text-primary-foreground shadow' : 'text-muted-foreground hover:text-foreground'
                    )}
                  >
                    <Icon className="w-3.5 h-3.5" />
                    {label}
                  </button>
                ))}
              </div>
              {/* Basis: everything vs only what a shipment stands behind. */}
              <div className="flex items-center rounded-full border border-border p-0.5 bg-muted/30">
                {([['all', 'All Basis', Layers], ['backed', 'Shipment-Backed', Ship]] as const).map(([key, label, Icon]) => (
                  <button
                    key={key}
                    onClick={() => setBasis(key)}
                    className={cn(
                      'flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-xs font-black uppercase tracking-wider transition-colors',
                      basis === key ? 'bg-primary text-primary-foreground shadow' : 'text-muted-foreground hover:text-foreground'
                    )}
                  >
                    <Icon className="w-3.5 h-3.5" />
                    {label}
                  </button>
                ))}
              </div>
              {/* Metric filter: Units / Cartons */}
              <div className="flex items-center rounded-full border border-border p-0.5 bg-muted/30">
                {([['units', 'Units', Package], ['cartons', 'Cartons', BoxesIcon]] as const).map(([key, label, Icon]) => (
                  <button
                    key={key}
                    onClick={() => setMetric(key)}
                    className={cn(
                      'flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-xs font-black uppercase tracking-wider transition-colors',
                      metric === key ? 'bg-primary text-primary-foreground shadow' : 'text-muted-foreground hover:text-foreground'
                    )}
                  >
                    <Icon className="w-3.5 h-3.5" />
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </div>
          {/* An empty Cartons grid is usually TRUE, not broken: cartons come from
              the packing list, which only exists once a consignment has shipped,
              and a shipped consignment leaves this pipeline as soon as its
              NetSuite receipt lands. Say so, rather than rendering a wall of
              em-dashes and leaving the reader to guess. */}
          {/* Backed mode states plainly how far the evidence runs. With bookings
              still recorded at or after arrival, that horizon is behind us — the
              page should say so rather than present an empty table as a forecast. */}
          {basis === 'backed' && forecast.length > 0 && (
            <div className="px-6 py-3 text-xs text-muted-foreground border-b border-border bg-emerald-500/5">
              <span className="font-bold text-foreground">
                Showing only the {totalBacked.toLocaleString()} units an approved booking stands behind ({confidencePct}% of the pipeline).
              </span>{' '}
              {unbackedUnits.toLocaleString()} units are hidden because no shipment exists for them yet
              {lastBackedWeek ? <> — the booked pipeline currently runs to <span className="font-bold text-foreground">{lastBackedWeek}</span></> : null}.
              Bookings entered before cargo ships will extend this forward automatically.
            </div>
          )}
          {metric === 'cartons' && basis === 'all' && forecast.length > 0 && (
            <div className="px-6 py-3 text-xs text-muted-foreground border-b border-border bg-amber-500/5">
              <span className="font-bold text-foreground">Cartons cover the shipped units only.</span>{' '}
              A carton is known once a packing list is uploaded, which happens when a consignment ships — so the
              {' '}{toArriveUnits.toLocaleString()} units still to arrive contribute none, and there is no plan
              figure to compare against. Switch to <span className="font-bold">Units</span> for the
              Projected-vs-Actual view.
            </div>
          )}
          {forecast.length === 0 || columns.length === 0 ? (
            <div className="text-center py-12 text-sm italic text-muted-foreground">No inbound shipments currently scheduled.</div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="bg-primary/10 border-b border-border">
                    <TableHead className="h-11 pl-6 sticky left-0 bg-primary/10 z-10 text-[10px] font-black uppercase tracking-widest text-primary">Week</TableHead>
                    {columns.map(col => (
                      <TableHead key={col} className="h-11 px-4 text-right text-[10px] font-black uppercase tracking-tight text-primary whitespace-nowrap">{col}</TableHead>
                    ))}
                    {showCompare && (
                      <TableHead className="h-11 px-4 text-right text-[10px] font-black uppercase tracking-widest text-muted-foreground border-l border-border whitespace-nowrap" title="Units on the week their PO planned them for">
                        Projected
                      </TableHead>
                    )}
                    <TableHead className={cn('h-11 px-4 text-right text-[10px] font-black uppercase tracking-widest text-primary whitespace-nowrap', !showCompare && 'border-l border-border')} title="Units on their best-known date: receipt ATA, else shipment E-DEL, else the PO's own date">
                      {showCompare ? 'Actual' : 'Total'}
                    </TableHead>
                    {showCompare && (
                      <TableHead className="h-11 px-4 text-right text-[10px] font-black uppercase tracking-widest text-primary whitespace-nowrap" title="Actual − Projected for this week">
                        Δ
                      </TableHead>
                    )}
                    {showCompare && (
                      <TableHead className="h-11 px-4 pr-6 text-right text-[10px] font-black uppercase tracking-widest text-emerald-600 dark:text-emerald-400 border-l border-border whitespace-nowrap" title="Units a real shipment stands behind (an approved booking), and their share of Actual — the foundation under this week">
                        Backed
                      </TableHead>
                    )}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visibleWeeks.map((f, i) => {
                    // Drill-down follows the basis, so Σ lines still equals the
                    // total on the row it opened in either mode.
                    const lines: ForecastLine[] = basis === 'backed'
                      ? (f.lines || []).filter(isBacked)
                      : (f.lines || []);
                    const isOpen = openWeeks.has(f.week);
                    return (
                      <React.Fragment key={f.week}>
                        <TableRow
                          className={cn('border-b border-border/40 hover:bg-primary/5', i % 2 !== 0 && 'bg-primary/[0.02]', lines.length > 0 && 'cursor-pointer')}
                          onClick={lines.length > 0 ? () => toggleWeek(f.week) : undefined}
                        >
                          <TableCell className="py-2.5 pl-6 sticky left-0 bg-card z-10 whitespace-nowrap">
                            {lines.length > 0 && (
                              <button
                                type="button"
                                onClick={(e) => { e.stopPropagation(); toggleWeek(f.week); }}
                                aria-expanded={isOpen}
                                aria-label={`${isOpen ? 'Hide' : 'Show'} the ${lines.length} PO lines behind ${f.week}`}
                                className="mr-1 -ml-1 inline-flex items-center align-middle rounded text-muted-foreground hover:text-primary"
                              >
                                {isOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                              </button>
                            )}
                            <span className="px-2 py-0.5 rounded-md text-xs font-black bg-primary/20 text-primary">{f.week.split(' - ')[0]}</span>
                            <span className="ml-1.5 text-[10px] font-medium text-muted-foreground">{f.week.split(' - ').slice(1).join('')}</span>
                          </TableCell>
                          {columns.map(col => {
                            const v = cell(f, col);
                            return (
                              <TableCell key={col} className={cn('px-4 py-2.5 text-right text-sm tabular-nums', v > 0 ? 'font-semibold text-foreground' : 'text-muted-foreground/40')}>
                                {v > 0 ? v.toLocaleString() : '—'}
                              </TableCell>
                            );
                          })}
                          {showCompare && (
                            <TableCell className="px-4 py-2.5 text-right text-sm tabular-nums text-muted-foreground border-l border-border">
                              {planOf(f) > 0 ? planOf(f).toLocaleString() : '—'}
                            </TableCell>
                          )}
                          <TableCell className={cn('px-4 py-2.5 text-right text-sm font-black tabular-nums text-primary', !showCompare && 'pr-6 border-l border-border')}>
                            {rowTotal(f).toLocaleString()}
                          </TableCell>
                          {showCompare && (() => {
                            const d = (f.units || 0) - planOf(f);
                            return (
                              <TableCell className={cn(
                                'px-4 py-2.5 text-right text-sm font-bold tabular-nums',
                                d === 0 ? 'text-muted-foreground/40'
                                  : d > 0 ? 'text-emerald-600 dark:text-emerald-400'
                                  : 'text-amber-600 dark:text-amber-400'
                              )}>
                                {d === 0 ? '—' : `${d > 0 ? '+' : '−'}${Math.abs(d).toLocaleString()}`}
                              </TableCell>
                            );
                          })()}
                          {showCompare && (() => {
                            const bk = backedOf(f);
                            const pct = f.units > 0 ? Math.round((bk / f.units) * 100) : 0;
                            return (
                              <TableCell className="px-4 pr-6 py-2.5 text-right text-sm tabular-nums border-l border-border whitespace-nowrap">
                                {bk > 0 ? (
                                  <>
                                    <span className="font-bold text-emerald-600 dark:text-emerald-400">{bk.toLocaleString()}</span>
                                    {/* the separator is REAL text, not margin: without it the cell's
                                        textContent reads "13,744100%" to a screen reader and to
                                        anything that copies the table */}
                                    <span className="text-[10px] font-bold text-muted-foreground"> · {pct}%</span>
                                  </>
                                ) : (
                                  <span className="text-muted-foreground/40" title="Nothing booked — this week rests entirely on PO dates">—</span>
                                )}
                              </TableCell>
                            );
                          })()}
                        </TableRow>

                        {/* PO# drill-down. Σ these units === the week's total by
                            construction (the controller derives both from the same
                            mutually-exclusive parts), so the detail can never
                            disagree with the row it opened. `stage` travels with
                            each line because at this grain it is the difference
                            between cargo on the water and a PO nobody has booked. */}
                        {isOpen && lines.length > 0 && (
                          <TableRow className="border-b border-border bg-muted/20 hover:bg-muted/20">
                            <TableCell colSpan={columns.length + (showCompare ? 5 : 2)} className="p-0">
                              <div className="px-6 py-4">
                                <p className="mb-2 text-[10px] font-black uppercase tracking-widest text-muted-foreground">
                                  {f.week} — {lines.length} PO line{lines.length === 1 ? '' : 's'} arriving (Actual)
                                </p>
                                <div className="overflow-x-auto">
                                  <table className="w-full text-xs">
                                    <thead>
                                      <tr className="text-left text-[10px] font-black uppercase tracking-wider text-muted-foreground border-b border-border">
                                        <th className="py-1.5 pr-4">PO #</th>
                                        <th className="py-1.5 pr-4">TRN</th>
                                        <th className="py-1.5 pr-4">Supplier</th>
                                        <th className="py-1.5 pr-4">Mode</th>
                                        <th className="py-1.5 pr-4">Warehouse</th>
                                        <th className="py-1.5 pr-4">Channel</th>
                                        <th className="py-1.5 pr-4">Stage</th>
                                        <th className="py-1.5 pr-4">Planned</th>
                                        <th className="py-1.5 pr-4">Actual</th>
                                        <th className="py-1.5 pr-4">Slip</th>
                                        <th className="py-1.5 pr-4 text-right">Units</th>
                                        <th className="py-1.5 text-right">Cartons</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {lines.map((l, li) => {
                                        // "Overdue" only means anything for units that have NOT
                                        // moved yet — a Received or In Transit line already has a
                                        // real date, however late it turned out to be. A cancelled
                                        // consignment's units are back to not-moving, so they can
                                        // be overdue again.
                                        const unmoved = !BACKED_STAGES.has(l.stage);
                                        const overdue = unmoved && l.actual_date && l.actual_date < todayIso;
                                        const slip = l.slip_days ?? 0;
                                        return (
                                          <tr key={`${l.leg_id}-${l.shipment_id ?? 'proj'}-${li}`} className="border-b border-border/40 last:border-0">
                                            <td className="py-1.5 pr-4 font-bold text-foreground whitespace-nowrap">{l.po_number}</td>
                                            <td className="py-1.5 pr-4 text-muted-foreground whitespace-nowrap">{l.trn_number || '—'}</td>
                                            <td className="py-1.5 pr-4 text-foreground">{l.supplier || '—'}</td>
                                            <td className="py-1.5 pr-4 text-muted-foreground whitespace-nowrap">{l.mode || '—'}</td>
                                            <td className="py-1.5 pr-4 text-muted-foreground whitespace-nowrap">{l.warehouse}</td>
                                            <td className="py-1.5 pr-4 text-muted-foreground whitespace-nowrap">{l.channel}</td>
                                            <td className="py-1.5 pr-4 whitespace-nowrap">
                                              <span className={cn('px-1.5 py-0.5 rounded text-[10px] font-black uppercase tracking-wide', STAGE_STYLE[l.stage] || 'bg-muted text-muted-foreground')}>
                                                {l.stage}
                                              </span>
                                              {l.shipment_number && (
                                                <span className="ml-1.5 text-[10px] font-medium text-muted-foreground">{l.shipment_number}</span>
                                              )}
                                            </td>
                                            <td className="py-1.5 pr-4 text-muted-foreground whitespace-nowrap">{l.plan_date || '—'}</td>
                                            <td className="py-1.5 pr-4 text-foreground whitespace-nowrap">
                                              {l.actual_date || '—'}
                                              {overdue && (
                                                <span
                                                  className="ml-1.5 text-[9px] font-black uppercase text-amber-600 dark:text-amber-400"
                                                  title="Expected delivery has already passed and this quantity has not shipped"
                                                >
                                                  overdue
                                                </span>
                                              )}
                                            </td>
                                            <td className={cn(
                                              'py-1.5 pr-4 whitespace-nowrap font-bold tabular-nums',
                                              slip === 0 ? 'text-muted-foreground/40'
                                                : slip > 0 ? 'text-amber-600 dark:text-amber-400'
                                                : 'text-emerald-600 dark:text-emerald-400'
                                            )} title={slip === 0 ? 'Arrived in its planned week, or not yet committed' : `${Math.abs(slip)} days ${slip > 0 ? 'late' : 'early'} against the PO's stated date`}>
                                              {slip === 0 ? '—' : `${slip > 0 ? '+' : '−'}${Math.abs(slip)}d`}
                                            </td>
                                            <td className="py-1.5 pr-4 text-right font-semibold tabular-nums text-foreground">{(l.units || 0).toLocaleString()}</td>
                                            <td className={cn('py-1.5 text-right tabular-nums', l.cartons > 0 ? 'font-semibold text-foreground' : 'text-muted-foreground/40')}>
                                              {l.cartons > 0 ? l.cartons.toLocaleString() : '—'}
                                            </td>
                                          </tr>
                                        );
                                      })}
                                    </tbody>
                                  </table>
                                </div>
                              </div>
                            </TableCell>
                          </TableRow>
                        )}
                      </React.Fragment>
                    );
                  })}
                </TableBody>
                <tfoot>
                  <TableRow className="bg-primary/[0.06] border-t-2 border-border font-black">
                    <TableCell className="py-3 pl-6 sticky left-0 bg-primary/[0.06] z-10 text-[10px] uppercase tracking-widest text-primary">Total</TableCell>
                    {colTotals.map((t, idx) => (
                      <TableCell key={columns[idx]} className="px-4 py-3 text-right text-sm tabular-nums text-foreground">{t > 0 ? t.toLocaleString() : '—'}</TableCell>
                    ))}
                    {showCompare && (
                      <TableCell className="px-4 py-3 text-right text-sm tabular-nums text-muted-foreground border-l border-border">{totalPlan.toLocaleString()}</TableCell>
                    )}
                    <TableCell className={cn('px-4 py-3 text-right text-sm tabular-nums text-primary', !showCompare && 'pr-6 border-l border-border')}>{grandTotal.toLocaleString()}</TableCell>
                    {showCompare && (
                      <TableCell className="px-4 py-3 text-right text-sm tabular-nums text-muted-foreground" title="The two series cover the same order book; the gap is genuine over-shipment on three legs">
                        {totalUnits - totalPlan === 0 ? '—' : `${totalUnits - totalPlan > 0 ? '+' : '−'}${Math.abs(totalUnits - totalPlan).toLocaleString()}`}
                      </TableCell>
                    )}
                    {showCompare && (
                      <TableCell className="px-4 pr-6 py-3 text-right text-sm tabular-nums border-l border-border whitespace-nowrap">
                        <span className="font-bold text-emerald-600 dark:text-emerald-400">{totalBacked.toLocaleString()}</span>
                        <span className="text-[10px] font-bold text-muted-foreground"> · {confidencePct}%</span>
                      </TableCell>
                    )}
                  </TableRow>
                </tfoot>
              </Table>
            </div>
          )}
        </div>

      </div>
    </div>
  );
}
