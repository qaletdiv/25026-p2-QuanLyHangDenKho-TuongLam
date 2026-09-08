'use client';

// Transit-time overview. ONE card, TWO tabs over the SAME segment columns
// (CRD → Received → Depart → Port → DC → NetSuite Receive) — so the reader
// learns the header row once and can move between the two grains:
//   • "Average by lane"  — one row per LANE (supplier × country of origin ×
//     departure port; mode kept separate so Air and Sea never average together).
//   • "By shipment"      — one row per SHIPMENT, the actual days behind those
//     averages. This replaces the old "Segments over standard" prose list: every
//     over-standard segment is simply a red cell here, in the column it belongs to.
// Standards come from transit_time_standards (master data); actuals are derived
// from shipment dates at read-time. Cells colour actual vs the mode's standard.

import { useMemo, useState } from 'react';
import { Clock } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { TransitTimesReport, TransitLaneRow } from '@/modules/mainline/types';
import CopyButton, { copyTable } from './CopyButton';

// One number per cell: days, green when within the mode's standard, red when over.
// Standards aren't printed — the colour says which side of them the figure falls on.
// A shipment whose dates were entered out of order yields a negative duration; it
// is flagged rather than shown, and on the lane row it is excluded from the average.
function DayCell({ value, standard, invalid, title }: {
  value: number | null; standard: number | null; invalid: boolean; title?: string;
}) {
  const bogus = value != null && value < 0;
  if (value == null || bogus) {
    return (
      <td className="px-4 py-2 text-right whitespace-nowrap">
        {invalid || bogus
          ? <span className="text-[11px] font-semibold text-amber-600" title="Out-of-order dates on this shipment — the duration would be negative">⚠ check dates</span>
          : <span className="text-muted-foreground">—</span>}
      </td>
    );
  }
  const over = standard != null && value > standard;
  return (
    <td className="px-4 py-2 text-right whitespace-nowrap" title={title}>
      <span className={cn('tabular-nums font-semibold', over ? 'text-red-600' : 'text-emerald-600')}>{value}</span>
      {invalid && <span className="ml-1 text-[11px] text-amber-600" title="Some shipments on this lane have out-of-order dates and were excluded">⚠</span>}
    </td>
  );
}

// Σ of a mode's standard days across all journey segments (CRD → ATA yardstick).
function standardTotal(standard: Record<string, number>, segments: Array<{ key: string }>): number | null {
  if (!segments.every((s) => standard[s.key] != null)) return null;
  return segments.reduce((a, s) => a + standard[s.key], 0);
}

const TH_LEFT  = 'text-left px-4 py-2 font-bold text-[11px] uppercase tracking-widest text-muted-foreground';
const TH_RIGHT = 'text-right px-4 py-2 font-bold text-[11px] uppercase tracking-widest text-muted-foreground whitespace-nowrap';

type Tab = 'lanes' | 'shipments';

