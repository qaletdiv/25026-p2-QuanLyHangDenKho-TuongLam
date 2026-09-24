'use client';

/**
 * The two INPUTS that have to be configured before an invoice can be coded, each
 * with the evidence you need to trust it:
 *
 *  1. the CODING LEGEND — Service → GL, description, class per entity, notes. The
 *     basis for every GL on every line.
 *  2. the ORDER DATA — `OrderType` (channel) and `Ship To Country`, which appear
 *     NOWHERE on an invoice line. Without them the class cannot be derived and
 *     lines come back flagged, so coverage of this file is the limiting factor on
 *     how much of an invoice codes itself.
 *
 * Both were previously read off a mapped G: drive, which meant the pipeline only
 * worked on a machine that had it. Both can now be uploaded here.
 *
 * The legend upload runs a DRY RUN first and shows the file's defects — it is the
 * basis for the whole coding, so it gets inspected before it is adopted, not after.
 */

import { useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { AlertTriangle, CheckCircle2, FileSpreadsheet, RefreshCw, Upload } from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { syncChargeCodes, uploadOrderData } from '../actions';
import type { ChargeCode } from '../types';

type LegendResult = {
  source?: string; read?: number; written?: number; dryRun?: boolean;
  defects?: {
    duplicateKeys?: string[][]; whitespaceKeys?: string[];
    blankUsClass?: string[]; blankCaClass?: string[]; noGl?: string[];
  };
};

type OrderStatus = {
  entity: string; orders: number; storedRows: number;
  covers: { from: string; to: string } | null;
  sources: { label: string; rows?: number; added?: number; error?: string }[];
} | null;

const count = (n?: number) => (n ?? 0).toLocaleString();

/* ─────────────────────────────────────────────── legend ─────────────────── */

export function LegendPanel({
  codes, entity, warehouse,
}: { codes: ChargeCode[]; entity: string; warehouse: string }) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<LegendResult | null>(null);
  const [busy, startBusy] = useTransition();
  const [showAll, setShowAll] = useState(false);

  const build = (dryRun: boolean) => {
    const fd = new FormData();
    if (file) fd.append('legend', file);
    fd.append('warehouse', warehouse);
    if (dryRun) fd.append('dryRun', 'true');
    return fd;
  };

  const check = () => startBusy(async () => {
    const res = await syncChargeCodes(build(true));
    if ('error' in res) { setPreview(null); return void toast.error(res.error); }
    setPreview(res as LegendResult);
    toast.success(`Read ${(res as LegendResult).read} rows — review the defects, then adopt.`);
  });

  const adopt = () => startBusy(async () => {
    const res = await syncChargeCodes(build(false));
    if ('error' in res) return void toast.error(res.error);
    const r = res as LegendResult;
    toast.success(`Legend adopted — ${r.written} services now code from "${r.source}".`);
    setPreview(null); setFile(null);
    if (fileRef.current) fileRef.current.value = '';
    router.refresh();
  });

  const d = preview?.defects;
  const shown = showAll ? codes : codes.slice(0, 12);

  return (
    <section className="rounded-lg border border-border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5">
        <h2 className="text-sm font-semibold">
          Coding legend <span className="font-normal text-muted-foreground">· {count(codes.length)} services · the GL lookup basis</span>
        </h2>
        <div className="flex items-center gap-2">
          <input
            ref={fileRef} type="file" accept=".xlsx" className="hidden" id="legend-file"
            onChange={(e) => { setFile(e.target.files?.[0] ?? null); setPreview(null); }}
          />
          {/* a label styled as a button — Button has no asChild here, and the
              native file input must stay the click target for keyboard users */}
          <label htmlFor="legend-file" className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'cursor-pointer')}>
            <FileSpreadsheet className="mr-1.5 h-3.5 w-3.5" />{file ? file.name.slice(0, 28) : 'Choose legend .xlsx'}
          </label>
          <Button size="sm" variant="outline" disabled={busy} onClick={check}>
            <RefreshCw className={cn('mr-1.5 h-3.5 w-3.5', busy && 'animate-spin')} /> Check
          </Button>
          <Button size="sm" disabled={busy || !preview} onClick={adopt} title={preview ? 'Replace the coding legend with this file' : 'Check the file first'}>
            <Upload className="mr-1.5 h-3.5 w-3.5" /> Adopt
          </Button>
        </div>
      </div>

      {preview && (
        <div className="space-y-2 border-b border-border bg-muted/20 px-4 py-3 text-xs">
          <p className="font-medium">
            {preview.source} — read {count(preview.read)} rows, would write {count(preview.written)}
            {preview.read !== preview.written && <span className="text-muted-foreground"> (duplicates collapsed)</span>}
          </p>
          {d && (d.duplicateKeys?.length || d.whitespaceKeys?.length || d.blankUsClass?.length || d.noGl?.length) ? (
            <ul className="space-y-1 text-amber-700 dark:text-amber-300">
              {!!d.duplicateKeys?.length && (
                <li className="flex gap-1.5"><AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                  Duplicate service{d.duplicateKeys.length === 1 ? '' : 's'}: {d.duplicateKeys.map((g) => g.map((s) => `"${s}"`).join(' / ')).join('; ')} — the first wins here; in the workbook a duplicate key MULTIPLIES the charge.</li>
              )}
              {!!d.whitespaceKeys?.length && (
                <li className="flex gap-1.5"><AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                  Trailing/leading spaces in: {d.whitespaceKeys.map((s) => `"${s}"`).join(', ')} — matched anyway here (trim + case-fold).</li>
              )}
              {!!d.noGl?.length && (
                <li className="flex gap-1.5"><AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />No GL on: {d.noGl.join(', ')}</li>
              )}
              {!!d.blankUsClass?.length && (
                <li className="flex gap-1.5"><AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                  No US class on {d.blankUsClass.length}: {d.blankUsClass.slice(0, 4).join(', ')}{d.blankUsClass.length > 4 ? '…' : ''} — those lines flag rather than post unclassed.</li>
              )}
              {!!d.blankCaClass?.length && (
                <li className="flex gap-1.5"><AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />No CA class on {d.blankCaClass.length}.</li>
              )}
            </ul>
          ) : (
            <p className="flex items-center gap-1.5 text-emerald-700 dark:text-emerald-300"><CheckCircle2 className="h-3.5 w-3.5" /> No defects found.</p>
          )}
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-card/80">
            <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-2 font-medium">Service</th>
              <th className="px-4 py-2 font-medium">NetSuite GL</th>
              <th className="px-4 py-2 font-medium">Description</th>
              <th className="px-4 py-2 font-medium">Class ({entity})</th>
              <th className="px-4 py-2 font-medium">Notes</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((c) => {
              const cls = entity === 'CA' ? c.classCa : c.classUs;
              return (
                <tr key={c.id ?? c.service} className="border-b border-border last:border-0 hover:bg-muted/30">
                  <td className="px-4 py-1.5 font-medium">{c.service}</td>
                  <td className="px-4 py-1.5 font-mono text-xs">{c.gl ?? <span className="text-amber-600 dark:text-amber-400">none</span>}</td>
                  <td className="px-4 py-1.5 text-xs text-muted-foreground">{c.glDesc?.split(':').pop()?.trim() ?? '—'}</td>
                  <td className="px-4 py-1.5 text-xs">
                    {cls ?? <Badge variant="outline" className="border-amber-500/30 bg-amber-500/10 text-[10px] font-normal text-amber-700 dark:text-amber-300">flags</Badge>}
                  </td>
                  <td className="px-4 py-1.5 text-xs text-muted-foreground">{c.note ?? '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {codes.length > 12 && (
        <button onClick={() => setShowAll((s) => !s)} className="w-full border-t border-border px-4 py-2 text-xs text-muted-foreground hover:bg-muted/30">
          {showAll ? 'Show fewer' : `Show all ${count(codes.length)} services`}
        </button>
      )}
      <p className="border-t border-border px-4 py-2 text-[11px] text-muted-foreground">
        The legend fixes the GL per service. The CLASS on a line is derived from its
        ORDER (channel × ship-to country) and only falls back to this column — which is
        why the order data below matters as much as this file.
      </p>
    </section>
  );
}

/* ─────────────────────────────────────────── order data ─────────────────── */

export function OrderDataPanel({ status, warehouse }: { status: OrderStatus; warehouse: string }) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<{ read: number; added: number; updated: number; withOrderType: number; withCountry: number } | null>(null);

  const send = async () => {
    if (!file) return void toast.error('Choose the order-data file first.');
    setBusy(true);
    const fd = new FormData();
    fd.append('file', file);
    fd.append('warehouse', warehouse);
    const res = await uploadOrderData(fd);
    setBusy(false);
    if ('error' in res) return void toast.error(res.error);
    setLast(res);
    toast.success(`${count(res.read)} order rows read — ${count(res.added)} new, ${count(res.updated)} updated.`);
    setFile(null);
    if (fileRef.current) fileRef.current.value = '';
    router.refresh();
  };

  return (
    <section className="rounded-lg border border-border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5">
        <h2 className="text-sm font-semibold">
          Order data <span className="font-normal text-muted-foreground">· channel &amp; ship-to country · {count(status?.orders)} orders</span>
        </h2>
        <div className="flex items-center gap-2">
          <input
            ref={fileRef} type="file" accept=".xlsx,.csv" className="hidden" id="order-file"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
          <label htmlFor="order-file" className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'cursor-pointer')}>
            <FileSpreadsheet className="mr-1.5 h-3.5 w-3.5" />{file ? file.name.slice(0, 28) : 'Choose .xlsx or .csv'}
          </label>
          <Button size="sm" disabled={busy || !file} onClick={send}>
            <Upload className="mr-1.5 h-3.5 w-3.5" /> {busy ? 'Reading…' : 'Upload'}
          </Button>
        </div>
      </div>

      <div className="space-y-2 px-4 py-3 text-xs">
        <p className="text-muted-foreground">
          The <span className="font-medium text-foreground">NRI Order data</span> sheet from the combined workbook, or a
          period CSV. Matched on <code className="rounded bg-muted px-1">Order #</code>, and it supplies
          <code className="mx-1 rounded bg-muted px-1">OrderType</code> and
          <code className="mx-1 rounded bg-muted px-1">Ship To Country</code> — neither of which exists on an invoice
          line. Uploading a later period <strong>tops the master up</strong>; it never replaces it.
        </p>
        <div className="flex flex-wrap gap-x-6 gap-y-1">
          <span>Orders known: <strong>{count(status?.orders)}</strong></span>
          <span>Held in the portal: <strong>{count(status?.storedRows)}</strong></span>
          <span>Covers: <strong>{status?.covers ? `${status.covers.from} → ${status.covers.to}` : '—'}</strong></span>
        </div>
        {last && (
          <p className="text-emerald-700 dark:text-emerald-300">
            Last upload: {count(last.read)} rows · {count(last.added)} new · {count(last.updated)} updated ·
            {' '}{count(last.withOrderType)} with a channel · {count(last.withCountry)} with a country.
          </p>
        )}
        {!!status?.sources?.length && (
          <details className="text-muted-foreground">
            <summary className="cursor-pointer">Sources merged ({status.sources.length})</summary>
            <ul className="mt-1 space-y-0.5 pl-4">
              {status.sources.map((s, i) => (
                <li key={i} className={cn(s.error && 'text-red-600 dark:text-red-400')}>
                  {s.label}{s.error ? ` — ${s.error}` : ` — ${count(s.rows)} rows`}
                </li>
              ))}
            </ul>
          </details>
        )}
        <p className="text-muted-foreground">
          Coverage is the limiting factor on how much of an invoice codes itself: a line whose order is
          missing is flagged, never defaulted to wholesale.
        </p>
      </div>
    </section>
  );
}
