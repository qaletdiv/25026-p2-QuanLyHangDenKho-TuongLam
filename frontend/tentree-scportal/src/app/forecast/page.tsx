'use client';

import { useEffect, useState, useMemo } from 'react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { TrendingUp, PackageSearch, Boxes, MapPin, CalendarClock, Building2 } from 'lucide-react';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';

export default function ForecastPage() {
  const [forecast, setForecast] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    async function fetchForecast() {
      try {
        const res = await fetch('http://127.0.0.1:5000/forecast');
        const data = await res.json();
        setForecast(data || []);
      } catch (e) {
        console.error(e);
      } finally {
        setIsLoading(false);
      }
    }
    fetchForecast();
  }, []);

  const totalCartons = useMemo(() => forecast.reduce((sum, item) => sum + item.cartons, 0), [forecast]);
  const totalUnits = useMemo(() => forecast.reduce((sum, item) => sum + item.units, 0), [forecast]);

  const peakWeek = useMemo(() => {
    if (!forecast.length) return { week: '—', units: 0 };
    return forecast.reduce((max, f) => f.units > max.units ? f : max, forecast[0]);
  }, [forecast]);

  const warehouseCount = useMemo(() => {
    const whs = new Set<string>();
    forecast.forEach(f => Object.keys(f.warehouses || {}).forEach(w => whs.add(w)));
    return whs.size;
  }, [forecast]);

  const chartData = useMemo(() => {
    return forecast.map(f => ({
      week: f.week.split(' - ')[0],
      Cartons: f.cartons,
      Units: f.units,
    }));
  }, [forecast]);

  return (
    <div className="flex h-full min-h-screen" style={{ background: 'linear-gradient(135deg, #1a0000 0%, #2d0505 40%, #1a0000 100%)' }}>
      <div className="flex-1 overflow-y-auto p-6 space-y-6">

        {/* Page Header */}
        <div className="animate-in fade-in slide-in-from-bottom-4 duration-300">
          <div
            className="flex items-center gap-4 rounded-2xl px-6 py-5"
            style={{ background: 'linear-gradient(135deg, #7f1d1d 0%, #991b1b 50%, #7f1d1d 100%)', border: '1px solid #ef4444' }}
          >
            <div className="p-3 rounded-xl" style={{ background: 'rgba(239,68,68,0.3)' }}>
              <TrendingUp className="w-6 h-6" style={{ color: '#fca5a5' }} />
            </div>
            <div>
              <h1 className="text-2xl font-black text-white tracking-tight">Inventory Pipeline Forecast</h1>
              <p className="text-sm mt-0.5" style={{ color: '#fca5a5' }}>Projected inbound shipments and volume spikes based on ETAs.</p>
            </div>
            <div className="ml-auto">
              <div
                className="px-4 py-1.5 rounded-full text-xs font-black uppercase tracking-widest"
                style={{ background: 'rgba(239,68,68,0.25)', color: '#fca5a5', border: '1px solid rgba(239,68,68,0.4)' }}
              >
                {forecast.length} Weeks Scheduled
              </div>
            </div>
          </div>
        </div>

        {/* KPI Cards */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 animate-in fade-in slide-in-from-bottom-6 duration-500">
          {/* Total Cartons — hero card */}
          <div
            className="rounded-2xl p-6 shadow-2xl relative overflow-hidden"
            style={{ background: 'linear-gradient(135deg, #ef4444 0%, #dc2626 50%, #b91c1c 100%)', border: '1px solid #f87171' }}
          >
            <div className="absolute -right-4 -top-4 opacity-10">
              <Boxes className="w-24 h-24 text-white" />
            </div>
            <div className="relative z-10 space-y-1">
              <p className="text-xs font-black uppercase tracking-widest" style={{ color: 'rgba(255,255,255,0.75)' }}>Total Cartons</p>
              <p className="text-3xl font-black text-white">{totalCartons.toLocaleString()}</p>
              <p className="text-xs font-medium" style={{ color: 'rgba(255,255,255,0.6)' }}>inbound pipeline</p>
            </div>
          </div>

          {/* Total Units */}
          <div className="rounded-2xl p-6 shadow-2xl" style={{ background: 'linear-gradient(135deg, #1f2937 0%, #111827 100%)', border: '1px solid rgba(239,68,68,0.3)' }}>
            <div className="flex justify-between items-start">
              <div className="space-y-1">
                <p className="text-xs font-black uppercase tracking-widest" style={{ color: '#9ca3af' }}>Total Units</p>
                <p className="text-3xl font-black text-white">{totalUnits.toLocaleString()}</p>
                <p className="text-xs font-medium" style={{ color: '#9ca3af' }}>across all weeks</p>
              </div>
              <div className="p-3 rounded-xl" style={{ background: 'rgba(239,68,68,0.15)' }}>
                <PackageSearch className="w-5 h-5" style={{ color: '#f87171' }} />
              </div>
            </div>
          </div>

          {/* Peak Week */}
          <div className="rounded-2xl p-6 shadow-2xl" style={{ background: 'linear-gradient(135deg, #1f2937 0%, #111827 100%)', border: '1px solid rgba(239,68,68,0.3)' }}>
            <div className="flex justify-between items-start">
              <div className="space-y-1">
                <p className="text-xs font-black uppercase tracking-widest" style={{ color: '#9ca3af' }}>Peak Week</p>
                <p className="text-3xl font-black text-white">{peakWeek.week.split(' - ')[0] || '—'}</p>
                <p className="text-xs font-medium" style={{ color: '#f87171' }}>
                  {peakWeek.units.toLocaleString()} units arriving
                </p>
              </div>
              <div className="p-3 rounded-xl" style={{ background: 'rgba(239,68,68,0.15)' }}>
                <CalendarClock className="w-5 h-5" style={{ color: '#f87171' }} />
              </div>
            </div>
          </div>

          {/* Destinations */}
          <div className="rounded-2xl p-6 shadow-2xl" style={{ background: 'linear-gradient(135deg, #1f2937 0%, #111827 100%)', border: '1px solid rgba(239,68,68,0.3)' }}>
            <div className="flex justify-between items-start">
              <div className="space-y-1">
                <p className="text-xs font-black uppercase tracking-widest" style={{ color: '#9ca3af' }}>Destinations</p>
                <p className="text-3xl font-black text-white">{warehouseCount}</p>
                <p className="text-xs font-medium" style={{ color: '#9ca3af' }}>active warehouses</p>
              </div>
              <div className="p-3 rounded-xl" style={{ background: 'rgba(52,211,153,0.12)' }}>
                <Building2 className="w-5 h-5" style={{ color: '#34d399' }} />
              </div>
            </div>
          </div>
        </div>

        {/* Area Chart */}
        <div
          className="rounded-2xl shadow-2xl overflow-hidden animate-in fade-in slide-in-from-bottom-8 duration-700"
          style={{ background: 'linear-gradient(135deg, #1f2937 0%, #111827 100%)', border: '1px solid rgba(239,68,68,0.25)' }}
        >
          <div className="px-6 pt-5 pb-2">
            <p className="text-base font-black text-white">Weekly Inbound Volume</p>
            <p className="text-xs mt-0.5" style={{ color: '#9ca3af' }}>Projected units and cartons arriving per week</p>
          </div>
          <div className="px-4 pb-5">
            <div className="h-[350px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chartData} margin={{ top: 10, right: 30, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="fillUnits" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#ef4444" stopOpacity={0.5} />
                      <stop offset="95%" stopColor="#ef4444" stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="fillCartons" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#fca5a5" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#fca5a5" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="rgba(255,255,255,0.07)" />
                  <XAxis
                    dataKey="week"
                    axisLine={false}
                    tickLine={false}
                    tick={{ fill: '#9ca3af', fontWeight: 600, fontSize: 12 }}
                    dy={10}
                  />
                  <YAxis
                    axisLine={false}
                    tickLine={false}
                    tick={{ fill: '#9ca3af', fontSize: 11 }}
                    dx={-10}
                  />
                  <Tooltip
                    contentStyle={{
                      borderRadius: '12px',
                      border: '1px solid rgba(239,68,68,0.4)',
                      backgroundColor: '#1f2937',
                      color: '#fff',
                      boxShadow: '0 10px 40px rgba(0,0,0,0.7)',
                    }}
                    labelStyle={{ color: '#fca5a5', fontWeight: 700 }}
                    itemStyle={{ fontWeight: 700 }}
                  />
                  <Area
                    type="monotone"
                    dataKey="Cartons"
                    stroke="#fca5a5"
                    strokeWidth={2}
                    strokeDasharray="5 3"
                    fillOpacity={1}
                    fill="url(#fillCartons)"
                    activeDot={{ r: 4, strokeWidth: 0, fill: '#fca5a5' }}
                  />
                  <Area
                    type="monotone"
                    dataKey="Units"
                    stroke="#ef4444"
                    strokeWidth={3}
                    fillOpacity={1}
                    fill="url(#fillUnits)"
                    activeDot={{ r: 6, strokeWidth: 0, fill: '#ef4444' }}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>

        {/* Data Table */}
        <div
          className="rounded-2xl shadow-2xl overflow-hidden animate-in fade-in slide-in-from-bottom-10 duration-900"
          style={{ background: 'linear-gradient(135deg, #1f2937 0%, #111827 100%)', border: '1px solid rgba(239,68,68,0.25)' }}
        >
          <div className="px-6 py-5 flex items-center justify-between" style={{ borderBottom: '1px solid rgba(239,68,68,0.2)' }}>
            <div>
              <p className="text-base font-black text-white">Forecast Breakdown</p>
              <p className="text-xs mt-0.5" style={{ color: '#9ca3af' }}>Detailed weekly inbound volume by destination warehouse</p>
            </div>
            <div
              className="px-4 py-1.5 rounded-full text-xs font-black"
              style={{ background: 'rgba(239,68,68,0.2)', color: '#fca5a5', border: '1px solid rgba(239,68,68,0.35)' }}
            >
              {forecast.length} Weeks
            </div>
          </div>
          <Table>
            <TableHeader>
              <TableRow style={{ background: 'rgba(239,68,68,0.08)', borderBottom: '1px solid rgba(239,68,68,0.2)' }}>
                <TableHead className="h-11 pl-6 w-44 text-[10px] font-black uppercase tracking-widest" style={{ color: '#fca5a5' }}>Arriving Week</TableHead>
                <TableHead className="h-11 text-right text-[10px] font-black uppercase tracking-widest" style={{ color: '#fca5a5' }}>Cartons</TableHead>
                <TableHead className="h-11 text-right text-[10px] font-black uppercase tracking-widest" style={{ color: '#fca5a5' }}>Units</TableHead>
                <TableHead className="h-11 pl-12 text-[10px] font-black uppercase tracking-widest" style={{ color: '#fca5a5' }}>Destination Warehouses</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={4} className="text-center py-12 text-sm" style={{ color: '#9ca3af' }}>
                    Loading forecast data...
                  </TableCell>
                </TableRow>
              ) : forecast.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="text-center py-12 text-sm italic" style={{ color: '#9ca3af' }}>
                    No inbound shipments currently scheduled.
                  </TableCell>
                </TableRow>
              ) : (
                forecast.map((f, i) => (
                  <TableRow
                    key={i}
                    style={{
                      borderBottom: '1px solid rgba(255,255,255,0.05)',
                      background: i % 2 === 0 ? 'transparent' : 'rgba(239,68,68,0.03)',
                    }}
                    className="transition-colors hover:bg-red-900/10"
                  >
                    <TableCell className="font-black py-4 pl-6">
                      <div className="flex flex-col gap-0.5">
                        <span
                          className="px-2.5 py-1 rounded-md text-xs font-black inline-flex items-center w-fit"
                          style={{ background: 'rgba(239,68,68,0.2)', color: '#f87171' }}
                        >
                          {f.week.split(' - ')[0]}
                        </span>
                        <span className="text-[10px] font-medium" style={{ color: '#6b7280' }}>
                          {f.week.split(' - ').slice(1).join('')}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className="text-right text-sm font-semibold py-4" style={{ color: '#9ca3af' }}>
                      {f.cartons.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right text-sm font-black py-4" style={{ color: '#f87171' }}>
                      {f.units.toLocaleString()}
                    </TableCell>
                    <TableCell className="py-4 pl-12">
                      <div className="flex flex-wrap gap-2">
                        {Object.entries(f.warehouses || {}).map(([wh, qty]: any) => (
                          <div
                            key={wh}
                            className="flex items-center gap-2 px-3 py-1.5 rounded-lg transition-colors"
                            style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)' }}
                          >
                            <MapPin className="w-3 h-3" style={{ color: '#f87171' }} />
                            <span className="text-[11px] font-bold uppercase tracking-tight" style={{ color: '#fca5a5' }}>{wh}</span>
                            <div className="w-px h-3" style={{ background: 'rgba(239,68,68,0.3)' }} />
                            <span className="text-xs font-black text-white">{(qty as number).toLocaleString()}</span>
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