export default function TransitTimes({ data }: { data: TransitTimesReport }) {
  const [tab, setTab] = useState<Tab>('lanes');

  const totalSamples = data.shipments.length;
  const slippedCount = data.shipments.filter((s) => s.slipped.length > 0).length;

  // A shipment's standard comes from its MODE — the per-mode rows already carry it,
  // so the shipment tab colours against the same numbers the lane tab does.
  const stdByMode = useMemo(
    () => new Map(data.modes.map((m) => [m.mode_id, m.standard])),
    [data.modes],
  );

  // Newest first: the shipment tab is a review list, and the recent journeys are
  // the ones anyone acts on. Undated shipments sink to the bottom.
  const shipments = useMemo(
    () => [...data.shipments].sort((a, b) =>
      (b.crd || '').localeCompare(a.crd || '') ||
      (a.shipment_number || '').localeCompare(b.shipment_number || '')),
    [data.shipments],
  );

  function copyLanes() {
    const cell = (lane: TransitLaneRow, key: string) => {
      const a = key === 'total' ? lane.total : lane.segments[key];
      if (a) return `${a.avg}d`;
      return lane.invalid_segments.includes(key) ? 'check dates' : '—';
    };
    copyTable(
      ['Supplier', 'Origin', 'Departure Port', 'Mode', ...data.segments.map((s) => s.label), 'CRD → ATA'],
      // Lanes only — the copy mirrors what the table shows, and the table no
      // longer prints the standards rows.
      data.lanes.map((l) => [
        l.supplier_name, l.coo, l.pol_port, l.mode,
        ...data.segments.map((s) => cell(l, s.key)), cell(l, 'total'),
      ]),
    );
  }

  function copyShipments() {
    const cell = (v: number | null) => (v == null ? '—' : v < 0 ? 'check dates' : `${v}d`);
    copyTable(
      ['Shipment', 'Supplier', 'Origin', 'Departure Port', 'Mode', ...data.segments.map((s) => s.label), 'CRD → ATA'],
      shipments.map((s) => [
        s.shipment_number || s.booking_number || '',
        s.supplier_name, s.coo, s.pol_port, s.mode,
        ...data.segments.map((seg) => cell(s.durations[seg.key])), cell(s.total_days),
      ]),
    );
  }

  const TABS: Array<{ key: Tab; label: string; caption: React.ReactNode }> = [
    {
      key: 'lanes',
      label: 'Average by lane',
      caption: <>{data.lanes.length} lane{data.lanes.length === 1 ? '' : 's'} (supplier × origin × departure port × mode) over {totalSamples} shipment{totalSamples === 1 ? '' : 's'}. Average days per segment.</>,
    },
    {
      key: 'shipments',
      label: 'By shipment',
      caption: <>{totalSamples} shipment{totalSamples === 1 ? '' : 's'}, {slippedCount} with a segment over standard. Actual days per segment.</>,
    },
  ];
  const active = TABS.find((t) => t.key === tab)!;

  return (
    <div className="rounded-2xl shadow-2xl overflow-hidden bg-card border border-border">
      <div className="px-6 pt-5 pb-3 flex items-center gap-2">
        <Clock className="w-4 h-4 text-muted-foreground" />
        <div>
          <p className="text-base font-black text-foreground">Transit Times — actual vs standard</p>
          {/* The cells carry no unit suffix, so the caption states it once. Keep the
              comment OUT of the text run below — a JSX comment between two text nodes
              eats the whitespace and renders "9 shipments.All figures in days." */}
          <p className="text-xs mt-0.5 text-muted-foreground">
            {active.caption}{' '}
            <span className="text-emerald-600 font-semibold">Green</span> = within standard,
            <span className="text-red-600 font-semibold"> red</span> = over standard.
          </p>
        </div>
        <div className="ml-auto"><CopyButton onCopy={tab === 'lanes' ? copyLanes : copyShipments} /></div>
      </div>

      {/* Same underline switcher as the Mainline | SMS strip above, one level in. */}
      <div className="px-6 flex gap-1 border-b border-border">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={cn(
              'px-3 py-2 text-sm font-semibold border-b-2 -mb-px transition-colors',
              tab === t.key ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm bg-card">
          <thead>
            <tr className="bg-card/80 border-b border-border">
              {tab === 'shipments' && <th className={TH_LEFT}>Shipment</th>}
              <th className={TH_LEFT}>Supplier</th>
              <th className={TH_LEFT}>Origin</th>
              <th className={TH_LEFT}>Departure Port</th>
              <th className={TH_LEFT}>Mode</th>
              {data.segments.map((s) => (
                <th key={s.key} className={TH_RIGHT}>{s.label}</th>
              ))}
              <th className={cn(TH_RIGHT, 'text-foreground')}>CRD → ATA</th>
            </tr>
          </thead>

          {tab === 'lanes' ? (
            <tbody>
              {data.lanes.length === 0 && (
                <tr><td colSpan={5 + data.segments.length} className="px-4 py-6 text-center text-muted-foreground">No shipments yet — lanes appear here once shipment dates accumulate</td></tr>
              )}
              {data.lanes.map((lane) => (
                <tr key={`${lane.supplier_name}|${lane.coo}|${lane.pol_port}|${lane.mode_id}`} className="border-b border-border hover:bg-muted/30 align-top">
                  <td className="px-4 py-2 font-medium text-foreground max-w-[220px] truncate">{lane.supplier_name ?? '—'}</td>
                  <td className="px-4 py-2 text-muted-foreground whitespace-nowrap">{lane.coo ?? '—'}</td>
                  <td className="px-4 py-2 text-muted-foreground whitespace-nowrap">{lane.pol_port ?? '—'}</td>
                  <td className="px-4 py-2 text-muted-foreground whitespace-nowrap">{lane.mode ?? '—'}</td>
                  {data.segments.map((s) => {
                    const a = lane.segments[s.key];
                    return (
                      <DayCell
                        key={s.key}
                        value={a ? a.avg : null}
                        standard={lane.standard[s.key] ?? null}
                        invalid={lane.invalid_segments.includes(s.key)}
                        title={a ? `${a.n} shipment${a.n === 1 ? '' : 's'} · min ${a.min}d · max ${a.max}d` : undefined}
                      />
                    );
                  })}
                  <DayCell
                    value={lane.total ? lane.total.avg : null}
                    standard={standardTotal(lane.standard, data.segments)}
                    invalid={lane.invalid_segments.includes('total')}
                    title={lane.total ? `${lane.total.n} shipment${lane.total.n === 1 ? '' : 's'} · min ${lane.total.min}d · max ${lane.total.max}d` : undefined}
                  />
                </tr>
              ))}
            </tbody>
          ) : (
            <tbody>
              {shipments.length === 0 && (
                <tr><td colSpan={6 + data.segments.length} className="px-4 py-6 text-center text-muted-foreground">No shipments yet — journeys appear here once shipment dates are entered</td></tr>
              )}
              {shipments.map((s) => {
                const std = stdByMode.get(s.mode_id ?? '') ?? {};
                return (
                  <tr key={s.shipment_id} className="border-b border-border hover:bg-muted/30 align-top">
                    <td className="px-4 py-2 font-semibold text-foreground whitespace-nowrap">{s.shipment_number || s.booking_number || '—'}</td>
                    <td className="px-4 py-2 text-muted-foreground max-w-[220px] truncate">{s.supplier_name ?? '—'}</td>
                    <td className="px-4 py-2 text-muted-foreground whitespace-nowrap">{s.coo ?? '—'}</td>
                    <td className="px-4 py-2 text-muted-foreground whitespace-nowrap">{s.pol_port ?? '—'}</td>
                    <td className="px-4 py-2 text-muted-foreground whitespace-nowrap">{s.mode ?? '—'}</td>
                    {data.segments.map((seg) => (
                      <DayCell
                        key={seg.key}
                        value={s.durations[seg.key] ?? null}
                        standard={std[seg.key] ?? null}
                        invalid={false}
                        title={std[seg.key] != null ? `standard ${std[seg.key]}d` : undefined}
                      />
                    ))}
                    <DayCell
                      value={s.total_days}
                      standard={standardTotal(std, data.segments)}
                      invalid={false}
                      // ATA is the NetSuite receive date — usually attributed from the
                      // Item Receipt, occasionally typed on the header. Name the source:
                      // the two segments that end at ATA are only as good as it is.
                      title={`CRD ${s.crd ?? '—'} → ATA ${s.ata ?? '—'}${s.ata_source === 'netsuite' ? ' (from Item Receipt)' : s.ata_source === 'manual' ? ' (entered manually)' : ''}`}
                    />
                  </tr>
                );
              })}
            </tbody>
          )}
          {/* No standards footer: the standard is still what each cell is COLOURED
              against (see DayCell) — on the shipment tab the cell's tooltip prints
              it. data.modes carries the full table if it ever needs showing again. */}
        </table>
      </div>
    </div>
  );
}
