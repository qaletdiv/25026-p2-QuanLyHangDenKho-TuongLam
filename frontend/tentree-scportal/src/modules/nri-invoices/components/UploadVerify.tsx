'use client';

import { useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { FileSpreadsheet, FileText, Upload, X, Loader2, ShieldAlert } from 'lucide-react';
import { previewInvoice, commitInvoice } from '../actions';
import ReconcileView from './ReconcileView';
import type { Reconcile } from '../types';

/**
 * Upload -> verify -> load, in that order and only that order.
 *
 * Preview runs the full reconcile and saves NOTHING, so a reviewer can see the
 * tie-out and the findings before anything reaches the GL. Loading is blocked
 * when the detail does not tie to the invoice, with a deliberate override —
 * because the block exists to make the mismatch a decision, not to hide it.
 */
export default function UploadVerify() {
  const router = useRouter();
  const [detail, setDetail] = useState<File | null>(null);
  const [invoice, setInvoice] = useState<File | null>(null);
  const [result, setResult] = useState<Reconcile | null>(null);
  const [pending, startTransition] = useTransition();
  const [committing, setCommitting] = useState(false);
  const detailRef = useRef<HTMLInputElement>(null);
  const invoiceRef = useRef<HTMLInputElement>(null);

  const build = () => {
    const fd = new FormData();
    fd.append('entity', 'US');
    if (detail) fd.append('detail', detail);
    if (invoice) fd.append('invoice', invoice);
    return fd;
  };

  const runPreview = () => {
    if (!detail) return toast.error('Choose the detail workbook first.');
    startTransition(async () => {
      const res = await previewInvoice(build());
      if ('error' in res) { toast.error(res.error); setResult(null); return; }
      setResult(res);
      const t = res.tie_out;
      if (t.status === 'balanced') toast.success(t.message);
      else if (t.status === 'no_summary') toast.warning('Loaded without an invoice PDF — the detail cannot be proven complete.');
      else toast.error(t.message);
    });
  };

  const runCommit = (force: boolean) => {
    if (!detail) return;
    setCommitting(true);
    const fd = build();
    if (force) fd.append('force', 'true');
    void (async () => {
      const res = await commitInvoice(fd);
      setCommitting(false);
      if (res?.error === 'tie_out_failed') { toast.error(res.message || 'The detail does not tie to the invoice.'); return; }
      if (res?.error) { toast.error(res.message || res.error); return; }
      toast.success(`Invoice ${res.invoice_no} loaded — ${res.lines} lines.`);
      setResult(null); setDetail(null); setInvoice(null);
      if (detailRef.current) detailRef.current.value = '';
      if (invoiceRef.current) invoiceRef.current.value = '';
      router.push(`/nri-invoices/${res.invoice_no}`);
    })();
  };

  const outOfBalance = result?.tie_out.status === 'out_of_balance';

  return (
    <div className="space-y-4">
      <section className="rounded-lg border border-border bg-card p-4">
        <div className="grid gap-3 md:grid-cols-2">
          <FilePick
            inputRef={detailRef}
            id="nri-detail"
            icon={FileSpreadsheet}
            accept=".xlsx"
            label="Detail workbook"
            hint="The source — NRI's line-level .xlsx (required)"
            file={detail}
            onPick={f => { setDetail(f); setResult(null); }}
          />
          <FilePick
            inputRef={invoiceRef}
            id="nri-invoice"
            icon={FileText}
            accept=".pdf"
            label="Invoice PDF"
            hint="The summary — carries the invoice number and control totals"
            file={invoice}
            onPick={f => { setInvoice(f); setResult(null); }}
          />
        </div>

        {!invoice && (
          <p className="mt-3 flex items-start gap-2 rounded border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
            <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            Without the PDF there is no invoice number and no control total, so the detail can be
            coded but never proven complete. NRI has not been filing the PDFs since 2022 — ask for
            them alongside the workbook.
          </p>
        )}

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button onClick={runPreview} disabled={!detail || pending}>
            {pending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}
            Verify
          </Button>
          {result && (
            <>
              <Button
                variant={outOfBalance ? 'outline' : 'default'}
                onClick={() => runCommit(false)}
                disabled={committing || outOfBalance}
              >
                {committing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Load invoice
              </Button>
              {outOfBalance && (
                <Button variant="destructive" onClick={() => runCommit(true)} disabled={committing}>
                  Load anyway (stays flagged)
                </Button>
              )}
            </>
          )}
          {result?.invoice?.invoice_no && (
            <Badge variant="outline" className="ml-auto font-normal">
              Invoice {result.invoice.invoice_no}
            </Badge>
          )}
        </div>
      </section>

      {result && <ReconcileView data={result} sourceFile={result.source_file ?? detail?.name ?? null} />}
    </div>
  );
}

function FilePick({
  inputRef, id, icon: Icon, accept, label, hint, file, onPick,
}: {
  inputRef: React.RefObject<HTMLInputElement | null>;
  id: string; icon: React.ElementType; accept: string; label: string; hint: string;
  file: File | null; onPick: (f: File | null) => void;
}) {
  return (
    <div className={cn('rounded-lg border border-dashed border-border p-3 transition-colors', file && 'border-solid bg-muted/20')}>
      <label htmlFor={id} className="flex cursor-pointer items-start gap-3">
        <Icon className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">{label}</span>
          <span className="mt-0.5 block text-xs text-muted-foreground">
            {file ? file.name : hint}
          </span>
        </span>
      </label>
      <input
        ref={inputRef}
        id={id}
        type="file"
        accept={accept}
        className="mt-2 block w-full text-xs text-muted-foreground file:mr-3 file:rounded file:border file:border-border file:bg-background file:px-2 file:py-1 file:text-xs hover:file:bg-muted"
        onChange={e => onPick(e.target.files?.[0] ?? null)}
      />
      {file && (
        <Button
          variant="ghost"
          size="sm"
          className="mt-1 h-7 px-2 text-xs"
          onClick={() => { onPick(null); if (inputRef.current) inputRef.current.value = ''; }}
        >
          <X className="mr-1 h-3 w-3" /> Clear
        </Button>
      )}
    </div>
  );
}
