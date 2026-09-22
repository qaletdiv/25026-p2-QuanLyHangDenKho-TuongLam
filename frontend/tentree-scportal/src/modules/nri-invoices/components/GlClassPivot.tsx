'use client';

/**
 * THE RESULT, in the shape finance already reads — the workbook's `Pivot` tab:
 * rows = GL code + description, columns = class, values = Σ amount, with a grand
 * total row and column.
 *
 * `GlClassMatrix` is the renderer and takes flat cells, so the same grid serves
 * BOTH readings without either drifting from the other:
 *   · one invoice, from its lines (`GlClassPivot` below), and
 *   · a whole warehouse, from the cross-invoice rollup (Cost per GL).
 * The cross-invoice view used to sum the classes away into one figure per GL —
 * "$5,447.41 of GL 5201" is not an answer anyone can post; which class it lands in
 * is the entire question.
 *
 * The flagged column is the point of the screen. The old workbook silently
 * defaulted unresolved lines to wholesale, which is how it reported
 * `US - Whsle $38,369` against finance's `$26,543`; here that money sits in its own
 * column, still inside the grand total, until a human says what it is.
 */

import { useMemo, useState } from 'react';
import { Copy, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { usd } from './shared';
import type { InvoiceLine } from '../types';

export const FLAGGED = 'Needs coding';

export type GlClassCell = {
  gl: number | null;
  gl_desc: string | null;
  /** the class this amount belongs to; anything in `flaggedAs` is bucketed as FLAGGED */
  class: string | null;
  amount: number;
};

export function GlClassMatrix({
  cells, title, subtitle, flaggedHint, onFlaggedClick, flaggedAs = ['(unclassed)'],
}: {
  cells: GlClassCell[];
  title: string;
  subtitle?: string;
  /** plain TEXT shown after the flagged amount. A string, not a render function:
   *  this component is rendered from a SERVER component too, and functions cannot
   *  cross the RSC boundary. */
  flaggedHint?: string;
  onFlaggedClick?: () => void;
  flaggedAs?: string[];
}) {
  const [copied, setCopied] = useState(false);

  const { rows, classes, colTotals, grand } = useMemo(() => {
    const flagSet = new Set([FLAGGED, ...flaggedAs]);
    const classSet = new Set<string>();
    const byRow = new Map<string, { gl: number | null; gl_desc: string | null; cells: Map<string, number>; total: number }>();
    let grandTotal = 0;

    for (const c of cells) {
      const key = c.gl === null || c.gl === undefined ? 'unmapped' : String(c.gl);
      const row = byRow.get(key) ?? { gl: c.gl ?? null, gl_desc: c.gl_desc ?? null, cells: new Map(), total: 0 };
      if (!row.gl_desc && c.gl_desc) row.gl_desc = c.gl_desc;
      const col = !c.class || flagSet.has(c.class) ? FLAGGED : c.class;
      if (col !== FLAGGED) classSet.add(col);
      row.cells.set(col, (row.cells.get(col) ?? 0) + c.amount);
      row.total += c.amount;
      byRow.set(key, row);
      grandTotal += c.amount;
    }

    // classes alphabetical, flagged LAST — exceptions belong at the edge, not
    // interleaved with the real classes
    const cols = [...classSet].sort();
    if ([...byRow.values()].some((r) => r.cells.has(FLAGGED))) cols.push(FLAGGED);

    const ordered = [...byRow.values()]
      .filter((r) => Math.abs(r.total) > 0.005 || r.cells.size > 0)
      .sort((a, b) => (a.gl ?? Number.MAX_SAFE_INTEGER) - (b.gl ?? Number.MAX_SAFE_INTEGER));

    const totals = new Map<string, number>();
    cols.forEach((c) => totals.set(c, ordered.reduce((s, r) => s + (r.cells.get(c) ?? 0), 0)));

    return { rows: ordered, classes: cols, colTotals: totals, grand: grandTotal };
  }, [cells, flaggedAs]);

  const copyTsv = async () => {
    const head = ['GL', 'Description', ...classes, 'Grand Total'].join('\t');
    const body = rows.map((r) => [
      r.gl ?? 'unmapped', r.gl_desc ?? '',
      ...classes.map((c) => (r.cells.get(c) ?? '').toString()),
      r.total.toFixed(2),
    ].join('\t'));
    const foot = ['Grand Total', '', ...classes.map((c) => (colTotals.get(c) ?? 0).toFixed(2)), grand.toFixed(2)].join('\t');
    await navigator.clipboard.writeText([head, ...body, foot].join('\n'));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  if (!rows.length) return null;
  const flaggedTotal = colTotals.get(FLAGGED) ?? 0;

  return (
    <section className="rounded-lg border border-border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5">
        <h2 className="text-sm font-semibold">
          {title}{subtitle && <span className="font-normal text-muted-foreground"> · {subtitle}</span>}
        </h2>
        <Button size="sm" variant="outline" onClick={copyTsv} title="Copy as TSV — paste straight into the workbook">
          <Copy className="mr-1.5 h-3.5 w-3.5" /> {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>

      {flaggedTotal > 0 && flaggedHint && (
        <button
          type="button"
          onClick={onFlaggedClick ?? (() => document.getElementById('coded-lines')?.scrollIntoView({ behavior: 'smooth' }))}
          className="flex w-full items-start gap-2 border-b border-amber-500/30 bg-amber-500/5 px-4 py-2 text-left text-xs text-amber-700 hover:bg-amber-500/10 dark:text-amber-300"
        >
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span><strong>{usd(flaggedTotal)}</strong> {flaggedHint}</span>
        </button>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-card/80">
            <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-2 font-medium">GL</th>
              <th className="px-4 py-2 font-medium">Description</th>
              {classes.map((c) => (
                <th key={c} className={cn('px-4 py-2 text-right font-medium whitespace-nowrap', c === FLAGGED && 'text-amber-600 dark:text-amber-400')}>
                  {c}
                </th>
              ))}
              <th className="px-4 py-2 text-right font-medium">Grand Total</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={String(r.gl ?? 'unmapped')} className="border-b border-border last:border-0 hover:bg-muted/30">
                <td className="px-4 py-2 font-mono text-xs">{r.gl ?? <span className="text-amber-600 dark:text-amber-400">unmapped</span>}</td>
                <td className="px-4 py-2 text-xs text-muted-foreground">{r.gl_desc?.split(':').pop()?.trim() ?? '—'}</td>
                {classes.map((c) => {
                  const v = r.cells.get(c);
                  return (
                    <td key={c} className={cn('px-4 py-2 text-right tabular-nums', c === FLAGGED && v ? 'text-amber-700 dark:text-amber-300' : '')}>
                      {v === undefined ? <span className="text-muted-foreground/40">—</span> : usd(v)}
                    </td>
                  );
                })}
                <td className="px-4 py-2 text-right font-medium tabular-nums">{usd(r.total)}</td>
              </tr>
            ))}
            <tr className="border-t-2 border-border bg-muted/20 font-semibold">
              <td className="px-4 py-2">Grand Total</td>
              <td className="px-4 py-2" />
              {classes.map((c) => (
                <td key={c} className={cn('px-4 py-2 text-right tabular-nums', c === FLAGGED && 'text-amber-700 dark:text-amber-300')}>
                  {usd(colTotals.get(c) ?? 0)}
                </td>
              ))}
              <td className="px-4 py-2 text-right tabular-nums">{usd(grand)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}

/**
 * One invoice's result, built from its LINES rather than from a server rollup: the
 * lines are what the exception queue below edits, so the moment a flagged line is
 * coded its amount moves out of the flagged column into its cell — no refetch, and
 * no chance of the two disagreeing.
 */
export default function GlClassPivot({
  lines, measure = 'charges',
}: { lines: InvoiceLine[]; measure?: 'charges' | 'inv_amt' }) {
  const cells = useMemo<GlClassCell[]>(() => lines.map((l) => ({
    gl: l.gl ?? null,
    gl_desc: l.gl_desc ?? null,
    // no class OR no GL ⇒ cannot be posted ⇒ must not be folded into a real cell
    class: !l.class || l.gl === null || l.gl === undefined ? FLAGGED : l.class,
    amount: Number(l[measure]) || 0,
  })), [lines, measure]);

  const flaggedCount = useMemo(() => cells.filter((c) => c.class === FLAGGED).length, [cells]);

  return (
    <GlClassMatrix
      cells={cells}
      title="Result by GL × Class"
      subtitle={`Σ ${measure === 'charges' ? 'Charges' : 'Inv. Amt'}`}
      flaggedHint={`across ${flaggedCount.toLocaleString()} line${flaggedCount === 1 ? '' : 's'} is not coded yet and `
        + 'sits in its own column. It is included in the grand total, so the total always equals the invoice — '
        + 'code those lines below and the money moves into its GL and class.'}
    />
  );
}
