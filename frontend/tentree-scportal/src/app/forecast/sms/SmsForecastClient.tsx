'use client';

// SMS incoming-quantity forecast — units still to arrive (ordered − received),
// bucketed by ISO week of each PO's Expected Receive Date (NS Due Date), broken
// down by destination facility. Mirrors the mainline forecast's KPI cards / area
// chart / week × destination matrix, with a season filter and copy-as-table.

import { useMemo, useRef, useState } from 'react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { TrendingUp, PackageSearch, CalendarClock, Building2, Filter, AlertTriangle } from 'lucide-react';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { cn } from '@/lib/utils';
import type { SmsForecastRow } from '@/modules/sms/types';
import { facilityLabel, seasonRank } from '@/modules/sms/components/smsStatus';
import CopyButton, { copyTable } from '../../reports/mainline/CopyButton';
import CopyImageButton from '../../reports/CopyImageButton';
import ForecastTabs from '../ForecastTabs';

const fmt = (n: number) => n.toLocaleString('en-US');

const TOOLTIP_STYLE = {
  borderRadius: '12px',
  border: '1px solid var(--color-border)',
  backgroundColor: 'var(--color-card)',
  color: 'var(--color-foreground)',
  boxShadow: '0 10px 40px rgba(0,0,0,0.15)',
};

