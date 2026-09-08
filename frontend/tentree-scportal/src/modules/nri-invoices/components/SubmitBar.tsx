'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { CheckCircle2, Loader2, Lock, Trash2, Copy } from 'lucide-react';
import { submitInvoice, deleteInvoice } from '../actions';
import { usd, num, DASH } from './shared';
import type { InvoiceDetail } from '../types';

/**
 * Submit freezes the invoice and produces the posting lines (GL × class).
 * It refuses while any line carrying value has no GL or class, and while the
 * detail does not tie to the invoice — those are the two ways a wrong number
 * would reach the ledger.
 */
export default function SubmitBar({ invoice }: { invoice: InvoiceDetail }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const submitted = invoice.status === 'submitted';
  const t = invoice.totals;
  const blockers = invoice.findings.filter(f => f.severity === 'blocker');
  const uncoded = invoice.lines.filter(l => l.coding_status !== 'coded' && Math.abs(l.inv_amt) > 0.005).length;
  const tieBroken = invoice.tie_out.status === 'out_of_balance';

  const blockReason = tieBroken
    ? 'The detail does not tie to the invoice.'
    : uncoded > 0
      ? `${uncoded} line${uncoded === 1 ? '' : 's'} carrying value still need a GL or class.`
      : null;

  const onSubmit = async () => {
    setBusy(true);
    const res = await submitInvoice(invoice.invoice_no);
    setBusy(false);
    if (res?.error) {
      toast.error(res.message || res.error);
      return;
    }
    toast.success(`Invoice ${invoice.invoice_no} submitted.`);
    router.refresh();
  };

  const onDelete = async () => {
    setBusy(true);
    const res = await deleteInvoice(invoice.invoice_no);
    setBusy(false);
    setConfirmDelete(false);
    if (res?.error) return toast.error(res.error);
    toast.success('Invoice un-loaded. Line decisions were kept.');
    router.push('/nri-invoices');
  };

  const copyPosting = async () => {
    const rows = invoice.posting?.length
      ? invoice.posting
      : invoice.by_gl.flatMap(g => g.classes.map(c => ({ gl: g.gl, gl_desc: g.gl_desc, class: c.class, amount: c.amount })));
    const tsv = ['GL\tAccount\tClass\tAmount']
      .concat(rows
        .filter(r => Math.abs(r.amount) > 0.005)
        .map(r => `${r.gl ?? ''}\t${r.gl_desc ?? ''}\t${r.class}\t${r.amount.toFixed(2)}`))
      .join('\n');
    try {
      await navigator.clipboard.writeText(tsv);
      toast.success('Posting lines copied as TSV.');
    } catch {
      toast.error('Could not copy to the clipboard.');
    }
  };

  return (
    <>
      <section className={cn('rounded-lg border px-4 py-3',
        submitted ? 'border-emerald-500/40 bg-emerald-500/5' : 'border-border bg-card')}>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <div>
            <p className="flex items-center gap-2 text-lg font-semibold">
              Invoice {invoice.invoice_no}
              {submitted && (
                <Badge variant="outline" className="border-emerald-500/30 bg-emerald-500/10 font-normal text-emerald-700 dark:text-emerald-300">
                  <Lock className="mr-1 h-3 w-3" /> submitted
                </Badge>
              )}
            </p>
            <p className="text-xs text-muted-foreground">
              {invoice.invoice_date ?? DASH}
              {invoice.due_date ? ` · due ${invoice.due_date}` : ''}
              {invoice.payment_terms ? ` · ${invoice.payment_terms}` : ''}
              {invoice.override_count > 0 ? ` · ${invoice.override_count} manual decision${invoice.override_count === 1 ? '' : 's'}` : ''}
            </p>
          </div>

          <dl className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
            <Stat label="Total" value={usd(t.amount)} strong />
            <Stat label="Lines" value={num(t.lines)} />
            <Stat label="Coded" value={`${num(t.coded)}/${num(t.lines)}`} />
            <Stat label="Verified vs agreement" value={num(t.validated_ok)} />
            {blockers.length > 0 && (
              <Stat label="Blockers" value={num(blockers.length)} tone="text-red-600 dark:text-red-400" />
            )}
          </dl>

          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={copyPosting}>
              <Copy className="mr-2 h-4 w-4" /> Copy posting lines
            </Button>
            {!submitted && (
              <>
                <Button size="sm" onClick={onSubmit} disabled={busy || !!blockReason} title={blockReason ?? undefined}>
                  {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-2 h-4 w-4" />}
                  Submit
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(true)} disabled={busy}>
                  <Trash2 className="h-4 w-4" />
                  <span className="sr-only">Un-load invoice</span>
                </Button>
              </>
            )}
          </div>
        </div>

        {blockReason && !submitted && (
          <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">{blockReason}</p>
        )}
        {submitted && invoice.submitted_by && (
          <p className="mt-2 text-xs text-muted-foreground">
            Submitted by {invoice.submitted_by}
            {invoice.submitted_at ? ` on ${invoice.submitted_at.slice(0, 10)}` : ''}. Un-load and reload to change it.
          </p>
        )}
      </section>

      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Un-load invoice {invoice.invoice_no}?</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground">
            Removes the header and all {num(t.lines)} lines. Your {invoice.override_count} line
            decision{invoice.override_count === 1 ? '' : 's'} are kept, so re-uploading the same
            invoice number restores them.
          </p>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setConfirmDelete(false)} disabled={busy}>Cancel</Button>
            <Button variant="destructive" onClick={onDelete} disabled={busy}>
              {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} Un-load
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

function Stat({ label, value, strong, tone }: { label: string; value: string; strong?: boolean; tone?: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={cn('tabular-nums', strong && 'font-semibold', tone)}>{value}</dd>
    </div>
  );
}
