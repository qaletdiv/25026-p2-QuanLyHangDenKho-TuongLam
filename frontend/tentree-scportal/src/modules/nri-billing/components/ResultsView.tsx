'use client';

/**
 * THE RESULT — the workbook's `Pivot` tab: Σ Charges by Revised GL Code + Revised
 * GL Desc (rows) × Revised Class (columns), with grand totals, filtered by file
 * the way the workbook's Source.Name slicer was. Sept 15 2026 reads
 * CA - Whsle $30,659.74 · CA - Online $46,190.69 · $76,850.43, to the cent.
 *
 * Every number on the page comes from the same request, recomputed from the
 * lines, so the pivot, the buckets and the drill-down cannot disagree. Click any
 * pivot cell or bucket to see — and recode — the lines behind it.
 */

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, ChevronDown, Copy, Info } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { EntitySwitch, money, count, signed, fmtDate, CURRENCY, VerdictBadge } from './shared';
import LinesPanel from './LinesPanel';
import ReviewDialog from './ReviewDialog';
import type { BillingFile, LineFilter, Results, Scope } from '../types';

const NO_CLASS = 'No class';

export default function ResultsView({ data, scope, initialDrill = null }: {
  data: Results | null; scope: Scope;
  /** a drill-down opened from a link (e.g. GL Codes → "recoded by hand") */
  initialDrill?: { filter: LineFilter; title: string } | null;
}) {
  const router = useRouter();
  const [navigating, startNav] = useTransition();
  const [drill, setDrill] = useState<{ filter: LineFilter; title: string } | null>(initialDrill);
  const [reviewId, setReviewId] = useState<string | null>(null);

  const go = (next: Scope) => {
    setDrill(null);
    const p = new URLSearchParams({ entity: next.entity });
    if (next.files) p.set('files', next.files);
    startNav(() => router.push(`/invoices/results?${p}`));
  };

  const files = useMemo(() => data?.files ?? [], [data]);


  const pick = (filter: LineFilter, title: string) => {
    setDrill({ filter, title });
    requestAnimationFrame(() => document.getElementById('lines')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };

  return (
    <div className={cn('space-y-5', navigating && 'opacity-60 transition-opacity')}>
      <div className="flex flex-wrap items-center gap-3">
        <EntitySwitch value={scope.entity} onChange={(e) => go({ entity: e })} />
        <FilePicker
          files={files}
          selected={data?.selected.map((f) => f.id) ?? []}
          onApply={(ids) => go({ entity: scope.entity, files: ids.join(',') })}
        />
        {data && <span className="text-sm text-muted-foreground">{count(data.selected.length)} of {count(files.length)} files · {CURRENCY[scope.entity]}</span>}
      </div>

      {!data ? (
        <Empty>Could not load results.</Empty>
      ) : !files.length ? (
        <Empty>No NRI {scope.entity} invoices uploaded yet — add them on the Uploads tab.</Empty>
      ) : (
        <>
          <ReviewBanner data={data} onReview={setReviewId} />
          <Warnings data={data} />

          <PivotTable data={data} onCell={pick} />
          <ServiceChecks data={data} onPick={pick} />

          {drill && (
            <LinesPanel
              key={JSON.stringify([scope, drill.filter])}
              scope={scope}
              filter={drill.filter}
              title={drill.title}
              classes={data.classes}
              glOptions={data.glOptions}
              onClose={() => setDrill(null)}
              onChanged={() => router.refresh()}
            />
          )}
        </>
      )}
      <ReviewDialog fileId={reviewId} open={!!reviewId} goToResults={false} onClose={() => { setReviewId(null); router.refresh(); }} />
    </div>
  );
}

/**
 * Which .csv files the page sums — one or several, ticked and then applied, so
 * choosing three files is one reload, not three. Newest period first.
 */
function FilePicker({ files, selected, onApply }: {
  files: BillingFile[]; selected: string[]; onApply: (ids: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string[]>(selected);
  const sorted = useMemo(
    () => [...files].sort((a, b) => (b.periodEnd ?? '').localeCompare(a.periodEnd ?? '') || b.uploadedAt.localeCompare(a.uploadedAt)),
    [files],
  );
  const name = (id: string) => files.find((f) => f.id === id)?.fileName ?? id;
  const label = selected.length === 1 ? name(selected[0])
    : selected.length ? `${count(selected.length)} files` : 'Choose files';
  const toggle = (id: string) => setDraft((d) => (d.includes(id) ? d.filter((x) => x !== id) : [...d, id]));
  const same = draft.length === selected.length && draft.every((id) => selected.includes(id));

  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (o) setDraft(selected); }}>
      <PopoverTrigger asChild>
        <button type="button" aria-label="Invoice files"
          className="flex h-9 w-80 max-w-full items-center justify-between gap-2 rounded-md border border-input bg-transparent px-3 text-sm hover:bg-muted/30">
          <span className="min-w-0 truncate">{label}</span>
          <ChevronDown className="h-4 w-4 shrink-0 opacity-60" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-96 p-0">
        <div className="flex items-center justify-between border-b border-border px-3 py-2 text-xs text-muted-foreground">
          <span>{count(draft.length)} of {count(files.length)} selected</span>
          <span className="flex gap-3">
            <button type="button" className="hover:text-foreground" onClick={() => setDraft(files.map((f) => f.id))}>Select all</button>
            <button type="button" className="hover:text-foreground" onClick={() => setDraft([])}>Clear</button>
          </span>
        </div>
        <ul className="max-h-72 overflow-y-auto py-1">
          {sorted.map((f) => (
            <li key={f.id}>
              <label className="flex cursor-pointer items-center gap-2.5 px-3 py-1.5 text-sm hover:bg-muted/40">
                <Checkbox checked={draft.includes(f.id)} onCheckedChange={() => toggle(f.id)} />
                <span className="min-w-0 flex-1 truncate">{f.fileName}</span>
                <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{fmtDate(f.periodEnd)}</span>
              </label>
            </li>
          ))}
        </ul>
        <div className="flex justify-end gap-2 border-t border-border px-3 py-2">
          <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
          <Button size="sm" disabled={!draft.length || same} onClick={() => { setOpen(false); onApply(draft); }}>Apply</Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="rounded-lg border border-dashed border-border bg-card px-6 py-10 text-center text-sm text-muted-foreground">{children}</div>;
}

// ─── Not reviewed yet: the channel / GL suggestions were never confirmed ─────

function ReviewBanner({ data, onReview }: { data: Results; onReview: (id: string) => void }) {
  const pending = data.selected.filter((f) => !f.locked && !f.confirmedAt);
  if (!pending.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-primary/40 bg-primary/5 px-3 py-2 text-sm">
      <Info className="h-4 w-4 shrink-0 text-primary" />
      <span className="min-w-0 flex-1">
        {pending.length === 1 ? <b>{pending[0].fileName}</b> : <b>{pending.length} files</b>} {pending.length === 1 ? 'hasn’t' : 'haven’t'} been reviewed —
        {' '}these figures use the suggested channel and GL for each service until someone confirms them.
      </span>
      {pending.slice(0, 3).map((f) => (
        <Button key={f.id} size="sm" onClick={() => onReview(f.id)}>Review {pending.length > 1 ? f.fileName.replace(/^NRI (CA|US) Invoice /, '') : 'services'}</Button>
      ))}
    </div>
  );
}

// ─── Warnings: things that make the totals wrong, at the top ─────────────────

function Warnings({ data }: { data: Results }) {
  const items: React.ReactNode[] = [];
  for (const d of data.duplicates) {
    items.push(
      <>
        <b>{d.aName}</b> and <b>{d.bName}</b> share {count(d.shared)} identical charges ({money(d.charges)}) — the same
        invoice uploaded twice, so these totals count that money twice. Delete one of them on the Uploads tab.
      </>,
    );
  }
  if (!data.cardLoaded) items.push(<>No NRI {data.entity} rate card is loaded — nothing below can be verified. Load it on the Rate Cards tab.</>);
  // from the pivot itself, not the flag count: a service missing from the legend
  // that a person has already given a manual GL is coded, and is not a warning
  const unmapped = data.pivot.rows.find((r) => r.gl === null);
  if (unmapped) {
    items.push(<>{count(unmapped.lines)} line(s), {money(unmapped.total)}, use a service that is not in the coding legend and have no GL yet — click the “Unmapped” row to code them.</>);
  }
  const noClass = data.pivot.totals.cells[''];
  if (noClass) items.push(<>{money(noClass)} has no channel — click the “No class” column to code it.</>);
  if (!items.length) return null;
  return (
    <div className="space-y-2">
      {items.map((m, i) => (
        <p key={i} className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-sm text-amber-900 dark:text-amber-100">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" /> <span>{m}</span>
        </p>
      ))}
    </div>
  );
}

// ─── The pivot ───────────────────────────────────────────────────────────────

function PivotTable({ data, onCell }: { data: Results; onCell: (f: LineFilter, title: string) => void }) {
  const { pivot } = data;
  const [copied, setCopied] = useState(false);
  const cols = pivot.classes;
  const key = (c: string | null) => (c === null ? '' : c);
  const label = (c: string | null) => c ?? NO_CLASS;

  const copy = async () => {
    const head = ['Revised GL Code', 'Revised GL Desc', ...cols.map(label), 'Grand Total'].join('\t');
    const body = pivot.rows.map((r) => [
      r.gl ?? 'Unmapped', r.glDesc ?? '',
      ...cols.map((c) => (r.cells[key(c)] !== undefined ? r.cells[key(c)].toFixed(2) : '')),
      r.total.toFixed(2),
    ].join('\t'));
    const foot = ['Grand Total', '', ...cols.map((c) => (pivot.totals.cells[key(c)] ?? 0).toFixed(2)), pivot.totals.total.toFixed(2)].join('\t');
    await navigator.clipboard.writeText([head, ...body, foot].join('\n'));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const cellBtn = (amount: number | undefined, filter: LineFilter, title: string, strong = false) =>
    amount === undefined ? (
      <span className="text-muted-foreground/50">—</span>
    ) : (
      <button type="button" onClick={() => onCell(filter, title)}
        className={cn('tabular-nums underline-offset-2 hover:text-primary hover:underline', strong && 'font-semibold')}>
        {money(amount)}
      </button>
    );

  return (
    <section className="rounded-lg border border-border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5">
        <h2 className="text-sm font-semibold">
          Cost per GL by channel <span className="font-normal text-muted-foreground">· Σ charges before tax</span>
        </h2>
        <Button size="sm" variant="outline" onClick={copy} title="Copy as a table — pastes straight into Excel">
          <Copy className="mr-1.5 h-3.5 w-3.5" /> {copied ? 'Copied' : 'Copy table'}
        </Button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-card/80 text-xs text-muted-foreground">
            <tr className="border-b border-border">
              <th className="px-4 py-2 text-left font-medium">Revised GL Code</th>
              <th className="px-4 py-2 text-left font-medium">Revised GL Desc</th>
              {cols.map((c) => (
                <th key={key(c)} className={cn('px-4 py-2 text-right font-medium', c === null && 'text-amber-700 dark:text-amber-300')}>{label(c)}</th>
              ))}
              <th className="px-4 py-2 text-right font-medium">Grand Total</th>
            </tr>
          </thead>
          <tbody>
            {pivot.rows.map((r) => {
              const gl = r.gl === null ? 'null' : String(r.gl);
              return (
                <tr key={gl} className="border-b border-border hover:bg-muted/30">
                  <td className={cn('px-4 py-2 font-mono text-xs', r.gl === null && 'text-amber-700 dark:text-amber-300')}>{r.gl ?? 'Unmapped'}</td>
                  <td className="px-4 py-2">{r.glDesc ?? <span className="text-muted-foreground">Service not in the coding legend</span>}</td>
                  {cols.map((c) => (
                    <td key={key(c)} className="px-4 py-2 text-right">
                      {cellBtn(r.cells[key(c)], { gl, cls: c === null ? 'null' : c }, `GL ${r.gl ?? 'unmapped'} · ${label(c)}`)}
                    </td>
                  ))}
                  <td className="px-4 py-2 text-right">{cellBtn(r.total, { gl }, `GL ${r.gl ?? 'unmapped'} · all channels`, true)}</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="bg-muted/30 font-semibold">
              <td className="px-4 py-2" colSpan={2}>Grand Total</td>
              {cols.map((c) => (
                <td key={key(c)} className="px-4 py-2 text-right">
                  {cellBtn(pivot.totals.cells[key(c)], { cls: c === null ? 'null' : c }, `${label(c)} · all GLs`, true)}
                </td>
              ))}
              <td className="px-4 py-2 text-right tabular-nums">{money(pivot.totals.total)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </section>
  );
}

// ─── Rate check by service ───────────────────────────────────────────────────

/** a per-unit price: cents, or up to 4 decimals when the rate has them ($0.0525) */
const unitPrice = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;

const qty = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 2 });

/**
 * What the RATE CARD says a service's amount should be — the Amount column beside it
 * is what NRI billed, so the two can be compared. One part per line of text:
 *   priced     "2,650 × $1.25 per order + 332 × $2.00 per order", then "= $3,976.50"
 *   tiered     "310 × $0.05–$0.06 each / month" (storage: a range, not one figure)
 *   no number  "CA-FRT-01: NRI Discounted, per order" — the card's own words
 *   not on it  "Not on the rate card"
 * The "=" total appears only when every line was priced off the card.
 */
function calcParts(s: Results['rateCheck']['services'][number]): string[] {
  const parts: string[] = [];
  for (const t of s.calc.terms) {
    const per = t.uom ? ` ${t.uom}` : '';
    if (t.basis === 'text') parts.push(`${t.code}: ${t.text || 'no rate'}${t.uom ? `, ${t.uom}` : ''}`);
    else if (t.basis === 'tier') parts.push(`${qty(t.units)} × ${unitPrice(t.rate ?? 0)}–${unitPrice(t.rateMax ?? 0)}${per}`);
    else if (t.basis === 'perLine') parts.push(`${count(t.lines)} × ${unitPrice(t.rate ?? 0)}${per}`);
    else if (t.basis === 'composite' && t.fixed) parts.push(`${count(t.lines)} × ${unitPrice(t.fixed)} + ${qty(t.units)} × ${unitPrice(t.rate ?? 0)}${per}`);
    else parts.push(`${qty(t.units)} × ${unitPrice(t.rate ?? 0)}${per}`);
  }
  if (s.calc.offCard.lines) parts.push('Not on the rate card');
  const allPriced = !s.calc.offCard.lines && s.calc.terms.length > 0 && s.calc.terms.every((t) => t.basis !== 'text');
  if (allPriced) {
    const tiered = s.calc.terms.some((t) => t.basis === 'tier');
    const lo = s.calc.terms.reduce((n, t) => n + (t.basis === 'tier' ? t.min : t.expected), 0);
    const hi = s.calc.terms.reduce((n, t) => n + (t.basis === 'tier' ? t.max : t.expected), 0);
    parts.push(tiered ? `= ${money(lo)} – ${money(hi)}` : `= ${money(lo)}`);
  }
  return parts.length ? parts : ['—'];
}

/** "View" → a small popup with the rate-card working; the cell click does not open the row's lines */
function CalcView({ s }: { s: Results['rateCheck']['services'][number] }) {
  const parts = calcParts(s);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className="text-xs font-medium text-primary hover:underline">View</button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto min-w-64 max-w-md p-3">
        <div className="mb-1.5 text-xs font-semibold">{s.service} · rate card</div>
        <div className="space-y-0.5 text-xs tabular-nums text-muted-foreground">
          {parts.map((p, i) => (
            <div key={i} className={cn(p.startsWith('=') && 'border-t border-border pt-1 font-medium text-foreground')}>
              {i > 0 && !p.startsWith('=') && '+ '}{p}
            </div>
          ))}
        </div>
        <div className="mt-2 flex justify-between gap-4 border-t border-border pt-1.5 text-xs">
          <span className="text-muted-foreground">Billed by NRI</span>
          <span className="font-medium tabular-nums">{money(s.charges)}</span>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function ServiceChecks({ data, onPick }: { data: Results; onPick: (f: LineFilter, title: string) => void }) {
  const [all, setAll] = useState(false);
  const services = data.rateCheck.services;
  const shown = all ? services : services.slice(0, 10);
  return (
    <section className="rounded-lg border border-border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5">
        <h2 className="text-sm font-semibold">Rate check by NRI service <span className="font-normal text-muted-foreground">· flagged first</span></h2>
        {services.length > 10 && (
          <Button size="sm" variant="ghost" onClick={() => setAll(!all)}>{all ? 'Show top 10' : `Show all ${services.length}`}</Button>
        )}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-card/80 text-xs text-muted-foreground">
            <tr className="border-b border-border">
              <th className="px-4 py-2 text-left font-medium">Service</th>
              <th className="px-4 py-2 text-right font-medium">Lines</th>
              <th className="px-4 py-2 text-left font-medium">Calculation</th>
              <th className="px-4 py-2 text-right font-medium">Amount</th>
              <th className="px-4 py-2 text-left font-medium">Result</th>
              <th className="px-4 py-2 text-right font-medium">Flagged</th>
              <th className="px-4 py-2 text-right font-medium">Net variance</th>
              <th className="px-4 py-2 text-left font-medium">Rate codes</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((s) => (
              <tr key={s.service} className="cursor-pointer border-b border-border hover:bg-muted/30"
                onClick={() => onPick({ service: s.service }, `Service · ${s.service}`)}>
                <td className="px-4 py-2 font-medium">{s.service}</td>
                <td className="px-4 py-2 text-right tabular-nums">{count(s.lines)}</td>
                <td className="px-4 py-2" onClick={(e) => e.stopPropagation()}>
                  <CalcView s={s} />
                </td>
                <td className="px-4 py-2 text-right tabular-nums">{money(s.charges)}</td>
                <td className="px-4 py-2">
                  <div className="flex flex-wrap gap-1">
                    {Object.keys(s.verdicts).map((v) => <VerdictBadge key={v} verdict={v as never} />)}
                  </div>
                </td>
                <td className={cn('px-4 py-2 text-right tabular-nums', s.flagged > 0 && 'font-semibold text-red-700 dark:text-red-300')}>{count(s.flagged)}</td>
                <td className="px-4 py-2 text-right tabular-nums">{s.flagged ? signed(s.variance) : '—'}</td>
                <td className="px-4 py-2 font-mono text-xs text-muted-foreground">{s.rateCodes.join(', ') || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="border-t border-border px-4 py-2 text-xs text-muted-foreground">
        Period covered: {fmtDate(data.selected.map((f) => f.periodEnd).filter(Boolean).sort()[0] ?? null)} – {fmtDate(data.selected.map((f) => f.periodEnd).filter(Boolean).sort().slice(-1)[0] ?? null)} (period-end dates).
      </p>
    </section>
  );
}