// ISO week (UTC to stay deterministic across server/client — avoids hydration drift)
function isoWeek(dateStr: string): { weekNo: number; weekYear: number } {
  const d = new Date(dateStr + 'T00:00:00Z');
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((t.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return { weekNo, weekYear: t.getUTCFullYear() };
}

type WeekBucket = {
  key: string; label: string; weekShort: string; sortKey: string;
  units: number; projectedUnits: number; poCount: number; facilities: Record<string, number>;
};

export default function SmsForecastClient({ rows }: { rows: SmsForecastRow[] }) {
  const chartRef = useRef<HTMLDivElement>(null);
  const breakdownRef = useRef<HTMLDivElement>(null);
  const seasons = useMemo(
    () => [...new Set(rows.map((r) => r.season).filter(Boolean) as string[])].sort((a, b) => seasonRank(b) - seasonRank(a)),
    [rows],
  );
  const [season, setSeason] = useState<string>('');
  const activeSeason = season || seasons[0] || '';
  const filtered = useMemo(() => rows.filter((r) => !activeSeason || r.season === activeSeason), [rows, activeSeason]);

  // POs with incoming units but no forecast date at all (no Expected Receive Date
  // AND no HOD) can't be placed on the timeline — surfaced, never silently dropped.
  const undated = useMemo(
    () => filtered.filter((r) => r.incoming_qty > 0 && !r.forecast_date),
    [filtered],
  );
  const undatedUnits = undated.reduce((a, r) => a + r.incoming_qty, 0);

  // Units placed on a PROJECTED date (HOD fallback, because the real Expected
  // Receive Date hasn't synced yet) — flagged so the timeline stays honest.
  const projectedRows = useMemo(
    () => filtered.filter((r) => r.incoming_qty > 0 && r.forecast_date && r.date_basis === 'projected'),
    [filtered],
  );
  const projectedUnits = projectedRows.reduce((a, r) => a + r.incoming_qty, 0);

  const { weeks, facilities } = useMemo(() => {
    const map = new Map<string, WeekBucket>();
    const facs = new Set<string>();
    filtered.forEach((r) => {
      if (r.incoming_qty <= 0 || !r.forecast_date) return;
      const { weekNo, weekYear } = isoWeek(r.forecast_date);
      const key = `${weekYear}-W${String(weekNo).padStart(2, '0')}`;
      let b = map.get(key);
      if (!b) {
        b = { key, label: `W${weekNo} - ${weekYear}`, weekShort: `W${weekNo}`, sortKey: r.forecast_date, units: 0, projectedUnits: 0, poCount: 0, facilities: {} };
        map.set(key, b);
      }
      if (r.forecast_date < b.sortKey) b.sortKey = r.forecast_date;
      const fac = facilityLabel(r.facility) || 'Unknown';
      facs.add(fac);
      b.units += r.incoming_qty;
      if (r.date_basis === 'projected') b.projectedUnits += r.incoming_qty;
      b.poCount += 1;
      b.facilities[fac] = (b.facilities[fac] || 0) + r.incoming_qty;
    });
    return {
      weeks: [...map.values()].sort((a, b) => a.sortKey.localeCompare(b.sortKey)),
      facilities: [...facs].sort(),
    };
  }, [filtered]);

  const totalUnits = weeks.reduce((a, w) => a + w.units, 0);
  const peakWeek = weeks.reduce<WeekBucket | null>((mx, w) => (!mx || w.units > mx.units ? w : mx), null);
  const colTotals = facilities.map((f) => weeks.reduce((a, w) => a + (w.facilities[f] || 0), 0));

  // Total pipeline (dated + undated) so the headline is meaningful even before the
  // Expected Receive Dates have synced (dated units alone can be 0).
  const incomingRows = useMemo(() => filtered.filter((r) => r.incoming_qty > 0), [filtered]);
  const allIncomingUnits = incomingRows.reduce((a, r) => a + r.incoming_qty, 0);
  const allFacilities = useMemo(() => [...new Set(incomingRows.map((r) => facilityLabel(r.facility) || 'Unknown'))], [incomingRows]);

  const chartData = weeks.map((w) => ({ week: w.weekShort, Units: w.units }));

  const copyMatrix = () => copyTable(
    ['Week', ...facilities, 'Total'],
    [
      ...weeks.map((w) => [w.label, ...facilities.map((f) => (w.facilities[f] ? fmt(w.facilities[f]) : '—')), fmt(w.units)]),
      ['Total', ...colTotals.map((t) => (t ? fmt(t) : '—')), fmt(totalUnits)],
    ],
  );

  return (
    <div className="flex h-full min-h-screen bg-background">
      <div className="flex-1 overflow-y-auto p-4 md:p-6 space-y-6">

        <ForecastTabs />

        {/* Header */}
        <div className="flex flex-col gap-4 md:flex-row md:items-center rounded-2xl px-4 py-4 sm:px-6 sm:py-5 bg-primary border border-primary/50">
          <div className="p-3 rounded-xl bg-primary-foreground/15 self-start"><TrendingUp className="w-6 h-6 text-primary-foreground" /></div>
          <div>
            <h1 className="text-xl sm:text-2xl font-black text-primary-foreground tracking-tight">SMS Incoming Forecast</h1>
            <p className="text-sm mt-0.5 text-primary-foreground/70">
              Projected units still to arrive (ordered − received), on the week of each PO&apos;s Expected Receive Date — or HOD (handover) as a projected date until the Due Date syncs.
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
            <div className="px-4 py-1.5 rounded-full text-xs font-black uppercase tracking-widest bg-primary-foreground/20 text-primary-foreground border border-primary-foreground/30">
              {weeks.length} Weeks
            </div>
          </div>
        </div>

        {/* KPI cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4">
          <div className="rounded-2xl p-6 shadow-2xl relative overflow-hidden bg-primary border border-primary/50">
            <div className="absolute -right-4 -top-4 opacity-10"><PackageSearch className="w-24 h-24 text-primary-foreground" /></div>
            <div className="relative z-10 space-y-1">
              <p className="text-xs font-black uppercase tracking-widest text-primary-foreground/75">Incoming Units</p>
              <p className="text-3xl font-black text-primary-foreground">{fmt(allIncomingUnits)}</p>
              <p className="text-xs font-medium text-primary-foreground/60">still to arrive</p>
            </div>
          </div>
          <div className="rounded-2xl p-6 shadow-2xl bg-card border border-border">
            <div className="flex justify-between items-start">
              <div className="space-y-1">
                <p className="text-xs font-black uppercase tracking-widest text-muted-foreground">Peak Week</p>
                <p className="text-3xl font-black text-foreground">{peakWeek?.weekShort || '—'}</p>
                <p className="text-xs font-medium text-primary">{fmt(peakWeek?.units || 0)} units arriving</p>
              </div>
              <div className="p-3 rounded-xl bg-primary/15"><CalendarClock className="w-5 h-5 text-primary" /></div>
            </div>
          </div>
          <div className="rounded-2xl p-6 shadow-2xl bg-card border border-border">
            <div className="flex justify-between items-start">
              <div className="space-y-1">
                <p className="text-xs font-black uppercase tracking-widest text-muted-foreground">Destinations</p>
                <p className="text-3xl font-black text-foreground">{allFacilities.length}</p>
                <p className="text-xs font-medium text-muted-foreground">active facilities</p>
              </div>
              <div className="p-3 rounded-xl bg-accent/15"><Building2 className="w-5 h-5 text-accent" /></div>
            </div>
          </div>
          <div className={cn('rounded-2xl p-6 shadow-2xl border', projectedUnits ? 'bg-amber-500/10 border-amber-500/30' : 'bg-card border-border')}>
            <div className="flex justify-between items-start">
              <div className="space-y-1">
                <p className="text-xs font-black uppercase tracking-widest text-muted-foreground">On Projected Date</p>
                <p className="text-3xl font-black text-foreground">{fmt(projectedUnits)}</p>
                <p className="text-xs font-medium text-muted-foreground">
                  {projectedUnits ? 'units on HOD until Due Date syncs' : 'all on Expected Receive Date'}
                  {undated.length ? ` · ${fmt(undatedUnits)} undated` : ''}
                </p>
              </div>
              <div className={cn('p-3 rounded-xl', projectedUnits ? 'bg-amber-500/20' : 'bg-primary/15')}>
                <AlertTriangle className={cn('w-5 h-5', projectedUnits ? 'text-amber-600' : 'text-primary')} />
              </div>
            </div>
          </div>
        </div>

        {weeks.length === 0 && (
          <div className="rounded-2xl shadow-2xl bg-card border border-border px-6 py-12 text-center">
            <CalendarClock className="w-10 h-10 mx-auto text-muted-foreground/50" />
            <p className="mt-3 text-base font-black text-foreground">No Expected Receive Dates yet</p>
            <p className="mt-1 text-sm text-muted-foreground max-w-xl mx-auto">
              {allIncomingUnits > 0
                ? <>{fmt(allIncomingUnits)} units across {incomingRows.length} PO{incomingRows.length === 1 ? '' : 's'} are waiting to be scheduled. The forecast places each PO on the week of its Expected Receive Date (NetSuite Due Date) — run the SMS NetSuite sync to pull those dates and build the timeline.</>
                : <>No incoming units for {activeSeason || 'this season'}.</>}
            </p>
          </div>
        )}

        {weeks.length > 0 && (<>
        {/* Area chart */}
        <div ref={chartRef} className="rounded-2xl shadow-2xl overflow-hidden bg-card border border-border">
          <div className="px-6 pt-5 pb-2 flex items-start justify-between gap-4">
            <div>
              <p className="text-base font-black text-foreground">Weekly Incoming Volume</p>
              <p className="text-xs mt-0.5 text-muted-foreground">Units expected to arrive per week</p>
            </div>
            <CopyImageButton target={chartRef} name="Weekly Incoming Volume" />
          </div>
          <div className="px-4 pb-5">
            <div className="h-[320px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chartData} margin={{ top: 10, right: 30, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="fillSmsUnits" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="var(--chart-1)" stopOpacity={0.5} />
                      <stop offset="95%" stopColor="var(--chart-1)" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--color-border)" />
                  <XAxis dataKey="week" axisLine={false} tickLine={false} tick={{ fill: 'var(--color-muted-foreground)', fontWeight: 600, fontSize: 12 }} dy={10} />
                  <YAxis axisLine={false} tickLine={false} tick={{ fill: 'var(--color-muted-foreground)', fontSize: 11 }} dx={-10} />
                  <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={{ color: 'var(--color-primary)', fontWeight: 700 }} itemStyle={{ fontWeight: 700 }} formatter={(v: any) => [`${fmt(v)} units`, 'Units']} />
                  <Area type="monotone" dataKey="Units" stroke="var(--chart-1)" strokeWidth={3} fillOpacity={1} fill="url(#fillSmsUnits)" activeDot={{ r: 6, strokeWidth: 0, fill: 'var(--chart-1)' }} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>

        {/* Breakdown matrix — weeks × destination facility (units) */}
        <div ref={breakdownRef} className="rounded-2xl shadow-2xl overflow-hidden bg-card border border-border">
          <div className="px-4 py-4 sm:px-6 sm:py-5 flex flex-wrap items-center justify-between gap-4 border-b border-border">
            <div>
              <p className="text-base font-black text-foreground">Forecast Breakdown</p>
              <p className="text-xs mt-0.5 text-muted-foreground">Weekly incoming units per destination facility</p>
            </div>
            <div className="flex items-center gap-2">
              <CopyImageButton target={breakdownRef} name="Forecast Breakdown" />
              <CopyButton onCopy={copyMatrix} />
            </div>
          </div>
          {weeks.length === 0 || facilities.length === 0 ? (
            <div className="text-center py-12 text-sm italic text-muted-foreground">No incoming units scheduled for {activeSeason || 'this season'}.</div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="bg-primary/10 border-b border-border">
                    <TableHead className="h-11 pl-6 sticky left-0 bg-primary/10 z-10 text-[10px] font-black uppercase tracking-widest text-primary">Week</TableHead>
                    {facilities.map((f) => (
                      <TableHead key={f} className="h-11 px-4 text-right text-[10px] font-black uppercase tracking-tight text-primary whitespace-nowrap">{f}</TableHead>
                    ))}
                    <TableHead className="h-11 px-4 pr-6 text-right text-[10px] font-black uppercase tracking-widest text-primary border-l border-border">Total</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {weeks.map((w, i) => (
                    <TableRow key={w.key} className={cn('border-b border-border/40 hover:bg-primary/5', i % 2 !== 0 && 'bg-primary/[0.02]')}>
                      <TableCell className="py-2.5 pl-6 sticky left-0 bg-card z-10 whitespace-nowrap">
                        <span className="px-2 py-0.5 rounded-md text-xs font-black bg-primary/20 text-primary">{w.weekShort}</span>
                        <span className="ml-1.5 text-[10px] font-medium text-muted-foreground">{w.label.split(' - ')[1]}</span>
                        {w.projectedUnits > 0 && (
                          <span className="ml-1.5 text-[9px] font-bold uppercase text-amber-600" title="Projected from HOD — Expected Receive Date not synced yet">proj</span>
                        )}
                      </TableCell>
                      {facilities.map((f) => {
                        const v = w.facilities[f] || 0;
                        return (
                          <TableCell key={f} className={cn('px-4 py-2.5 text-right text-sm tabular-nums', v > 0 ? 'font-semibold text-foreground' : 'text-muted-foreground/40')}>
                            {v > 0 ? fmt(v) : '—'}
                          </TableCell>
                        );
                      })}
                      <TableCell className="px-4 pr-6 py-2.5 text-right text-sm font-black tabular-nums text-primary border-l border-border">{fmt(w.units)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
                <tfoot>
                  <TableRow className="bg-primary/[0.06] border-t-2 border-border font-black">
                    <TableCell className="py-3 pl-6 sticky left-0 bg-primary/[0.06] z-10 text-[10px] uppercase tracking-widest text-primary">Total</TableCell>
                    {colTotals.map((t, idx) => (
                      <TableCell key={facilities[idx]} className="px-4 py-3 text-right text-sm tabular-nums text-foreground">{t > 0 ? fmt(t) : '—'}</TableCell>
                    ))}
                    <TableCell className="px-4 pr-6 py-3 text-right text-sm tabular-nums text-primary border-l border-border">{fmt(totalUnits)}</TableCell>
                  </TableRow>
                </tfoot>
              </Table>
            </div>
          )}
        </div>
        </>)}

      </div>
    </div>
  );
}
