'use client';

import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  FileText, Database, Scale, ChevronDown, ChevronRight, CheckCircle2, AlertTriangle, Info,
} from 'lucide-react';
import { DASH, usd, usdSigned, num, varianceTone, VerdictBadge, SeverityBadge, TIE_OUT_META } from './shared';
import type { Reconcile, InvoiceDetail, Finding, TieOut, InvoiceHeader } from '../types';

type Props = { data: Reconcile | InvoiceDetail; sourceFile?: string | null };

/**
 * Preview returns the header nested under `invoice`; a loaded invoice returns it
 * flattened onto the record. Normalise so the view does not care which it got.
 */
function headerOf(data: Reconcile | InvoiceDetail): InvoiceHeader | null {
  if ('invoice' in data) return data.invoice;
  const d = data as InvoiceDetail;
  if (!d.invoice_no) return null;
  return {
    invoice_no: d.invoice_no, invoice_date: d.invoice_date, ending_date: d.ending_date,
    payment_terms: d.payment_terms, due_date: d.due_date, fx_rate: d.fx_rate,
    subtotal: d.subtotal, taxes: d.taxes, total: d.total,
    tax_lines: d.tax_lines ?? [], is_credit: !!d.is_credit,
  };
}

/**
 * The three-way verification, laid out as three columns because that IS the
 * mental model: the invoice says X, the detail says Y, the agreement says Z.
 * The tie-out banner underneath is the gate — everything else is diagnosis.
 */
export default function ReconcileView({ data, sourceFile }: Props) {
  const tie = data.tie_out;
  const t = data.totals;
  const inv = headerOf(data);
  const meta = TIE_OUT_META[tie.status];

  return (
    <div className="space-y-4">
      {/* ── the three sides ─────────────────────────────────────────────── */}
      <div className="grid gap-3 md:grid-cols-3">
        <Panel icon={FileText} label="Invoice" sub="summary — what NRI is billing">
          {inv?.invoice_no ? (
            <>
              <Line k="Invoice #" v={<span className="font-medium">{inv.invoice_no}</span>} />
              <Line k="Date" v={inv.invoice_date ?? DASH} />
              <Line k="Terms" v={`${inv.payment_terms ?? DASH}${inv.due_date ? ` · due ${inv.due_date}` : ''}`} />
              <Line k="FX rate" v={inv.fx_rate === null ? DASH : inv.fx_rate.toFixed(4)} />
              <Line k="Subtotal" v={usd(inv.subtotal)} />
              <Line k="Taxes" v={usd(inv.taxes)} />
              <Line k="Total" v={<span className="font-semibold tabular-nums">{usd(inv.total)}</span>} strong />
              {inv.is_credit && <Badge variant="outline" className="mt-1 border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300">Credit memo</Badge>}
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              No invoice PDF supplied. The detail cannot be proven complete, and the invoice number
              is not in the workbook — only the PDF carries it.
            </p>
          )}
        </Panel>

        <Panel icon={Database} label="Data" sub="source — the detail being coded">
          <Line k="Lines" v={num(t.lines)} />
          <Line k="Charges" v={usd(t.charges)} />
          <Line k="Taxes" v={usd(t.taxes)} />
          <Line k="Total" v={<span className="font-semibold tabular-nums">{usd(t.amount)}</span>} strong />
          <Line k="Coded" v={`${num(t.coded)} of ${num(t.lines)}`} />
          <Line
            k="Need attention"
            v={<span className={t.needs_attention > 0 ? 'font-medium text-amber-700 dark:text-amber-300' : ''}>{num(t.needs_attention)}</span>}
          />
          {sourceFile && <p className="pt-1 text-xs text-muted-foreground truncate" title={sourceFile}>{sourceFile}</p>}
        </Panel>

        <Panel icon={Scale} label="Agreement" sub="validator — contracted rates">
          <Line k="Validated" v={<span className="text-emerald-700 dark:text-emerald-300">{num(t.validated_ok)} lines</span>} />
          <Line k="No contract rate" v={num(t.unvalidatable)} />
          <Line
            k="Net variance"
            v={<span className={cn('font-semibold tabular-nums', varianceTone(t.variance))}>{usdSigned(t.variance)}</span>}
            strong
          />
          <p className="pt-1 text-xs text-muted-foreground">
            Compared on the line total with a rounding tolerance, and against the rate in force on
            each line&apos;s activity date.
          </p>
        </Panel>
      </div>

      {/* ── the gate ────────────────────────────────────────────────────── */}
      <div className={cn('flex flex-wrap items-center gap-3 rounded-lg border px-4 py-3', meta.ring)}>
        {tie.status === 'balanced'
          ? <CheckCircle2 className={cn('h-5 w-5 shrink-0', meta.tone)} />
          : <AlertTriangle className={cn('h-5 w-5 shrink-0', meta.tone)} />}
        <div className="min-w-0 flex-1">
          <p className={cn('text-sm font-medium', meta.tone)}>{meta.label}</p>
          <p className="text-sm text-muted-foreground">{tie.message}</p>
        </div>
        {tie.total_variance !== null && tie.total_variance !== undefined && (
          <div className="text-right">
            <p className="text-xs text-muted-foreground">detail − invoice</p>
            <p className={cn('text-sm font-semibold tabular-nums', varianceTone(tie.total_variance))}>
              {usdSigned(tie.total_variance)}
            </p>
          </div>
        )}
      </div>

      {data.findings.length > 0 && <Findings findings={data.findings} />}
      <GlSummary data={data} />
      <ServiceTable data={data} />
      <TieOutDetail tie={tie} />
    </div>
  );
}

