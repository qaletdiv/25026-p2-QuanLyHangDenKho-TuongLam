'use client';

import { useMemo } from 'react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { TrendingUp, PackageSearch, Boxes, MapPin, CalendarClock, Building2 } from 'lucide-react';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';

const TOOLTIP_STYLE = {
  borderRadius: '12px',
  border: '1px solid var(--color-border)',
  backgroundColor: 'var(--color-card)',
  color: 'var(--color-foreground)',
  boxShadow: '0 10px 40px rgba(0,0,0,0.15)',
};

export default function ForecastClient({ forecast }: { forecast: any[] }) {
  const totalCartons = useMemo(() => forecast.reduce((sum, item) => sum + item.cartons, 0), [forecast]);
  const totalUnits   = useMemo(() => forecast.reduce((sum, item) => sum + item.units,   0), [forecast]);

  const peakWeek = useMemo(() => {
    if (!forecast.length) return { week: '—', units: 0 };
    return forecast.reduce((max, f) => f.units > max.units ? f : max, forecast[0]);
  }, [forecast]);

  const warehouseCount = useMemo(() => {
    const whs = new Set<string>();
    forecast.forEach(f => Object.keys(f.warehouses || {}).forEach(w => whs.add(w)));
    return whs.size;
  }, [forecast]);

  const chartData = useMemo(() => forecast.map(f => ({
    week: f.week.split(' - ')[0],
    Cartons: f.cartons,
    Units: f.units,
  })), [forecast]);

  return (
    <div className="flex h-full min-h-screen bg-background">
      <div className="flex-1 overflow-y-auto p-6 space-y-6">

        {/* Page Header */}
        <div className="animate-in fade-in slide-in-from-bottom-4 duration-300">
          <div className="flex items-center gap-4 rounded-2xl px-6 py-5 bg-primary border border-primary/50">
            <div className="p-3 rounded-xl bg-primary-foreground/15">
              <TrendingUp className="w-6 h-6 text-primary-foreground" />
            </div>
            <div>
              <h1 className="text-2xl font-black text-primary-foreground tracking-tight">Inventory Pipeline Forecast</h1>
              <p className="text-sm mt-0.5 text-primary-foreground/70">Projected inbound shipments and volume spikes based on ETAs.</p>
            </div>
            <div className="ml-auto">
              <div className="px-4 py-1.5 rounded-full text-xs font-black uppercase tracking-widest bg-primary-foreground/20 text-primary-foreground border border-primary-foreground/30">
                {forecast.length} Weeks Scheduled
              </div>
            </div>
          </div>
        </div>

        {/* KPI Cards */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 animate-in fade-in slide-in-from-bottom-6 duration-500">

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
        <div className="rounded-2xl shadow-2xl overflow-hidden animate-in fade-in slide-in-from-bottom-8 duration-700 bg-card border border-border">
          <div className="px-6 pt-5 pb-2">
            <p className="text-base font-black text-foreground">Weekly Inbound Volume</p>
            <p className="text-xs mt-0.5 text-muted-foreground">Projected units and cartons arriving per week</p>
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

        {/* Data Table */}
        <div className="rounded-2xl shadow-2xl overflow-hidden animate-in fade-in slide-in-from-bottom-10 duration-900 bg-card border border-border">
          <div className="px-6 py-5 flex items-center justify-between border-b border-border">
            <div>
              <p className="text-base font-black text-foreground">Forecast Breakdown</p>
              <p className="text-xs mt-0.5 text-muted-foreground">Detailed weekly inbound volume by destination warehouse</p>
            </div>
            <div className="px-4 py-1.5 rounded-full text-xs font-black bg-primary/15 text-primary border border-primary/25">
              {forecast.length} Weeks
            </div>
          </div>
          <Table>
            <TableHeader>
              <TableRow className="bg-primary/10 border-b border-border">
                <TableHead className="h-11 pl-6 w-44 text-[10px] font-black uppercase tracking-widest text-primary">Arriving Week</TableHead>
                <TableHead className="h-11 text-right text-[10px] font-black uppercase tracking-widest text-primary">Cartons</TableHead>
                <TableHead className="h-11 text-right text-[10px] font-black uppercase tracking-widest text-primary">Units</TableHead>
                <TableHead className="h-11 pl-12 text-[10px] font-black uppercase tracking-widest text-primary">Destination Warehouses</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {forecast.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="text-center py-12 text-sm italic text-muted-foreground">No inbound shipments currently scheduled.</TableCell>
                </TableRow>
              ) : (
                forecast.map((f, i) => (
                  <TableRow key={i} className={`transition-colors hover:bg-primary/5 border-b border-border/50 ${i % 2 !== 0 ? 'bg-primary/[0.02]' : ''}`}>
                    <TableCell className="font-black py-4 pl-6">
                      <div className="flex flex-col gap-0.5">
                        <span className="px-2.5 py-1 rounded-md text-xs font-black inline-flex items-center w-fit bg-primary/20 text-primary">
                          {f.week.split(' - ')[0]}
                        </span>
                        <span className="text-[10px] font-medium text-muted-foreground">
                          {f.week.split(' - ').slice(1).join('')}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className="text-right text-sm font-semibold py-4 text-muted-foreground">{f.cartons.toLocaleString()}</TableCell>
                    <TableCell className="text-right text-sm font-black py-4 text-primary">{f.units.toLocaleString()}</TableCell>
                    <TableCell className="py-4 pl-12">
                      <div className="flex flex-wrap gap-2">
                        {Object.entries(f.warehouses || {}).map(([wh, qty]: any) => (
                          <div key={wh} className="flex items-center gap-2 px-3 py-1.5 rounded-lg transition-colors bg-primary/10 border border-primary/20">
                            <MapPin className="w-3 h-3 text-primary" />
                            <span className="text-[11px] font-bold uppercase tracking-tight text-primary">{wh}</span>
                            <div className="w-px h-3 bg-primary/30" />
                            <span className="text-xs font-black text-foreground">{(qty as number).toLocaleString()}</span>
                          </div>
                        ))}
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>

      </div>
    </div>
  );
}
