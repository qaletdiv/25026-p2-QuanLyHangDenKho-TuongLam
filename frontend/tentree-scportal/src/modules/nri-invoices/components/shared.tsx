import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { Verdict, Severity, TieOutStatus } from '../types';

export const DASH = '—';

export const usd = (n: number | null | undefined) =>
  n === null || n === undefined
    ? DASH
    : `$${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Signed, for variance columns — the sign is the point, so keep it explicit. */
export const usdSigned = (n: number | null | undefined) => {
  if (n === null || n === undefined) return DASH;
  const v = Number(n);
  if (Math.abs(v) < 0.005) return usd(0);
  return `${v > 0 ? '+' : '−'}${usd(Math.abs(v))}`;
};

export const num = (n: number | null | undefined) =>
  n === null || n === undefined ? DASH : Number(n).toLocaleString();

export const varianceTone = (n: number | null | undefined) => {
  if (n === null || n === undefined || Math.abs(Number(n)) < 0.005) return 'text-muted-foreground';
  return Number(n) > 0 ? 'text-red-600 dark:text-red-400' : 'text-amber-600 dark:text-amber-400';
};

/**
 * Verdict labels are written from the reviewer's point of view: what does this
 * line need from me? "No contract rate" is not a failure — it means the
 * agreement is silent, which is a negotiation item, not a coding error.
 */
const VERDICT_META: Record<Verdict, { label: string; className: string }> = {
  overcharge:       { label: 'Above agreement', className: 'bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/30' },
  duplicate:        { label: 'Duplicate',       className: 'bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/30' },
  undercharge:      { label: 'Below agreement', className: 'bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30' },
  no_rate_on_file:  { label: 'No rate on file', className: 'bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30' },
  aging_premium:    { label: 'Aging premium',   className: 'bg-orange-500/15 text-orange-700 dark:text-orange-300 border-orange-500/30' },
  qty_unsupported:  { label: 'Qty unevidenced', className: 'bg-sky-500/15 text-sky-700 dark:text-sky-300 border-sky-500/30' },
  no_contract_rate: { label: 'Not in agreement',className: 'bg-muted text-muted-foreground border-border' },
  ok:               { label: 'Verified',        className: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30' },
};

export function VerdictBadge({ verdict, className }: { verdict: Verdict; className?: string }) {
  const m = VERDICT_META[verdict] ?? VERDICT_META.ok;
  return <Badge variant="outline" className={cn('font-normal whitespace-nowrap', m.className, className)}>{m.label}</Badge>;
}

const SEVERITY_META: Record<Severity, string> = {
  blocker: 'bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/30',
  warning: 'bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30',
  info:    'bg-sky-500/15 text-sky-700 dark:text-sky-300 border-sky-500/30',
};

export function SeverityBadge({ severity }: { severity: Severity }) {
  return (
    <Badge variant="outline" className={cn('font-normal uppercase text-[10px] tracking-wide', SEVERITY_META[severity])}>
      {severity}
    </Badge>
  );
}

export const TIE_OUT_META: Record<TieOutStatus, { label: string; tone: string; ring: string }> = {
  balanced:       { label: 'Ties to invoice', tone: 'text-emerald-700 dark:text-emerald-300', ring: 'border-emerald-500/40 bg-emerald-500/5' },
  out_of_balance: { label: 'Does not tie',    tone: 'text-red-700 dark:text-red-300',         ring: 'border-red-500/40 bg-red-500/5' },
  no_summary:     { label: 'Unproven',        tone: 'text-amber-700 dark:text-amber-300',     ring: 'border-amber-500/40 bg-amber-500/5' },
};

/**
 * Confidence on a derived returns class. `legend` means it came from the coding
 * legend's blanket default, which is exactly the thing this module replaces —
 * so it is styled as neutral, not as a pass.
 */
export function ConfidenceBadge({ basis, confidence }: { basis: string | null; confidence: string | null }) {
  if (!confidence) return <span className="text-muted-foreground">{DASH}</span>;
  const tone =
    confidence === 'exact' || confidence === 'declared' ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30'
      : confidence === 'derived' ? 'bg-sky-500/15 text-sky-700 dark:text-sky-300 border-sky-500/30'
        : confidence === 'inferred' ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30'
          : confidence === 'unresolved' ? 'bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/30'
            : 'bg-muted text-muted-foreground border-border';
  return (
    <Badge variant="outline" className={cn('font-normal whitespace-nowrap text-[11px]', tone)} title={`basis: ${basis ?? 'none'}`}>
      {confidence}
    </Badge>
  );
}
