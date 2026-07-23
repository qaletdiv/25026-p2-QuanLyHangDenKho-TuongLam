'use client';

import React, { useMemo, useRef, useState } from 'react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { TrendingUp, PackageSearch, Boxes, CalendarClock, Building2, Boxes as BoxesIcon, Package } from 'lucide-react';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
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

export default function ForecastClient({ forecast }: { forecast: any[] }) {
  const chartRef = useRef<HTMLDivElement>(null);
  const breakdownRef = useRef<HTMLDivElement>(null);
  const totalCartons = useMemo(() => forecast.reduce((sum, item) => sum + item.cartons, 0), [forecast]);
  const totalUnits   = useMemo(() => forecast.reduce((sum, item) => sum + item.units,   0), [forecast]);

  const peakWeek = useMemo(() => {
    if (!forecast.length) return { week: '—', units: 0 };
    return forecast.reduce((max, f) => f.units > max.units ? f : max, forecast[0]);
  }, [forecast]);

  // Breakdown matrix toggles: metric (units/cartons) and dimension (warehouse only
  // vs warehouse × allocation channel). The controller emits both `warehouses` and
  // `warehouse_channels` maps per week; `bkKey` selects which one the matrix reads.
  const [metric, setMetric] = useState<'units' | 'cartons'>('units');
  const [breakdown, setBreakdown] = useState<'warehouse' | 'channel'>('warehouse');
  const bkKey = breakdown === 'channel' ? 'warehouse_channels' : 'warehouses';

  // Destinations KPI = distinct warehouses (always facility-level, regardless of toggle).
  const warehouseCount = useMemo(() => {
    const whs = new Set<string>();
    forecast.forEach(f => Object.keys(f.warehouses || {}).forEach(w => whs.add(w)));
    return whs.size;
  }, [forecast]);

  // Matrix columns: the union of keys in the SELECTED breakdown map across every week.
  const columns = useMemo(() => {
    const cols = new Set<string>();
    forecast.forEach(f => Object.keys(f[bkKey] || {}).forEach(c => cols.add(c)));
    return Array.from(cols).sort();
  }, [forecast, bkKey]);

  // Cell value for (week, column) in the selected metric. Tolerates the legacy
  // shape where a value was a bare units number.
  const cell = (f: any, col: string): number => {
    const v = f[bkKey]?.[col];
    if (v == null) return 0;
    if (typeof v === 'object') return v[metric] || 0;
    return metric === 'units' ? v : 0;
  };

  // Column totals and grand total in the selected metric.
  const colTotals = useMemo(() =>
    columns.map(col => forecast.reduce((sum, f) => sum + cell(f, col), 0)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [forecast, columns, metric, bkKey]);
  const grandTotal = useMemo(() => forecast.reduce((sum, f) => sum + (f[metric] || 0), 0), [forecast, metric]);

  const chartData = useMemo(() => forecast.map(f => ({
    week: f.week.split(' - ')[0],
    Cartons: f.cartons,
    Units: f.units,
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
              <p className="text-sm mt-0.5 text-primary-foreground/70">Projected inbound shipments and volume spikes based on ETAs.</p>
            </div>
            <div className="sm:ml-auto">
              <div className="px-4 py-1.5 rounded-full text-xs font-black uppercase tracking-widest bg-primary-foreground/20 text-primary-foreground border border-primary-foreground/30">
                {forecast.length} Weeks Scheduled
              </div>
            </div>
          </div>
        </div>

        {/* KPI Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4 animate-in fade-in slide-in-from-bottom-6 duration-500">

          {/* Total Cartons — hero */}
          <div className="rounded-2xl p-6 shadow-2xl relative overflow-hidden bg-primary border border-primary/50">
            <div className="absolute -right-4 -top-4 opacity-10">
              <Boxes className="w-24 h-24 text-primary-foreground" />
            </div>
            <div className="relative z-10 space-y-1">
              <p className="text-xs font-black uppercase tracking-widest text-primary-foreground/75">Total Cartons</p>
              <p className="text-3xl font-black text-primary-foreground">{totalCartons.toLocaleString()}</p>
              <p className="text-xs font-medium text-primary-foreground/60">inbound pipeline</p>
            </div>
          </div>

          {/* Total Units */}
          <div className="rounded-2xl p-6 shadow-2xl bg-card border border-border">
            <div className="flex justify-between items-start">
              <div className="space-y-1">
                <p className="text-xs font-black uppercase tracking-widest text-muted-foreground">Total Units</p>
                <p className="text-3xl font-black text-foreground">{totalUnits.toLocaleString()}</p>
                <p className="text-xs font-medium text-muted-foreground">across all weeks</p>
              </div>
              <div className="p-3 rounded-xl bg-primary/15">
                <PackageSearch className="w-5 h-5 text-primary" />
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

          {/* Destinations */}
          <div className="rounded-2xl p-6 shadow-2xl bg-card border border-border">
            <div className="flex justify-between items-start">
              <div className="space-y-1">
                <p className="text-xs font-black uppercase tracking-widest text-muted-foreground">Destinations</p>
                <p className="text-3xl font-black text-foreground">{warehouseCount}</p>
                <p className="text-xs font-medium text-muted-foreground">active warehouses</p>
              </div>
              <div className="p-3 rounded-xl bg-accent/15">
                <Building2 className="w-5 h-5 text-accent" />
              </div>
            </div>
          </div>
        </div>

        {/* Area Chart */}
        <div ref={chartRef} className="rounded-2xl shadow-2xl overflow-hidden animate-in fade-in slide-in-from-bottom-8 duration-700 bg-card border border-border">
          <div className="px-6 pt-5 pb-2 flex items-start justify-between gap-4">
            <div>
              <p className="text-base font-black text-foreground">Weekly Inbound Volume</p>
              <p className="text-xs mt-0.5 text-muted-foreground">Projected units and cartons arriving per week</p>
            </div>
            <CopyImageButton target={chartRef} name="Weekly Inbound Volume" />
          </div>
          <div className="px-4 pb-5">
            <div className="h-[350px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chartData} margin={{ top: 10, right: 30, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="fillUnits" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%"  stopColor="var(--chart-1)" stopOpacity={0.5} />
                      <stop offset="95%" stopColor="var(--chart-1)" stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="fillCartons" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%"  stopColor="var(--chart-2)" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="var(--chart-2)" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--color-border)" />
                  <XAxis dataKey="week" axisLine={false} tickLine={false} tick={{ fill: 'var(--color-muted-foreground)', fontWeight: 600, fontSize: 12 }} dy={10} />
                  <YAxis axisLine={false} tickLine={false} tick={{ fill: 'var(--color-muted-foreground)', fontSize: 11 }} dx={-10} />
                  <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={{ color: 'var(--color-primary)', fontWeight: 700 }} itemStyle={{ fontWeight: 700 }} />
                  <Area type="monotone" dataKey="Cartons" stroke="var(--chart-2)" strokeWidth={2} strokeDasharray="5 3" fillOpacity={1} fill="url(#fillCartons)" activeDot={{ r: 4, strokeWidth: 0, fill: 'var(--chart-2)' }} />
                  <Area type="monotone" dataKey="Units"   stroke="var(--chart-1)" strokeWidth={3}                     fillOpacity={1} fill="url(#fillUnits)"   activeDot={{ r: 6, strokeWidth: 0, fill: 'var(--chart-1)' }} />
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
                Weekly inbound {metric} per {breakdown === 'channel' ? 'warehouse + channel' : 'destination warehouse'}
              </p>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <CopyImageButton target={breakdownRef} name="Forecast Breakdown" />
              {/* Breakdown dimension: Warehouse / Warehouse + Channel */}
              <div className="flex items-center rounded-full border border-border p-0.5 bg-muted/30">
                {([['warehouse', 'Warehouse'], ['channel', '+ Channel']] as const).map(([key, label]) => (
                  <button
                    key={key}
                    onClick={() => setBreakdown(key)}
                    className={cn(
                      'flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-xs font-black uppercase tracking-wider transition-colors',
                      breakdown === key ? 'bg-primary text-primary-foreground shadow' : 'text-muted-foreground hover:text-foreground'
                    )}
                  >
                    <Building2 className="w-3.5 h-3.5" />
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
                    <TableHead className="h-11 px-4 pr-6 text-right text-[10px] font-black uppercase tracking-widest text-primary border-l border-border">Total</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {forecast.map((f, i) => (
                    <TableRow key={i} className={cn('border-b border-border/40 hover:bg-primary/5', i % 2 !== 0 && 'bg-primary/[0.02]')}>
                      <TableCell className="py-2.5 pl-6 sticky left-0 bg-card z-10 whitespace-nowrap">
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
                      <TableCell className="px-4 pr-6 py-2.5 text-right text-sm font-black tabular-nums text-primary border-l border-border">{(f[metric] || 0).toLocaleString()}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
                <tfoot>
                  <TableRow className="bg-primary/[0.06] border-t-2 border-border font-black">
                    <TableCell className="py-3 pl-6 sticky left-0 bg-primary/[0.06] z-10 text-[10px] uppercase tracking-widest text-primary">Total</TableCell>
                    {colTotals.map((t, idx) => (
                      <TableCell key={columns[idx]} className="px-4 py-3 text-right text-sm tabular-nums text-foreground">{t > 0 ? t.toLocaleString() : '—'}</TableCell>
                    ))}
                    <TableCell className="px-4 pr-6 py-3 text-right text-sm tabular-nums text-primary border-l border-border">{grandTotal.toLocaleString()}</TableCell>
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
