'use client';

/**
 * How much of the money the rate card actually covered. "0 flagged" means
 * nothing on its own when most of the invoice is freight the card never prices,
 * so every bucket shows lines AND dollars, and they sum to the invoice.
 */

import { cn } from '@/lib/utils';
import { BUCKETS, BUCKET_META, count, money, signed } from './shared';
import type { Bucket, BucketTotals } from '../types';

export default function BucketStrip({
  buckets, total, onPick, active,
}: { buckets: BucketTotals; total: number; onPick?: (b: Bucket) => void; active?: Bucket | null }) {
  return (
    <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
      {BUCKETS.map((b) => {
        const v = buckets[b] ?? { lines: 0, charges: 0, variance: 0 };
        const share = total ? (v.charges / total) * 100 : 0;
        const empty = v.lines === 0;
        const Tag = onPick && !empty ? 'button' : 'div';
        return (
          <Tag
            key={b}
            type={Tag === 'button' ? 'button' : undefined}
            onClick={Tag === 'button' ? () => onPick?.(b) : undefined}
            title={BUCKET_META[b].hint}
            className={cn(
              'rounded-lg border border-border bg-card px-3 py-2.5 text-left transition-colors',
              Tag === 'button' && 'hover:bg-muted/40',
              active === b && 'ring-2 ring-primary',
              b === 'flagged' && v.lines > 0 && 'border-red-500/40 bg-red-500/5',
            )}
          >
            <div className={cn('text-xs font-medium', empty ? 'text-muted-foreground' : BUCKET_META[b].tone)}>
              {BUCKET_META[b].label}
            </div>
            <div className="mt-0.5 text-lg font-semibold tabular-nums">{money(v.charges)}</div>
            <div className="text-xs text-muted-foreground tabular-nums">
              {count(v.lines)} lines · {share.toFixed(share > 0 && share < 1 ? 1 : 0)}%
              {b === 'flagged' && v.lines > 0 && <> · net {signed(v.variance)}</>}
            </div>
          </Tag>
        );
      })}
    </div>
  );
}
