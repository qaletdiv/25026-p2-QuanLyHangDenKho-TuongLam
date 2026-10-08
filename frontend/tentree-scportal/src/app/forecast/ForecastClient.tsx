'use client';

import React, { useMemo, useRef, useState } from 'react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select';
import { TrendingUp, PackageSearch, CalendarClock, Building2, Boxes as BoxesIcon, Package, Ship, Factory, ShieldCheck, ChevronRight, ChevronDown } from 'lucide-react';
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
// mainlineForecastController's per-week `lines[]`. The forecast is a PIVOT:
// planned units sit in the week of the PO's E-DEL, actual units in the week of
// the SHIPMENT's E-DEL. When the two weeks differ the same part appears as two
// rows (one per week, the other side 0); a blank date leaves its side empty.
type ForecastLine = {
  poNumber: string;
  trnNumber: string | null;
  supplier: string | null;
  mode: string | null;
  legId: string;
  crd: string | null;
  stage: string;
  dateBasis: string | null;
  shipmentId: string | null;
  shipmentNumber: string | null;
  carrierReference: string | null;
  warehouse: string;
  channel: string;
  plannedUnits: number;        // in this week because the PO E-DEL is in it
  actualUnits: number;         // in this week because the shipment E-DEL is in it
  cartons: number;             // with the actual units only (packing list)
  planDate: string | null;     // PO leg E-DEL
  planWeek: string | null;
  actualDate: string | null;   // shipment E-DEL; null with no shipment or no E-DEL yet
  slipDays: number | null;     // only when BOTH dates exist
};

// One breakdown cell, and one series (planned or actual) of a week.
type Cell = { units: number; cartons: number };
type Series = {
  units: number;
  cartons: number;
  warehouses: Record<string, Cell>;
  warehouseChannels: Record<string, Cell>;
  suppliers: Record<string, Cell>;
};
// The three dimensions the matrix can toggle between. PO# is deliberately absent
// — it is the row drill-down, not a column set.
type BreakdownKey = 'warehouses' | 'warehouseChannels' | 'suppliers';

// A forecast week: the same order book on two dates. `plan` and `actual` are
// NOT mutually exclusive — never add them. Σ lines.plannedUnits === plan.units
// and Σ lines.actualUnits === actual.units by construction.
export type ForecastWeek = {
  week: string;
  weekNum: number;
  plan: Series;
  actual: Series;
  lines: ForecastLine[];
};

// A line whose units are on a shipment (landed or not).
const SHIPPED_STAGES = new Set(['Received', 'In Transit']);

// Stage → pill styling, in confidence order: landed, shipped, approved with no
// consignment carrying it (its shipment was cancelled), booked but unapproved,
// and nobody has booked it.
const STAGE_STYLE: Record<string, string> = {
  'Received':            'bg-emerald-500/20 text-emerald-700 dark:text-emerald-400',
  'In Transit':          'bg-primary/20 text-primary',
  'Booked — Not Shipped': 'bg-sky-500/20 text-sky-700 dark:text-sky-400',
  'Booking Pending':     'bg-amber-500/20 text-amber-700 dark:text-amber-400',
  'Awaiting Booking':    'bg-muted text-muted-foreground',
};

const fmt = (n: number) => (n > 0 ? n.toLocaleString() : '—');

// Drill-down filters. The column header IS the filter (same convention as the
// PO leg detail): unset it reads the column name, set it reads the value. One
// shared state, so a filter chosen in any week applies to every open week.
type LineFilterKey = 'supplier' | 'mode' | 'warehouse' | 'channel' | 'stage';
type LineFilters = Record<LineFilterKey, string>;
const NO_FILTERS: LineFilters = { supplier: 'all', mode: 'all', warehouse: 'all', channel: 'all', stage: 'all' };
const STAGE_ORDER = Object.keys(STAGE_STYLE);

