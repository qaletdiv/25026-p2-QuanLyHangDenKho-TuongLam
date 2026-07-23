'use client';

// Transit-time overview: one row per LANE (supplier × country of origin × departure
// port; mode kept separate so Air and Sea never average together). Columns are the
// journey segments: CRD → Received → Depart → Port → DC → NetSuite Receive.
// Standards come from transit_time_standards (master data); actuals are derived
// from shipment dates at read-time. Cells color actual vs the mode's standard.

import { Clock } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { TransitTimesReport, TransitActualStat, TransitLaneRow } from '@/modules/mainline/types';
import CopyButton, { copyTable } from './CopyButton';

// One number per cell: the lane's average days, green when within the mode's
// standard, red when over (with how many days over). Standards are in the footer.
// A shipment whose dates were entered out of order is excluded from the average
// and the cell is flagged instead of showing a bogus (negative) duration.
function SegmentCell({ actual, standard, invalid }: { actual: TransitActualStat | null; standard: number | null; invalid: boolean }) {
  if (!actual) {
    return (
      <td className="px-4 py-2 text-right whitespace-nowrap">
        {invalid ? <span className="text-[11px] font-semibold text-amber-600">⚠ check dates</span> : <span className="text-muted-foreground">—</span>}
      </td>
    );
  }
  const over = standard != null && actual.avg > standard;
  return (
    <td className="px-4 py-2 text-right whitespace-nowrap">
      <span className={cn('tabular-nums font-semibold', over ? 'text-red-600' : 'text-emerald-600')}>{actual.avg} days</span>
      {over && <span className="ml-1 text-[10px] text-red-600/80">(+{Math.round((actual.avg - (standard as number)) * 10) / 10})</span>}
      {invalid && <span className="ml-1 text-[11px] text-amber-600" title="Some shipments on this lane have out-of-order dates and were excluded">⚠</span>}
    </td>
  );
}

// Σ of a mode's standard days across all journey segments (CRD → ATA yardstick).
function standardTotal(standard: Record<string, number>, segments: Array<{ key: string }>): number | null {
  if (!segments.every((s) => standard[s.key] != null)) return null;
  return segments.reduce((a, s) => a + standard[s.key], 0);
}

