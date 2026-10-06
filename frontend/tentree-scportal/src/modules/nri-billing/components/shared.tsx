'use client';

import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { Bucket, Entity, Verdict } from '../types';

export const DASH = '—';

/** Money in the warehouse's own currency (CA bills CAD, US bills USD). */
export const money = (n: number | null | undefined, digits = 2) =>
  n === null || n === undefined
    ? DASH
    : `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;

export const signed = (n: number | null | undefined) => {
  if (n === null || n === undefined) return DASH;
  if (Math.abs(n) < 0.005) return money(0);
  return `${n > 0 ? '+' : '−'}${money(Math.abs(n))}`;
};

export const count = (n: number | null | undefined) => (n === null || n === undefined ? DASH : Number(n).toLocaleString('en-US'));

export const CURRENCY: Record<Entity, string> = { CA: 'CAD', US: 'USD' };

/** NRI CA / NRI US switch — a segmented control, the same shape on every page. */
export function EntitySwitch({ value, onChange }: { value: Entity; onChange: (e: Entity) => void }) {
  return (
    <div role="radiogroup" aria-label="Warehouse" className="inline-flex rounded-md border border-border bg-card p-0.5">
      {(['CA', 'US'] as Entity[]).map((e) => (
        <button
          key={e}
          type="button"
          role="radio"
          aria-checked={value === e}
          onClick={() => onChange(e)}
          className={cn(
            'rounded px-3 py-1 text-sm font-medium transition-colors',
            value === e ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          NRI {e}
        </button>
      ))}
    </div>
  );
}

/**
 * The rate-check buckets, from the reviewer's point of view. Every line is in
 * exactly one, so together they always equal the invoice.
 */
export const BUCKET_META: Record<Bucket, { label: string; hint: string; tone: string }> = {
  verified:       { label: 'Verified',          hint: 'Billed exactly at the contract rate',                         tone: 'text-emerald-700 dark:text-emerald-300' },
  flagged:        { label: 'Flagged',           hint: 'Billed amount differs from the contract rate',                 tone: 'text-red-700 dark:text-red-300' },
  qtyUnsupported: { label: 'Hours don’t tie',   hint: 'Hourly rate is on the card, but quantity × rate ≠ charge',     tone: 'text-sky-700 dark:text-sky-300' },
  tierBlend:      { label: 'Storage blend',     hint: 'Inside the storage tier range — the aging mix is not on the invoice', tone: 'text-sky-700 dark:text-sky-300' },
  passthrough:    { label: 'Pass-through',      hint: 'Freight and materials at market — the card sets no price',    tone: 'text-muted-foreground' },
  notInAgreement: { label: 'Not in agreement',  hint: 'The rate card is silent on this charge',                       tone: 'text-amber-700 dark:text-amber-300' },
};
export const BUCKETS: Bucket[] = ['verified', 'flagged', 'qtyUnsupported', 'tierBlend', 'passthrough', 'notInAgreement'];

const VERDICT_META: Record<Verdict, { label: string; className: string }> = {
  ok:             { label: 'Verified',         className: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30' },
  overcharge:     { label: 'Over contract',    className: 'bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/30' },
  undercharge:    { label: 'Under contract',   className: 'bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30' },
  qtyUnsupported: { label: 'Hours don’t tie',  className: 'bg-sky-500/15 text-sky-700 dark:text-sky-300 border-sky-500/30' },
  tierBlend:      { label: 'Storage blend',    className: 'bg-sky-500/15 text-sky-700 dark:text-sky-300 border-sky-500/30' },
  passthrough:    { label: 'Pass-through',     className: 'bg-muted text-muted-foreground border-border' },
  noContractRate: { label: 'Not in agreement', className: 'bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30' },
  noRateOnCard:   { label: 'No rate on card',  className: 'bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30' },
};

export function VerdictBadge({ verdict }: { verdict: Verdict }) {
  const m = VERDICT_META[verdict] ?? VERDICT_META.ok;
  return <Badge variant="outline" className={cn('whitespace-nowrap font-normal', m.className)}>{m.label}</Badge>;
}

export const fmtDate = (iso: string | null | undefined) => {
  if (!iso) return DASH;
  const d = new Date(`${iso.slice(0, 10)}T00:00:00`);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};
