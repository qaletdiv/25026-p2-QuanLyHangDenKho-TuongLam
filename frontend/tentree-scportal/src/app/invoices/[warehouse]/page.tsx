import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { AlertTriangle, CheckCircle2, HelpCircle, TrendingUp, Lock, Settings2 } from 'lucide-react';
import { getInvoices, getCostSummary, getInvoiceSources } from '@/modules/nri-invoices/actions';
import { GlClassMatrix } from '@/modules/nri-invoices/components/GlClassPivot';
import UploadVerify from '@/modules/nri-invoices/components/UploadVerify';
import { usd, usdSigned, num, varianceTone, DASH } from '@/modules/nri-invoices/components/shared';

// One warehouse's invoices — upload + the loaded invoice list + cross-invoice
// analysis (the checks no single invoice can see: a monthly fee billed twice,
// the storage aging trend). Scoped by the `warehouse` segment, which is the
// registry code ('nri-us'); every fetch here is filtered to that warehouse, so
// two warehouses can never pool their invoices or their GL totals.
export default async function WarehouseInvoicesPage({ params }: { params: Promise<{ warehouse: string }> }) {
  const { warehouse } = await params;
  const sources = await getInvoiceSources();
  const source = sources.find((s) => s.code === warehouse);
  if (!source) notFound();

  const [invoices, summary] = await Promise.all([getInvoices(warehouse), getCostSummary(warehouse)]);

  return (
    <div className="space-y-6">
      {/* The order of the work, stated once: the two lookups are configured on the
          Setup page, then each invoice is uploaded here. Without the order data the
          class cannot be derived at all, so the link is not buried in a menu. */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-muted/20 px-4 py-2 text-xs text-muted-foreground">
        <span>
          <strong className="text-foreground">1.</strong> Coding legend + order data →
          <strong className="text-foreground"> 2.</strong> upload the invoice PDF &amp; charge detail →
          <strong className="text-foreground"> 3.</strong> confirm anything flagged →
          <strong className="text-foreground"> 4.</strong> the GL × Class result
        </span>
        <Link href={`/invoices/${warehouse}/setup`} className="inline-flex items-center gap-1.5 font-medium text-primary hover:underline">
          <Settings2 className="h-3.5 w-3.5" /> Setup — legend &amp; order data
        </Link>
      </div>

      {/* Uploads exist only where a detail-file layout is mapped. A warehouse
          without one is a working shell — its list, legend slice and rate card are
          real — so the page says WHY rather than hiding an upload box and leaving
          you to wonder. */}
      {source.uploadEnabled ? (
        <UploadVerify warehouse={source.code} label={source.label} />
      ) : (
        <section className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-amber-700 dark:text-amber-300">
            <Lock className="h-4 w-4" /> Uploads are not enabled for {source.label} yet
          </h2>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            {source.note
              ?? `${source.label} has no verified invoice-file layout yet. Every 3PL builds its detail workbook differently, so send a sample invoice (the detail workbook, plus the PDF if there is one) to have its format mapped — guessing a layout would load misread charges into the GL.`}
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            Everything else is already in place for it: this invoice list, its slice of the coding legend
            {source.entity ? ` (entity ${source.entity})` : ''} and the rate agreement.
          </p>
        </section>
      )}

      {invoices.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No invoices loaded for {source.label} yet.
        </p>
      )}

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
                      <Link href={`/invoices/${warehouse}/${i.invoiceNo}`} className="font-medium text-primary hover:underline">
                        {i.invoiceNo}
                      </Link>
                      {!i.hasSummary && (
                        <Badge variant="outline" className="ml-2 border-amber-500/30 bg-amber-500/10 text-[10px] font-normal text-amber-700 dark:text-amber-300">
                          no PDF
                        </Badge>
                      )}
                    </td>
                    <td className="px-4 py-2 text-muted-foreground">{i.invoiceDate ?? DASH}</td>
                    <td className="px-4 py-2 text-muted-foreground">{i.dueDate ?? DASH}</td>
                    <td className="px-4 py-2 text-right font-medium tabular-nums">{usd(i.totals?.amount)}</td>
                    <td className="px-4 py-2">
                      {i.tieOutStatus === 'balanced' ? (
                        <span className="inline-flex items-center gap-1 text-xs text-emerald-700 dark:text-emerald-300">
                          <CheckCircle2 className="h-3.5 w-3.5" /> ties
                        </span>
                      ) : i.tieOutStatus === 'noSummary' ? (
                        <span className="inline-flex items-center gap-1 text-xs text-amber-700 dark:text-amber-300">
                          <HelpCircle className="h-3.5 w-3.5" /> unproven
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-xs text-red-700 dark:text-red-300">
                          <AlertTriangle className="h-3.5 w-3.5" /> {usdSigned(i.tieOutVariance)}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      {i.totals?.needsAttention > 0
                        ? <span className="font-medium text-amber-700 dark:text-amber-300">{num(i.totals.needsAttention)}</span>
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
  // byGl arrives at (gl × class × month) grain. Month is summed away — this is the
  // period-to-date total — but CLASS is not: it becomes a column. Summing the
  // classes together, as this did, produced one figure per GL that nobody can post,
  // since which class the cost lands in is the whole question the coding answers.
  const cells = summary.byGl.map((r) => ({
    gl: r.gl, glDesc: r.glDesc, class: r.class, amount: r.amount,
  }));

  return (
    <div className="space-y-4">
      <GlClassMatrix
        cells={cells}
        title="Cost per GL × Class"
        subtitle={`${summary.invoices} invoice${summary.invoices === 1 ? '' : 's'} · ${usd(summary.total)}`}
        flaggedHint="is still uncoded across these invoices — open the invoice below and code those lines. It stays in the grand total, so this always equals what the warehouse billed."
      />

      <div className="grid gap-4 lg:grid-cols-2">
        {summary.duplicateMonthlyFees.length > 0 && (
          <section className="rounded-lg border border-red-500/40 bg-red-500/5">
            <h2 className="flex items-center gap-2 border-b border-red-500/30 px-4 py-2.5 text-sm font-semibold text-red-700 dark:text-red-300">
              <AlertTriangle className="h-4 w-4" /> Monthly fee billed more than once
            </h2>
            <ul className="divide-y divide-red-500/20 text-sm">
              {summary.duplicateMonthlyFees.map(f => (
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

        {summary.storageAging.length > 0 && (
          <section className="rounded-lg border border-border bg-card">
            <h2 className="flex items-center gap-2 border-b border-border px-4 py-2.5 text-sm font-semibold">
              <TrendingUp className="h-4 w-4 text-primary" /> Storage aging premium
              <span className={cn('ml-auto font-semibold tabular-nums', varianceTone(summary.storagePremium))}>
                {usdSigned(summary.storagePremium)}
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
                {summary.storageAging.map((s, i) => (
                  <tr key={`${s.invoiceNo}-${i}`} className="border-b border-border last:border-0">
                    <td className="px-4 py-2 text-muted-foreground">{s.month ?? DASH}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{num(s.units)}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{s.effectiveRate?.toFixed(4) ?? DASH}</td>
                    <td className="px-4 py-2 text-right font-medium tabular-nums">{s.agingMultiple?.toFixed(2) ?? DASH}×</td>
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