export default function TransitTimes({ data }: { data: TransitTimesReport }) {
  const slippedShipments = data.shipments.filter((s) => s.slipped.length > 0);
  const totalSamples = data.shipments.length;

  function copyLanes() {
    const cell = (lane: TransitLaneRow, key: string) => {
      const a = key === 'total' ? lane.total : lane.segments[key];
      if (a) return `${a.avg}d`;
      return lane.invalid_segments.includes(key) ? 'check dates' : '—';
    };
    copyTable(
      ['Supplier', 'Origin', 'Departure Port', 'Mode', ...data.segments.map((s) => s.label), 'CRD → ATA'],
      [
        ...data.lanes.map((l) => [
          l.supplier_name, l.coo, l.pol_port, l.mode,
          ...data.segments.map((s) => cell(l, s.key)), cell(l, 'total'),
        ]),
        ...data.modes.filter((m) => Object.keys(m.standard).length > 0).map((m) => [
          'Standard', '', '', m.mode,
          ...data.segments.map((s) => (m.standard[s.key] != null ? `${m.standard[s.key]}d` : '—')),
          standardTotal(m.standard, data.segments) != null ? `${standardTotal(m.standard, data.segments)}d` : '—',
        ]),
      ],
    );
  }

  return (
    <div className="rounded-2xl shadow-2xl overflow-hidden bg-card border border-border">
      <div className="px-6 pt-5 pb-3 flex items-center gap-2">
        <Clock className="w-4 h-4 text-muted-foreground" />
        <div>
          <p className="text-base font-black text-foreground">Transit Times — actual vs standard, by lane</p>
          <p className="text-xs mt-0.5 text-muted-foreground">
            {totalSamples} shipment{totalSamples === 1 ? '' : 's'}).
            <span className="text-emerald-600 font-semibold"> Green</span> = within standard,
            <span className="text-red-600 font-semibold"> red</span> = over standard (days over in parentheses).
          </p>
        </div>
        <div className="ml-auto"><CopyButton onCopy={copyLanes} /></div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm bg-card">
          <thead>
            <tr className="bg-card/80 border-y border-border">
              <th className="text-left px-4 py-2 font-bold text-[11px] uppercase tracking-widest text-muted-foreground">Supplier</th>
              <th className="text-left px-4 py-2 font-bold text-[11px] uppercase tracking-widest text-muted-foreground">Origin</th>
              <th className="text-left px-4 py-2 font-bold text-[11px] uppercase tracking-widest text-muted-foreground">Departure Port</th>
              <th className="text-left px-4 py-2 font-bold text-[11px] uppercase tracking-widest text-muted-foreground">Mode</th>
              {data.segments.map((s) => (
                <th key={s.key} className="text-right px-4 py-2 font-bold text-[11px] uppercase tracking-widest text-muted-foreground whitespace-nowrap">{s.label}</th>
              ))}
              <th className="text-right px-4 py-2 font-bold text-[11px] uppercase tracking-widest text-foreground whitespace-nowrap">CRD → ATA</th>
            </tr>
          </thead>
          <tbody>
            {data.lanes.length === 0 && (
              <tr><td colSpan={5 + data.segments.length} className="px-4 py-6 text-center text-muted-foreground">No shipments yet — standards below apply until lanes accumulate history</td></tr>
            )}
            {data.lanes.map((lane) => (
              <tr key={`${lane.supplier_name}|${lane.coo}|${lane.pol_port}|${lane.mode_id}`} className="border-b border-border hover:bg-muted/30 align-top">
                <td className="px-4 py-2 font-medium text-foreground max-w-[220px] truncate">{lane.supplier_name ?? '—'}</td>
                <td className="px-4 py-2 text-muted-foreground whitespace-nowrap">{lane.coo ?? '—'}</td>
                <td className="px-4 py-2 text-muted-foreground whitespace-nowrap">{lane.pol_port ?? '—'}</td>
                <td className="px-4 py-2 text-muted-foreground whitespace-nowrap">{lane.mode ?? '—'}</td>
                {data.segments.map((s) => (
                  <SegmentCell key={s.key} actual={lane.segments[s.key]} standard={lane.standard[s.key] ?? null} invalid={lane.invalid_segments.includes(s.key)} />
                ))}
                <SegmentCell actual={lane.total} standard={standardTotal(lane.standard, data.segments)} invalid={lane.invalid_segments.includes('total')} />
              </tr>
            ))}
          </tbody>
          {/* standards reference rows — the yardstick each lane is colored against */}
          <tfoot>
            {data.modes.filter((m) => Object.keys(m.standard).length > 0).map((m) => (
              <tr key={m.mode_id} className="bg-card/80 border-t border-border">
                <td colSpan={3} className="px-4 py-1.5 text-[11px] uppercase tracking-widest font-bold text-muted-foreground">Standard</td>
                <td className="px-4 py-1.5 text-xs text-muted-foreground">{m.mode}</td>
                {data.segments.map((s) => (
                  <td key={s.key} className="px-4 py-1.5 text-right text-xs tabular-nums text-muted-foreground">{m.standard[s.key] != null ? `${m.standard[s.key]} days` : '—'}</td>
                ))}
                <td className="px-4 py-1.5 text-right text-xs tabular-nums font-semibold text-muted-foreground">
                  {standardTotal(m.standard, data.segments) != null ? `${standardTotal(m.standard, data.segments)} days` : '—'}
                </td>
              </tr>
            ))}
          </tfoot>
        </table>
      </div>

      {slippedShipments.length > 0 && (
        <div className="mx-6 mb-5 rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3 space-y-1.5">
          <p className="text-xs font-bold uppercase tracking-widest text-amber-600">Segments over standard</p>
          {slippedShipments.map((s) => (
            <p key={s.shipment_id} className="text-xs text-muted-foreground">
              <span className="font-semibold text-foreground">{s.shipment_number}</span>
              {' '}({[s.supplier_name, s.coo, s.mode].filter(Boolean).join(', ') || s.booking_number}):{' '}
              {s.slipped.map((sl, i) => (
                <span key={sl.segment}>
                  {i > 0 && '; '}
                  {sl.label} took <span className="font-semibold text-red-600">{sl.actual}d</span> vs {sl.standard}d standard (+{sl.over}d)
                </span>
              ))}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