/* ---------------------------------------------------------------- pieces --- */

function Panel({
  icon: Icon, label, sub, children,
}: { icon: React.ElementType; label: string; sub: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="mb-3 flex items-center gap-2">
        <Icon className="h-4 w-4 text-primary" />
        <div className="min-w-0">
          <p className="text-sm font-semibold leading-none">{label}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{sub}</p>
        </div>
      </div>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

function Line({ k, v, strong }: { k: string; v: React.ReactNode; strong?: boolean }) {
  return (
    <div className={cn('flex items-baseline justify-between gap-3 text-sm', strong && 'border-t border-border pt-1 mt-1')}>
      <span className="text-muted-foreground">{k}</span>
      <span className="tabular-nums text-right">{v}</span>
    </div>
  );
}

function Findings({ findings }: { findings: Finding[] }) {
  const [open, setOpen] = useState<string | null>(findings.find(f => f.severity === 'blocker')?.type ?? null);
  return (
    <section className="rounded-lg border border-border bg-card">
      <h2 className="border-b border-border px-4 py-2.5 text-sm font-semibold">
        What to look at <span className="font-normal text-muted-foreground">({findings.length})</span>
      </h2>
      <ul className="divide-y divide-border">
        {findings.map(f => {
          const isOpen = open === f.type;
          return (
            <li key={f.type}>
              <button
                type="button"
                onClick={() => setOpen(isOpen ? null : f.type)}
                className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-muted/30"
                aria-expanded={isOpen}
              >
                {isOpen ? <ChevronDown className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  : <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />}
                <SeverityBadge severity={f.severity} />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">{f.title}</span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    {num(f.lines)} line{f.lines === 1 ? '' : 's'} · {usd(f.amount)}
                    {Math.abs(f.variance) > 0.005 && <> · variance <span className={varianceTone(f.variance)}>{usdSigned(f.variance)}</span></>}
                    {f.max_aging_multiple ? ` · up to ${f.max_aging_multiple}× base` : ''}
                    {f.implied_hours ? ` · ${f.implied_hours} hrs` : ''}
                  </span>
                </span>
              </button>
              {isOpen && (
                <div className="space-y-2 px-4 pb-3 pl-14">
                  {f.services.length > 0 && (
                    <p className="text-xs text-muted-foreground">
                      Services: {f.services.join(', ')}
                    </p>
                  )}
                  <ul className="space-y-1">
                    {f.examples.map((ex, i) => (
                      <li key={i} className="rounded border border-border bg-muted/20 px-2.5 py-1.5 text-xs">
                        <span className="font-medium">{ex.service}</span>
                        {ex.seq ? <span className="text-muted-foreground"> · line {ex.seq}</span> : null}
                        {ex.units !== null && ex.units !== undefined ? <span className="text-muted-foreground"> · {num(ex.units)} units</span> : null}
                        {ex.detail && <span className="mt-0.5 block text-muted-foreground">{ex.detail}</span>}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function GlSummary({ data }: { data: Reconcile | InvoiceDetail }) {
  const rows = data.by_gl.filter(g => Math.abs(g.amount) > 0.005);
  const total = rows.reduce((s, g) => s + g.amount, 0);
  return (
    <section className="rounded-lg border border-border bg-card">
      <h2 className="border-b border-border px-4 py-2.5 text-sm font-semibold">Cost per GL</h2>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-card/80">
            <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-2 font-medium">GL</th>
              <th className="px-4 py-2 font-medium">Account</th>
              <th className="px-4 py-2 font-medium">Class split</th>
              <th className="px-4 py-2 text-right font-medium">Lines</th>
              <th className="px-4 py-2 text-right font-medium">Amount</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(g => (
              <tr key={String(g.gl)} className="border-b border-border last:border-0 hover:bg-muted/30">
                <td className="px-4 py-2 font-mono text-xs">{g.gl ?? <span className="text-red-600 dark:text-red-400">unmapped</span>}</td>
                <td className="px-4 py-2 text-muted-foreground">{g.gl_desc ?? DASH}</td>
                <td className="px-4 py-2">
                  <span className="flex flex-wrap gap-1">
                    {g.classes.filter(c => Math.abs(c.amount) > 0.005).map(c => (
                      <Badge key={c.class} variant="outline" className="font-normal text-[11px]">
                        {c.class} {usd(c.amount)}
                      </Badge>
                    ))}
                  </span>
                </td>
                <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">{num(g.lines)}</td>
                <td className="px-4 py-2 text-right font-medium tabular-nums">{usd(g.amount)}</td>
              </tr>
            ))}
            <tr className="bg-muted/30 font-semibold">
              <td className="px-4 py-2" colSpan={4}>Total</td>
              <td className="px-4 py-2 text-right tabular-nums">{usd(total)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ServiceTable({ data }: { data: Reconcile | InvoiceDetail }) {
  const [showAll, setShowAll] = useState(false);
  const all = data.by_service;
  const interesting = all.filter(s => s.verdict !== 'ok');
  const rows = showAll ? all : (interesting.length ? interesting : all);

  return (
    <section className="rounded-lg border border-border bg-card">
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-2.5">
        <h2 className="text-sm font-semibold">Charged vs agreement, by service</h2>
        <Button variant="ghost" size="sm" onClick={() => setShowAll(v => !v)}>
          {showAll ? `Only needs review (${interesting.length})` : `Show all (${all.length})`}
        </Button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-card/80">
            <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-2 font-medium">Service</th>
              <th className="px-4 py-2 font-medium">Basis</th>
              <th className="px-4 py-2 text-right font-medium">Lines</th>
              <th className="px-4 py-2 text-right font-medium">Charged</th>
              <th className="px-4 py-2 text-right font-medium">Agreement</th>
              <th className="px-4 py-2 text-right font-medium">Variance</th>
              <th className="px-4 py-2 font-medium">Verdict</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(s => (
              <tr key={s.service} className="border-b border-border last:border-0 hover:bg-muted/30">
                <td className="px-4 py-2 font-medium">{s.service}</td>
                <td className="px-4 py-2 text-xs text-muted-foreground">{s.basis ?? DASH}</td>
                <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">{num(s.lines)}</td>
                <td className="px-4 py-2 text-right tabular-nums">{usd(s.charges)}</td>
                <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">{usd(s.expected)}</td>
                <td className={cn('px-4 py-2 text-right tabular-nums', varianceTone(s.variance))}>{usdSigned(s.variance)}</td>
                <td className="px-4 py-2"><VerdictBadge verdict={s.verdict} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!showAll && interesting.length > 0 && (
        <p className="border-t border-border px-4 py-2 text-xs text-muted-foreground">
          {all.length - interesting.length} service{all.length - interesting.length === 1 ? '' : 's'} matched the agreement exactly and are hidden.
        </p>
      )}
    </section>
  );
}

function TieOutDetail({ tie }: { tie: TieOut }) {
  const [open, setOpen] = useState(tie.status === 'out_of_balance');
  const broken = tie.services.filter(s => s.status !== 'ok');
  return (
    <section className="rounded-lg border border-border bg-card">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="flex w-full items-center gap-2 px-4 py-2.5 text-left hover:bg-muted/30"
        aria-expanded={open}
      >
        {open ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
        <h2 className="text-sm font-semibold">Tie-out detail, per service</h2>
        <span className="text-xs text-muted-foreground">
          {broken.length ? `${broken.length} not tying` : `all ${tie.services.length} tie`}
        </span>
      </button>
      {open && (
        <div className="overflow-x-auto border-t border-border">
          <table className="w-full text-sm">
            <thead className="bg-card/80">
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-2 font-medium">Service</th>
                <th className="px-4 py-2 text-right font-medium">Detail</th>
                <th className="px-4 py-2 text-right font-medium">Invoice</th>
                <th className="px-4 py-2 text-right font-medium">Variance</th>
                <th className="px-4 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {tie.services.map(s => (
                <tr key={s.service} className={cn('border-b border-border last:border-0 hover:bg-muted/30', s.status !== 'ok' && 'bg-red-500/5')}>
                  <td className="px-4 py-2">{s.service}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{usd(s.charges)}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">{usd(s.invoice_amount)}</td>
                  <td className={cn('px-4 py-2 text-right tabular-nums', varianceTone(s.variance))}>{usdSigned(s.variance)}</td>
                  <td className="px-4 py-2 text-xs">
                    {s.status === 'ok'
                      ? <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-300"><CheckCircle2 className="h-3.5 w-3.5" /> ties</span>
                      : <span className="inline-flex items-center gap-1 text-red-700 dark:text-red-300"><AlertTriangle className="h-3.5 w-3.5" /> {s.status.replace(/_/g, ' ')}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {tie.status === 'no_summary' && (
            <p className="flex items-start gap-2 border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              Without the invoice PDF there is nothing to tie against. File the PDF alongside the
              detail workbook and these numbers become verifiable.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