// SelectItem hard-codes `shrink-0 whitespace-nowrap` on its text (ui/select.tsx),
// so a long supplier name would be clipped at the column width. These options
// override it on the direct children (*:) so names WRAP inside a list no wider
// than the column, without changing the shared component for every other Select.
const FILTER_ITEM = 'text-xs py-1 pr-6 leading-tight *:min-w-0 *:shrink *:whitespace-normal *:break-words';

function HeaderFilter({ label, value, options, onChange }: {
  label: string; value: string; options: string[]; onChange: (v: string) => void;
}) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v ?? 'all')}>
      {/* Label rendered directly: SelectValue cannot derive one when the value
          is set programmatically (see CLAUDE.md). */}
      <SelectTrigger
        title={value === 'all' ? `Filter by ${label.toLowerCase()}` : `${label}: ${value}`}
        className={cn('h-6 w-full px-0 gap-1 border-0 bg-transparent dark:bg-transparent shadow-none hover:text-foreground focus-visible:ring-1 text-[10px] font-black uppercase tracking-wider',
          value === 'all' ? 'text-muted-foreground' : 'text-primary normal-case tracking-normal')}
        onClick={(e) => e.stopPropagation()}
      >
        <span className="truncate">{value === 'all' ? label : value}</span>
      </SelectTrigger>
      {/* Opens BELOW the header. The default (alignItemWithTrigger) lays the list
          over the trigger to line up the selected option, which covered the header.
          min-w-0 drops the 144px floor so the list is never wider than its column
          (it is already w-(--anchor-width)); long names wrap instead. */}
      <SelectContent alignItemWithTrigger={false} side="bottom" align="start" sideOffset={4} className="min-w-0">
        <SelectItem value="all" className={FILTER_ITEM}>All {label.toLowerCase()}s</SelectItem>
        {options.map((o) => <SelectItem key={o} value={o} className={FILTER_ITEM}>{o}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

export default function ForecastClient({ seasons, bySeason }: { seasons: string[]; bySeason: Record<string, ForecastWeek[]> }) {
  const chartRef = useRef<HTMLDivElement>(null);
  const breakdownRef = useRef<HTMLDivElement>(null);

  // Season scope. Defaults to the newest season PRESENT IN THE ORDER BOOK (the
  // server already sorted them newest-first). The rollup for every season is
  // pre-computed server-side, so switching is a lookup and each view reconciles.
  const [season, setSeason] = useState<string>(() => seasons[0] || 'all');
  // Memoised: the `||` fallback would otherwise mint a new array identity on
  // every render and defeat every useMemo below it.
  const forecast: ForecastWeek[] = useMemo(
    () => bySeason[season] || bySeason.all || [], [bySeason, season]);

  const totalPlan    = useMemo(() => forecast.reduce((s, f) => s + (f.plan?.units ?? 0), 0), [forecast]);
  const totalActual  = useMemo(() => forecast.reduce((s, f) => s + (f.actual?.units ?? 0), 0), [forecast]);
  const totalCartons = useMemo(() => forecast.reduce((s, f) => s + (f.actual?.cartons ?? 0), 0), [forecast]);

  const allLines: ForecastLine[] = useMemo(() => forecast.flatMap((f) => f.lines || []), [forecast]);

  // Already in the warehouse vs still to come, measured against the PLAN: the
  // planned units of received parts are the ones no longer outstanding.
  const receivedPlanned = useMemo(
    () => allLines.filter((l) => l.stage === 'Received').reduce((s, l) => s + l.plannedUnits, 0), [allLines]);
  const receivedActual = useMemo(
    () => allLines.filter((l) => l.stage === 'Received').reduce((s, l) => s + l.actualUnits, 0), [allLines]);
  const toArriveUnits = totalPlan - receivedPlanned;

  // Slip exists only where a line has both dates; counted once, on the actual row.
  const slipLater = useMemo(
    () => allLines.filter((l) => (l.slipDays ?? 0) > 0).reduce((s, l) => s + l.actualUnits, 0), [allLines]);
  const slipEarlier = useMemo(
    () => allLines.filter((l) => (l.slipDays ?? 0) < 0).reduce((s, l) => s + l.actualUnits, 0), [allLines]);

  const peakWeek = useMemo(() => {
    if (!forecast.length) return { week: '—', units: 0 };
    return forecast.reduce((max, f) => (f.plan.units > max.units ? { week: f.week, units: f.plan.units } : max),
      { week: forecast[0].week, units: forecast[0].plan.units });
  }, [forecast]);

  // Share of the planned order book a shipment has dated.
  const datedPct = totalPlan > 0 ? Math.round((totalActual / totalPlan) * 100) : 0;

  // Breakdown matrix toggles: metric, dimension, and which SIDE of the pivot the
  // breakdown cells show. Cartons exist only on the actual side (a plan has none),
  // so the Cartons metric always reads Actual.
  const [metric, setMetric] = useState<'units' | 'cartons'>('units');
  const [breakdown, setBreakdown] = useState<'warehouse' | 'channel' | 'supplier'>('warehouse');
  const [side, setSide] = useState<'plan' | 'actual'>('plan');
  const seriesKey: 'plan' | 'actual' = metric === 'cartons' ? 'actual' : side;
  const bkKey: BreakdownKey = breakdown === 'channel' ? 'warehouseChannels'
              : breakdown === 'supplier' ? 'suppliers'
              : 'warehouses';

  // Expanded weeks for the PO# drill-down, keyed by week label.
  const [openWeeks, setOpenWeeks] = useState<Set<string>>(() => new Set());
  const toggleWeek = (week: string) => setOpenWeeks((prev) => {
    const next = new Set(prev);
    if (next.has(week)) next.delete(week); else next.add(week);
    return next;
  });

  const [lineFilters, setLineFilters] = useState<LineFilters>(NO_FILTERS);
  const setFilter = (k: LineFilterKey) => (v: string) => setLineFilters((prev) => ({ ...prev, [k]: v }));
  const filtersActive = (Object.keys(lineFilters) as LineFilterKey[]).some((k) => lineFilters[k] !== 'all');
  // Options = the values present in the current season's lines (plus a value
  // already selected, so switching season never strands the filter unlabeled).
  const filterOptions = useMemo(() => {
    const pick = (k: LineFilterKey, get: (l: ForecastLine) => string | null) => {
      const set = new Set(allLines.map(get).filter((v): v is string => !!v));
      if (lineFilters[k] !== 'all') set.add(lineFilters[k]);
      return [...set];
    };
    return {
      supplier: pick('supplier', (l) => l.supplier).sort(),
      mode: pick('mode', (l) => l.mode).sort(),
      warehouse: pick('warehouse', (l) => l.warehouse).sort(),
      channel: pick('channel', (l) => l.channel).sort(),
      stage: pick('stage', (l) => l.stage).sort((a, b) => STAGE_ORDER.indexOf(a) - STAGE_ORDER.indexOf(b)),
    };
  }, [allLines, lineFilters]);
  const matches = (l: ForecastLine) =>
    (lineFilters.supplier === 'all' || l.supplier === lineFilters.supplier)
    && (lineFilters.mode === 'all' || l.mode === lineFilters.mode)
    && (lineFilters.warehouse === 'all' || l.warehouse === lineFilters.warehouse)
    && (lineFilters.channel === 'all' || l.channel === lineFilters.channel)
    && (lineFilters.stage === 'all' || l.stage === lineFilters.stage);

  // Today at UTC midnight, for the overdue marker on drill-down rows.
  const todayIso = new Date().toISOString().slice(0, 10);

  // Matrix columns: the union of keys in the selected side's breakdown map.
  const columns = useMemo(() => {
    const cols = new Set<string>();
    forecast.forEach(f => Object.keys(f[seriesKey]?.[bkKey] || {}).forEach(c => cols.add(c)));
    return Array.from(cols).sort();
  }, [forecast, bkKey, seriesKey]);

  const cell = (f: ForecastWeek, col: string): number => f[seriesKey]?.[bkKey]?.[col]?.[metric] ?? 0;

  const colTotals = useMemo(() =>
    columns.map(col => forecast.reduce((sum, f) => sum + cell(f, col), 0)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [forecast, columns, metric, bkKey, seriesKey]);

  // Planned / Actual / Δ compare UNITS; a plan has no cartons.
  const showCompare = metric === 'units';
  const extraCols = showCompare ? 3 : 1;

  // Two lines, not a stack: Planned (dashed) is where the POs put the units,
  // Actual (solid) is where shipments put them.
  const chartData = useMemo(() => forecast.map(f => ({
    week: f.week.split(' - ')[0],
    Planned: f.plan?.units ?? 0,
    Actual: f.actual?.units ?? 0,
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
              <p className="text-sm mt-0.5 text-primary-foreground/70">Planned (PO E-DEL) vs actual (shipment E-DEL), week by week.</p>
            </div>
            <div className="sm:ml-auto flex items-center gap-3">
              {/* Season scope — governs the WHOLE page. Only seasons the order
                  book actually holds are offered. */}
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

          {/* Planned units — the order book. */}
          <div className="rounded-2xl p-6 shadow-2xl relative overflow-hidden bg-primary border border-primary/50">
            <div className="absolute -right-4 -top-4 opacity-10">
              <PackageSearch className="w-24 h-24 text-primary-foreground" />
            </div>
            <div className="relative z-10 space-y-1">
              <p className="text-xs font-black uppercase tracking-widest text-primary-foreground/75">Planned Units</p>
              <p className="text-3xl font-black text-primary-foreground">{totalPlan.toLocaleString()}</p>
              <p className="text-xs font-medium text-primary-foreground/60">
                full order book · {totalActual.toLocaleString()} actual
              </p>
            </div>
          </div>

          {/* Still to arrive, against the plan. */}
          <div className="rounded-2xl p-6 shadow-2xl bg-card border border-border">
            <div className="flex justify-between items-start">
              <div className="space-y-1">
                <p className="text-xs font-black uppercase tracking-widest text-muted-foreground">Still to Arrive</p>
                <p className="text-3xl font-black text-foreground">{toArriveUnits.toLocaleString()}</p>
                <p className="text-xs font-medium text-muted-foreground">
                  {receivedActual.toLocaleString()} already received
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

          {/* Peak planned week */}
          <div className="rounded-2xl p-6 shadow-2xl bg-card border border-border">
            <div className="flex justify-between items-start">
              <div className="space-y-1">
                <p className="text-xs font-black uppercase tracking-widest text-muted-foreground">Peak Week</p>
                <p className="text-3xl font-black text-foreground">{peakWeek.week.split(' - ')[0] || '—'}</p>
                <p className="text-xs font-medium text-primary">{peakWeek.units.toLocaleString()} units planned</p>
              </div>
              <div className="p-3 rounded-xl bg-primary/15">
                <CalendarClock className="w-5 h-5 text-primary" />
              </div>
            </div>
          </div>

          {/* How much of the plan a shipment has dated. */}
          <div className="rounded-2xl p-6 shadow-2xl bg-card border border-border">
            <div className="flex justify-between items-start">
              <div className="space-y-1">
                <p className="text-xs font-black uppercase tracking-widest text-muted-foreground">Shipment-Dated</p>
                <p className={cn('text-3xl font-black',
                  datedPct >= 50 ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400')}>
                  {datedPct}%
                </p>
                <p className="text-xs font-medium text-muted-foreground">
                  {totalActual.toLocaleString()} units with a shipment E-DEL
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
                Units per week — dashed is the PO E-DEL (planned), solid is the shipment E-DEL (actual)
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
                  {/* Planned is UNFILLED, dashed and NEUTRAL so the two lines never
                      read as a stacked sum; chart-1 and chart-2 are both reds in
                      the active theme, so colour alone would not separate them. */}
                  <Area type="monotone" dataKey="Planned" stroke="var(--color-muted-foreground)" strokeWidth={2} strokeDasharray="5 3" fill="none" activeDot={{ r: 4, strokeWidth: 0, fill: 'var(--color-muted-foreground)' }} />
                  <Area type="monotone" dataKey="Actual"  stroke="var(--chart-1)" strokeWidth={3} fillOpacity={1} fill="url(#fillActual)" activeDot={{ r: 6, strokeWidth: 0, fill: 'var(--chart-1)' }} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>

        {/* Breakdown matrix — weeks (rows) × warehouse[/channel]/supplier (columns) */}
        <div ref={breakdownRef} className="rounded-2xl shadow-2xl overflow-hidden animate-in fade-in slide-in-from-bottom-10 duration-900 bg-card border border-border">
          <div className="px-6 py-5 flex items-center justify-between gap-4 border-b border-border flex-wrap">
            <div>
              <p className="text-base font-black text-foreground">Forecast Breakdown</p>
              <p className="text-xs mt-0.5 text-muted-foreground">
                {metric === 'cartons' ? 'Packed cartons (actual)' : seriesKey === 'plan' ? 'Planned units (PO E-DEL)' : 'Actual units (shipment E-DEL)'} per{' '}
                {breakdown === 'channel' ? 'warehouse + channel' : breakdown === 'supplier' ? 'supplier' : 'destination warehouse'}
                {' · '}open a week for the PO breakdown
              </p>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <CopyImageButton target={breakdownRef} name="Forecast Breakdown" />
              {/* Breakdown dimension */}
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
              {/* Which side of the pivot the breakdown cells show. Cartons are
                  actual-only, so this toggle is inert for the Cartons metric. */}
              <div className={cn('flex items-center rounded-full border border-border p-0.5 bg-muted/30', metric === 'cartons' && 'opacity-50')}>
                {([['plan', 'Planned', CalendarClock], ['actual', 'Actual', Ship]] as const).map(([key, label, Icon]) => (
                  <button
                    key={key}
                    disabled={metric === 'cartons'}
                    onClick={() => setSide(key)}
                    className={cn(
                      'flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-xs font-black uppercase tracking-wider transition-colors',
                      seriesKey === key ? 'bg-primary text-primary-foreground shadow' : 'text-muted-foreground hover:text-foreground'
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
          {metric === 'cartons' && forecast.length > 0 && (
            <div className="px-6 py-3 text-xs text-muted-foreground border-b border-border bg-amber-500/5">
              <span className="font-bold text-foreground">Cartons cover shipped units only.</span>{' '}
              A carton is known once a packing list is uploaded, so there is no planned figure to compare against.
              Switch to <span className="font-bold">Units</span> for Planned vs Actual.
            </div>
          )}
          {forecast.length === 0 ? (
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
                    {showCompare ? (
                      <>
                        <TableHead className="h-11 px-4 text-right text-[10px] font-black uppercase tracking-widest text-muted-foreground border-l border-border whitespace-nowrap" title="Units whose PO E-DEL falls in this week">
                          Planned
                        </TableHead>
                        <TableHead className="h-11 px-4 text-right text-[10px] font-black uppercase tracking-widest text-primary whitespace-nowrap" title="Units whose shipment E-DEL falls in this week">
                          Actual
                        </TableHead>
                        <TableHead className="h-11 px-4 pr-6 text-right text-[10px] font-black uppercase tracking-widest text-primary whitespace-nowrap" title="Actual − Planned for this week">
                          Δ
                        </TableHead>
                      </>
                    ) : (
                      <TableHead className="h-11 px-4 pr-6 text-right text-[10px] font-black uppercase tracking-widest text-primary border-l border-border whitespace-nowrap">
                        Total
                      </TableHead>
                    )}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {forecast.map((f, i) => {
                    const lines: ForecastLine[] = f.lines || [];
                    // The week ROW stays unfiltered; the filters narrow its PO lines.
                    const shown = filtersActive ? lines.filter(matches) : lines;
                    const isOpen = openWeeks.has(f.week);
                    const planned = f.plan?.units ?? 0;
                    const actual = f.actual?.units ?? 0;
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
                                {fmt(v)}
                              </TableCell>
                            );
                          })}
                          {showCompare ? (
                            <>
                              <TableCell className="px-4 py-2.5 text-right text-sm tabular-nums text-muted-foreground border-l border-border">
                                {fmt(planned)}
                              </TableCell>
                              <TableCell className={cn('px-4 py-2.5 text-right text-sm font-black tabular-nums', actual > 0 ? 'text-primary' : 'text-muted-foreground/40')}>
                                {fmt(actual)}
                              </TableCell>
                              {(() => {
                                const d = actual - planned;
                                return (
                                  <TableCell className={cn(
                                    'px-4 pr-6 py-2.5 text-right text-sm font-bold tabular-nums',
                                    d === 0 ? 'text-muted-foreground/40'
                                      : d > 0 ? 'text-emerald-600 dark:text-emerald-400'
                                      : 'text-amber-600 dark:text-amber-400'
                                  )}>
                                    {d === 0 ? '—' : `${d > 0 ? '+' : '−'}${Math.abs(d).toLocaleString()}`}
                                  </TableCell>
                                );
                              })()}
                            </>
                          ) : (
                            <TableCell className="px-4 pr-6 py-2.5 text-right text-sm font-black tabular-nums text-primary border-l border-border">
                              {fmt(f.actual?.cartons ?? 0)}
                            </TableCell>
                          )}
                        </TableRow>

                        {/* PO# drill-down. Σ planned qty === the week's Planned and
                            Σ actual qty === its Actual, by construction. */}
                        {isOpen && lines.length > 0 && (
                          <TableRow className="border-b border-border bg-muted/20 hover:bg-muted/20">
                            <TableCell colSpan={columns.length + 1 + extraCols} className="p-0">
                              <div className="px-6 py-4">
                                <div className="mb-2 flex items-center gap-3">
                                  <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">
                                    {f.week} — {filtersActive ? `${shown.length} of ${lines.length}` : lines.length} PO line{lines.length === 1 ? '' : 's'}
                                  </p>
                                  {filtersActive && (
                                    <button type="button" onClick={() => setLineFilters(NO_FILTERS)}
                                      className="text-[10px] font-bold text-primary hover:underline">
                                      Clear filters
                                    </button>
                                  )}
                                </div>
                                <div className="overflow-x-auto">
                                  {/* table-fixed + one colgroup: every week's drill-down is its own
                                      <table>, and with auto layout each sized its columns to its own
                                      content, so the weeks did not line up. Fixed widths make every
                                      week's columns identical. Supplier has a FIXED width too: as the remainder
                                      column it shrank to ~80px at 1600px, too narrow for its filter list. */}
                                  <table className="w-full min-w-[1246px] table-fixed text-xs">
                                    <colgroup>
                                      <col className="w-[80px]" />{/* PO # */}
                                      <col className="w-[80px]" />{/* TRN */}
                                      <col className="w-[124px]" />{/* Supplier */}
                                      <col className="w-[84px]" />{/* Mode */}
                                      <col className="w-[116px]" />{/* Warehouse */}
                                      <col className="w-[100px]" />{/* Channel */}
                                      <col className="w-[190px]" />{/* Stage */}
                                      <col className="w-[84px]" />{/* Planned date */}
                                      <col className="w-[120px]" />{/* Actual date */}
                                      <col className="w-[56px]" />{/* Slip */}
                                      <col className="w-[76px]" />{/* Planned qty */}
                                      <col className="w-[76px]" />{/* Actual qty */}
                                      <col className="w-[60px]" />{/* Cartons */}
                                    </colgroup>
                                    <thead>
                                      <tr className="text-left text-[10px] font-black uppercase tracking-wider text-muted-foreground border-b border-border">
                                        <th className="py-1.5 pr-4">PO #</th>
                                        <th className="py-1.5 pr-4">TRN</th>
                                        <th className="py-1 pr-4"><HeaderFilter label="Supplier" value={lineFilters.supplier} options={filterOptions.supplier} onChange={setFilter('supplier')} /></th>
                                        <th className="py-1 pr-2"><HeaderFilter label="Mode" value={lineFilters.mode} options={filterOptions.mode} onChange={setFilter('mode')} /></th>
                                        <th className="py-1 pr-2"><HeaderFilter label="Warehouse" value={lineFilters.warehouse} options={filterOptions.warehouse} onChange={setFilter('warehouse')} /></th>
                                        <th className="py-1 pr-2"><HeaderFilter label="Channel" value={lineFilters.channel} options={filterOptions.channel} onChange={setFilter('channel')} /></th>
                                        <th className="py-1 pr-4"><HeaderFilter label="Stage" value={lineFilters.stage} options={filterOptions.stage} onChange={setFilter('stage')} /></th>
                                        <th className="py-1.5 pr-4" title="PO E-DEL">Planned</th>
                                        <th className="py-1.5 pr-4" title="Shipment E-DEL">Actual</th>
                                        <th className="py-1.5 pr-4">Slip</th>
                                        <th className="py-1.5 pr-4 text-right">Planned qty</th>
                                        <th className="py-1.5 pr-4 text-right">Actual qty</th>
                                        <th className="py-1.5 text-right">Cartons</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {shown.length === 0 && (
                                        <tr><td colSpan={13} className="py-3 text-center italic text-muted-foreground">No PO lines in {f.week.split(' - ')[0]} match the filters.</td></tr>
                                      )}
                                      {shown.map((l, li) => {
                                        // Overdue: its PO E-DEL has passed and nothing has shipped.
                                        const overdue = !SHIPPED_STAGES.has(l.stage) && !l.actualDate
                                          && l.planDate && l.planDate < todayIso && l.plannedUnits > 0;
                                        const slip = l.slipDays ?? 0;
                                        return (
                                          <tr key={`${l.legId}-${l.shipmentId ?? 'rem'}-${l.stage}-${li}`} className="border-b border-border/40 last:border-0">
                                            <td className="py-1.5 pr-4 font-bold text-foreground whitespace-nowrap">{l.poNumber}</td>
                                            <td className="py-1.5 pr-4 text-muted-foreground whitespace-nowrap">{l.trnNumber || '—'}</td>
                                            <td className="py-1.5 pr-4 text-foreground truncate" title={l.supplier || undefined}>{l.supplier || '—'}</td>
                                            <td className="py-1.5 pr-4 text-muted-foreground whitespace-nowrap">{l.mode || '—'}</td>
                                            <td className="py-1.5 pr-4 text-muted-foreground truncate" title={l.warehouse}>{l.warehouse}</td>
                                            <td className="py-1.5 pr-4 text-muted-foreground truncate" title={l.channel}>{l.channel}</td>
                                            <td className="py-1.5 pr-4 whitespace-nowrap">
                                              <span className={cn('px-1.5 py-0.5 rounded text-[10px] font-black uppercase tracking-wide', STAGE_STYLE[l.stage] || 'bg-muted text-muted-foreground')}>
                                                {l.stage}
                                              </span>
                                              {l.shipmentNumber && (
                                                <span className="ml-1.5 text-[10px] font-medium text-muted-foreground">{l.shipmentNumber}</span>
                                              )}
                                            </td>
                                            <td className="py-1.5 pr-4 text-muted-foreground whitespace-nowrap">
                                              {l.planDate || <span className="text-muted-foreground/40" title="No PO E-DEL — not planned">—</span>}
                                            </td>
                                            <td className="py-1.5 pr-4 text-foreground whitespace-nowrap">
                                              {l.actualDate || <span className="text-muted-foreground/40" title="No shipment E-DEL yet — set it on the shipment page">—</span>}
                                              {overdue && (
                                                <span
                                                  className="ml-1.5 text-[9px] font-black uppercase text-amber-600 dark:text-amber-400"
                                                  title="The PO E-DEL has passed and this quantity has not shipped"
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
                                            )} title={l.slipDays == null ? 'Needs both a PO E-DEL and a shipment E-DEL' : slip === 0 ? 'Shipment E-DEL equals the PO E-DEL' : `${Math.abs(slip)} days ${slip > 0 ? 'late' : 'early'} against the PO E-DEL`}>
                                              {slip === 0 ? '—' : `${slip > 0 ? '+' : '−'}${Math.abs(slip)}d`}
                                            </td>
                                            <td className={cn('py-1.5 pr-4 text-right tabular-nums', l.plannedUnits > 0 ? 'font-semibold text-foreground' : 'text-muted-foreground/40')}>
                                              {fmt(l.plannedUnits)}
                                            </td>
                                            <td className={cn('py-1.5 pr-4 text-right tabular-nums', l.actualUnits > 0 ? 'font-semibold text-primary' : 'text-muted-foreground/40')}>
                                              {fmt(l.actualUnits)}
                                            </td>
                                            <td className={cn('py-1.5 text-right tabular-nums', l.cartons > 0 ? 'font-semibold text-foreground' : 'text-muted-foreground/40')}>
                                              {fmt(l.cartons)}
                                            </td>
                                          </tr>
                                        );
                                      })}
                                      {/* Subtotal of the ROWS ON SCREEN. The week row above stays
                                          the unfiltered total; this says what the filter narrowed it to. */}
                                      {filtersActive && shown.length > 0 && (
                                        <tr className="border-t border-border font-black">
                                          <td colSpan={10} className="py-1.5 pr-4 text-[10px] uppercase tracking-widest text-muted-foreground">
                                            Filtered total ({shown.length} of {lines.length})
                                          </td>
                                          <td className="py-1.5 pr-4 text-right tabular-nums text-foreground">{fmt(shown.reduce((a, l) => a + l.plannedUnits, 0))}</td>
                                          <td className="py-1.5 pr-4 text-right tabular-nums text-primary">{fmt(shown.reduce((a, l) => a + l.actualUnits, 0))}</td>
                                          <td className="py-1.5 text-right tabular-nums text-foreground">{fmt(shown.reduce((a, l) => a + l.cartons, 0))}</td>
                                        </tr>
                                      )}
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
                      <TableCell key={columns[idx]} className="px-4 py-3 text-right text-sm tabular-nums text-foreground">{fmt(t)}</TableCell>
                    ))}
                    {showCompare ? (
                      <>
                        <TableCell className="px-4 py-3 text-right text-sm tabular-nums text-muted-foreground border-l border-border">{totalPlan.toLocaleString()}</TableCell>
                        <TableCell className="px-4 py-3 text-right text-sm tabular-nums text-primary">{totalActual.toLocaleString()}</TableCell>
                        <TableCell className="px-4 pr-6 py-3 text-right text-sm tabular-nums text-muted-foreground" title="Planned units not yet dated by a shipment (negative), net of any over-shipment">
                          {totalActual - totalPlan === 0 ? '—' : `${totalActual - totalPlan > 0 ? '+' : '−'}${Math.abs(totalActual - totalPlan).toLocaleString()}`}
                        </TableCell>
                      </>
                    ) : (
                      <TableCell className="px-4 pr-6 py-3 text-right text-sm tabular-nums text-primary border-l border-border">{totalCartons.toLocaleString()}</TableCell>
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
