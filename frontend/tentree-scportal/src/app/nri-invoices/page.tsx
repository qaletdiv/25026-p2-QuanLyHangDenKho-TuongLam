import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { AlertTriangle, CheckCircle2, HelpCircle, TrendingUp } from 'lucide-react';
import { getInvoices, getCostSummary } from '@/modules/nri-invoices/actions';
import UploadVerify from '@/modules/nri-invoices/components/UploadVerify';
import { usd, usdSigned, num, varianceTone, DASH } from '@/modules/nri-invoices/components/shared';

// NRI invoice verification — upload + the loaded invoice list + cross-invoice
// analysis (the checks no single invoice can see: a monthly fee billed twice,
// the storage aging trend).
export default async function NriInvoicesPage() {
  const [invoices, summary] = await Promise.all([getInvoices('US'), getCostSummary('US')]);

  return (
    <div className="space-y-6">
      <UploadVerify />

      {invoices.length > 0 && (
        <section className="rounded-lg border border-border bg-card">
          <h2 className="border-b border-border px-4 py-2.5 text-sm font-semibold">
            Loaded invoices <span className="font-normal text-muted-foreground">({invoices.length})</span>
          </h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-card/80">
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-2 font-medium">Invoice</th>
                  <th className="px-4 py-2 font-medium">Date</th>
                  <th className="px-4 py-2 font-medium">Due</th>
                  <th className="px-4 py-2 text-right font-medium">Total</th>
                  <th className="px-4 py-2 font-medium">Tie-out</th>
                  <th className="px-4 py-2 text-right font-medium">Needs review</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {invoices.map(i => (
                  <tr key={i.id} className="border-b border-border last:border-0 hover:bg-muted/30">
                    <td className="px-4 py-2">
                      <Link href={`/nri-invoices/${i.invoice_no}`} className="font-medium text-primary hover:underline">
                        {i.invoice_no}
                      </Link>
                      {!i.has_summary && (
                        <Badge variant="outline" className="ml-2 border-amber-500/30 bg-amber-500/10 text-[10px] font-normal text-amber-700 dark:text-amber-300">
                          no PDF
                        </Badge>
                      )}
                    </td>
                    <td className="px-4 py-2 text-muted-foreground">{i.invoice_date ?? DASH}</td>
                    <td className="px-4 py-2 text-muted-foreground">{i.due_date ?? DASH}</td>
                    <td className="px-4 py-2 text-right font-medium tabular-nums">{usd(i.totals?.amount)}</td>
                    <td className="px-4 py-2">
                      {i.tie_out_status === 'balanced' ? (
                        <span className="inline-flex items-center gap-1 text-xs text-emerald-700 dark:text-emerald-300">
                          <CheckCircle2 className="h-3.5 w-3.5" /> ties
                        </span>
                      ) : i.tie_out_status === 'no_summary' ? (
                        <span className="inline-flex items-center gap-1 text-xs text-amber-700 dark:text-amber-300">
                          <HelpCircle className="h-3.5 w-3.5" /> unproven
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-xs text-red-700 dark:text-red-300">
                          <AlertTriangle className="h-3.5 w-3.5" /> {usdSigned(i.tie_out_variance)}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      {i.totals?.needs_attention > 0
                        ? <span className="font-medium text-amber-700 dark:text-amber-300">{num(i.totals.needs_attention)}</span>
                        : <span className="text-muted-foreground">0</span>}
                    </td>
                    <td className="px-4 py-2">
                      <Badge
                        variant="outline"
                        className={cn('font-normal',
                          i.status === 'submitted'
                            ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                            : 'border-border')}
                      >
                        {i.status}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {summary && summary.invoices > 0 && <CrossInvoice summary={summary} />}
    </div>
  );
}

function CrossInvoice({ summary }: { summary: NonNullable<Awaited<ReturnType<typeof getCostSummary>>> }) {
  const byGl = new Map<string, { gl: number | null; gl_desc: string | null; amount: number }>();
  for (const r of summary.by_gl) {
    const k = String(r.gl ?? 'unmapped');
    const e = byGl.get(k) ?? { gl: r.gl, gl_desc: r.gl_desc, amount: 0 };
    e.amount += r.amount;
    byGl.set(k, e);
  }
  const gls = [...byGl.values()].filter(g => Math.abs(g.amount) > 0.005).sort((a, b) => b.amount - a.amount);

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <section className="rounded-lg border border-border bg-card">
        <h2 className="border-b border-border px-4 py-2.5 text-sm font-semibold">
          Cost per GL <span className="font-normal text-muted-foreground">· {summary.invoices} invoice{summary.invoices === 1 ? '' : 's'} · {usd(summary.total)}</span>
        </h2>
        <table className="w-full text-sm">
          <tbody>
            {gls.map(g => (
              <tr key={String(g.gl)} className="border-b border-border last:border-0">
                <td className="px-4 py-2 font-mono text-xs">{g.gl ?? 'unmapped'}</td>
                <td className="px-4 py-2 text-xs text-muted-foreground">{g.gl_desc?.split(':').pop()?.trim() ?? DASH}</td>
                <td className="px-4 py-2 text-right font-medium tabular-nums">{usd(g.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <div className="space-y-4">
        {summary.duplicate_monthly_fees.length > 0 && (
          <section className="rounded-lg border border-red-500/40 bg-red-500/5">
            <h2 className="flex items-center gap-2 border-b border-red-500/30 px-4 py-2.5 text-sm font-semibold text-red-700 dark:text-red-300">
              <AlertTriangle className="h-4 w-4" /> Monthly fee billed more than once
            </h2>
            <ul className="divide-y divide-red-500/20 text-sm">
              {summary.duplicate_monthly_fees.map(f => (
                <li key={`${f.service}|${f.month}`} className="flex items-baseline justify-between gap-3 px-4 py-2">
                  <span>
                    <span className="font-medium">{f.service}</span>
                    <span className="text-muted-foreground"> · {f.month} · {f.count}× · invoice {f.invoices.join(', ')}</span>
                  </span>
                  <span className="font-semibold tabular-nums">{usd(f.amount)}</span>
                </li>
              ))}
            </ul>
            <p className="px-4 py-2 text-xs text-muted-foreground">
              The agreement is one fee per month. Recover by credit memo — the payment terms forbid
              withholding.
            </p>
          </section>
        )}

        {summary.storage_aging.length > 0 && (
          <section className="rounded-lg border border-border bg-card">
            <h2 className="flex items-center gap-2 border-b border-border px-4 py-2.5 text-sm font-semibold">
              <TrendingUp className="h-4 w-4 text-primary" /> Storage aging premium
              <span className={cn('ml-auto font-semibold tabular-nums', varianceTone(summary.storage_premium))}>
                {usdSigned(summary.storage_premium)}
              </span>
            </h2>
            <table className="w-full text-sm">
              <thead className="bg-card/80">
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-2 font-medium">Month</th>
                  <th className="px-4 py-2 text-right font-medium">Units</th>
                  <th className="px-4 py-2 text-right font-medium">$/unit</th>
                  <th className="px-4 py-2 text-right font-medium">× base</th>
                  <th className="px-4 py-2 text-right font-medium">Premium</th>
                </tr>
              </thead>
              <tbody>
                {summary.storage_aging.map((s, i) => (
                  <tr key={`${s.invoice_no}-${i}`} className="border-b border-border last:border-0">
                    <td className="px-4 py-2 text-muted-foreground">{s.month ?? DASH}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{num(s.units)}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{s.effective_rate?.toFixed(4) ?? DASH}</td>
                    <td className="px-4 py-2 text-right font-medium tabular-nums">{s.aging_multiple?.toFixed(2) ?? DASH}×</td>
                    <td className={cn('px-4 py-2 text-right tabular-nums', varianceTone(s.premium))}>{usdSigned(s.premium)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="px-4 py-2 text-xs text-muted-foreground">
              The agreement permits +50% past 180 days, +100% past 365 and +200% past 541 — so this
              is probably valid. It is unverifiable without an aging report, and a rising multiple is
              an inventory signal, not a billing one.
            </p>
          </section>
        )}
      </div>
    </div>
  );
}
