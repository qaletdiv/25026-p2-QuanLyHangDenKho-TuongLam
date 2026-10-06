'use client';

/**
 * Upload → check → save, and the year's files kept for reference.
 *
 * This is the folder the team used to save NRI's CSVs into, plus the checks the
 * workbook never made: the invoice number and period are read off the report,
 * a re-send of a file already held is caught (2026 has one — June 1 IS the
 * May 31 invoice), and the rate check runs before anything is saved.
 *
 * "Booked" = already posted in NetSuite. A booked file cannot be replaced,
 * deleted or re-coded until it is deliberately unlocked.
 */

import { useMemo, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { AlertTriangle, FileSpreadsheet, Loader2, Lock, LockOpen, RefreshCw, Trash2, Upload, X, BarChart3 } from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';
import DataTable, { type DataColumn } from '@/modules/mainline/components/DataTable';
import ConfirmDialog from '@/modules/mainline/components/ConfirmDialog';
import { uploadBillingFile, setFileLocked, deleteBillingFile, uploadBillingOrderData, syncOrderDataFromNetsuite } from '../actions';
import { EntitySwitch, money, count, fmtDate, DASH } from './shared';
import BucketStrip from './BucketStrip';
import ReviewDialog from './ReviewDialog';
import type { BillingFile, Entity, OrderDataStatus, OrderSyncResult, UploadResult } from '../types';

type Files = Record<Entity, { files: BillingFile[]; orderDataRows: number }>;

export default function UploadsView({ initial, orderData }: { initial: Files; orderData: Record<Entity, OrderDataStatus | null> }) {
  const router = useRouter();
  const [entity, setEntity] = useState<Entity>('CA');
  const { files } = initial[entity];
  // the review that follows an upload (and reopens from the list)
  const [reviewId, setReviewId] = useState<string | null>(null);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <EntitySwitch value={entity} onChange={setEntity} />
      </div>
      <OrderData entity={entity} status={orderData[entity]} onDone={() => router.refresh()} />
      <UploadPanel key={entity} entity={entity} onSaved={(id) => { router.refresh(); setReviewId(id); }} />
      <FileList entity={entity} files={files} onChanged={() => router.refresh()} onReview={setReviewId} />
      <ReviewDialog fileId={reviewId} open={!!reviewId} onClose={() => { setReviewId(null); router.refresh(); }} />
    </div>
  );
}

// ─── Upload: preview first, then save ────────────────────────────────────────

function UploadPanel({ entity, onSaved }: { entity: Entity; onSaved: (id: string) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<UploadResult | null>(null);
  const [blocked, setBlocked] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const build = (extra: Record<string, string> = {}) => {
    const fd = new FormData();
    fd.append('file', file as File);
    fd.append('entity', entity);
    for (const [k, v] of Object.entries(extra)) fd.append(k, v);
    return fd;
  };
  const reset = () => { setFile(null); setPreview(null); setBlocked(null); if (ref.current) ref.current.value = ''; };

  const check = (f: File) => {
    setFile(f); setPreview(null); setBlocked(null);
    const fd = new FormData();
    fd.append('file', f); fd.append('entity', entity); fd.append('dryRun', 'true');
    start(async () => {
      const res = await uploadBillingFile(fd);
      if ('error' in res) {
        if (res.error === 'locked') setBlocked(res.message ?? 'That file is booked.');
        else toast.error(res.message || res.error);
        return;
      }
      setPreview(res);
    });
  };

  const save = (force: boolean) => {
    start(async () => {
      const res = await uploadBillingFile(build(force ? { force: 'true' } : {}));
      if ('error' in res) return void toast.error(res.message || res.error);
      toast.success(`${res.fileName} saved — ${count(res.lineCount)} lines, ${money(res.charges)}`
        + (res.overridesCarried ? ` · ${count(res.overridesCarried)} manual codings kept` : ''));
      reset();
      onSaved(res.id);
    });
  };

  const dup = preview?.duplicates?.[0];

  return (
    <section className="rounded-lg border border-border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5">
        <h2 className="text-sm font-semibold">Upload an NRI {entity} invoice report</h2>
        <span className="text-xs text-muted-foreground">The “Invoice Details Report” .csv exactly as NRI sends it</span>
      </div>

      <div className="space-y-4 p-4">
        <input ref={ref} type="file" accept=".csv,.xlsx" className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) check(f); }} />

        {!file ? (
          <button
            type="button"
            onClick={() => ref.current?.click()}
            className="flex w-full flex-col items-center gap-1.5 rounded-md border border-dashed border-border px-6 py-8 text-sm text-muted-foreground transition-colors hover:border-primary hover:text-foreground"
          >
            <Upload className="h-5 w-5" />
            Choose a file — it is checked before anything is saved
          </button>
        ) : (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <FileSpreadsheet className="h-4 w-4 text-muted-foreground" />
            <span className="font-medium">{file.name}</span>
            {pending && !preview && <span className="inline-flex items-center gap-1 text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Checking…</span>}
            <Button size="sm" variant="ghost" onClick={reset} aria-label="Clear"><X className="h-3.5 w-3.5" /></Button>
          </div>
        )}

        {blocked && (
          <p className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-sm text-amber-800 dark:text-amber-200">
            <Lock className="mt-0.5 h-4 w-4 shrink-0" /> {blocked}
          </p>
        )}

        {preview && (
          <div className="space-y-4">
            <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-3 lg:grid-cols-6">
              <Fact label="Invoice #" value={preview.invoiceNo ?? DASH} />
              <Fact label="Period ending" value={fmtDate(preview.periodEnd)} />
              <Fact label="Lines" value={count(preview.lineCount)} />
              <Fact label="Charges" value={money(preview.charges)} strong />
              <Fact label="Taxes" value={money(preview.taxes)} />
              <Fact label="Invoice amount" value={money(preview.invAmt)} />
            </dl>

            <OrderDataNote r={preview.orderData} />

            {preview.replaces && (
              <p className="text-sm text-muted-foreground">
                Replaces <span className="font-medium text-foreground">{preview.replaces.fileName}</span> ({count(preview.replaces.lineCount)} lines).
                {' '}{count(preview.overridesCarried)} manual codings carry across
                {preview.overridesDropped > 0 && <>, <span className="text-amber-700 dark:text-amber-300">{count(preview.overridesDropped)} no longer match a line and will be dropped</span></>}.
              </p>
            )}

            {dup && (
              <p className="flex items-start gap-2 rounded-md border border-red-500/40 bg-red-500/5 px-3 py-2 text-sm text-red-800 dark:text-red-200">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  {count(dup.shared)} of these lines ({money(dup.charges)}) are already in <b>{dup.fileName}</b> — this looks like
                  the same invoice sent twice. Saving it would count those charges twice.
                </span>
              </p>
            )}

            <div className="space-y-2">
              <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Rate check</h3>
              {!preview.cardLoaded && <p className="text-sm text-amber-700 dark:text-amber-300">No NRI {entity} rate card is loaded, so nothing can be verified yet.</p>}
              <BucketStrip buckets={preview.rateCheck.buckets} total={preview.charges} />
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {dup ? (
                <Button variant="destructive" disabled={pending} onClick={() => save(true)}>
                  {pending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />} Save anyway — NRI really billed these twice
                </Button>
              ) : (
                <Button disabled={pending} onClick={() => save(false)}>
                  {pending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />} Save {preview.replaces ? 'and replace' : 'invoice'}
                </Button>
              )}
              <Button variant="outline" disabled={pending} onClick={reset}>Cancel</Button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

/** What the upload did about order data before coding the lines. */
const REF_LABEL = { returns: 'return authorization', fulfilments: 'older fulfilment', salesOrders: 'sales order', purchaseOrders: 'purchase order' } as const;
function refsText(r: NonNullable<OrderSyncResult['refsResolved']>) {
  return Object.entries(r.byKind ?? {})
    .filter(([, v]) => v && v.fetched > 0)
    .map(([k, v]) => `${count(v!.fetched)} ${REF_LABEL[k as keyof typeof REF_LABEL]}${v!.fetched === 1 ? '' : 's'}`)
    .join(', ');
}

function OrderDataNote({ r }: { r?: UploadResult['orderData'] }) {
  if (!r) return null;
  if (r.error) {
    return (
      <p className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-sm text-amber-800 dark:text-amber-200">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <span>{r.error}. Lines are coded with the order data already held — sync again before saving if this invoice is newer.</span>
      </p>
    );
  }
  return (
    <p className="text-sm text-muted-foreground">
      {r.ran
        ? <>Order data refreshed from NetSuite through <b className="text-foreground">{fmtDate(r.syncedThrough ?? null)}</b> — {count(r.fetched)} fulfilments, {count(r.added)} new orders.</>
        : <>Order data already current through <b className="text-foreground">{fmtDate(r.syncedThrough ?? null)}</b>.</>}
      {r.refsResolved && r.refsResolved.fetched > 0 && <> Fetched by reference: {refsText(r.refsResolved)}.</>}
      {(r.refsResolved?.newTypes ?? []).length > 0 && (
        <> New order type{r.refsResolved!.newTypes!.length === 1 ? '' : 's'} placed in Rules step 1:{' '}
          {r.refsResolved!.newTypes!.map((t) => `${t.type} → ${t.channel}`).join(', ')}.</>
      )}
    </p>
  );
}

function Fact({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={strong ? 'text-base font-semibold tabular-nums' : 'tabular-nums'}>{value}</dd>
    </div>
  );
}

// ─── Order data (Order Type → channel) ───────────────────────────────────────

function OrderData({ entity, status, onDone }: { entity: Entity; status: OrderDataStatus | null; onDone: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const [syncing, startSync] = useTransition();
  const [uploading, startUpload] = useTransition();

  const sync = () => startSync(async () => {
    const res = await syncOrderDataFromNetsuite(entity);
    if ('error' in res) return void toast.error(res.error);
    const types = res.newTypes?.length ? ` · new order types placed in Rules: ${res.newTypes.map((t) => `${t.type} → ${t.channel}`).join(', ')}` : '';
    toast.success(`Order data synced through ${fmtDate(res.syncedThrough ?? null)} — ${count(res.fulfilments?.fetched ?? res.fetched)} fulfilments, ${count(res.returns?.fetched ?? 0)} return authorizations, ${count(res.added)} new${types}`);
    onDone();
  });
  const upload = (file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('warehouse', entity === 'CA' ? 'nri-ca' : 'nri-us');
    startUpload(async () => {
      const res = await uploadBillingOrderData(fd);
      if (ref.current) ref.current.value = '';
      if ('error' in res) return void toast.error(res.error);
      toast.success(`Order data: ${count(res.read)} rows read, ${count(res.added)} new orders.`);
      onDone();
    });
  };

  const current = status?.syncedThrough;
  return (
    <section className="rounded-lg border border-border bg-card">
      <div className="flex flex-wrap items-center gap-3 px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold">Order data <span className="font-normal text-muted-foreground">· the Order Type lookup for each order and return line</span></h2>
          <p className="text-xs text-muted-foreground">
            {current
              ? <>From NetSuite Item Fulfillments and Return Authorizations ({status?.locationPrefix} locations), current through <b className="text-foreground">{fmtDate(current)}</b>
                  {' · '}{count(status?.orders)} orders
                  {status && status.fromFile > 0 && <> ({count(status.fromFile)} only from an uploaded file)</>}
                  {status?.lastSync && <> · last synced {new Date(status.lastSync.at).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}{status.lastSync.by ? ` by ${status.lastSync.by}` : ''}</>}</>
              : <span className="text-amber-700 dark:text-amber-300">Not synced from NetSuite yet — {count(status?.orders)} orders held from uploaded files.</span>}
          </p>
          <p className="text-xs text-muted-foreground">Uploading an invoice refreshes this through the invoice’s period end automatically.</p>
        </div>
        <div className="flex items-center gap-2">
          <input ref={ref} type="file" accept=".csv,.xlsx" className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); }} />
          <Button size="sm" variant="ghost" disabled={uploading || syncing} onClick={() => ref.current?.click()}
            title="Fallback: the NRI order data sheet or a CSV export">
            {uploading ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Upload className="mr-1.5 h-3.5 w-3.5" />}
            Upload a file instead
          </Button>
          <Button size="sm" variant="outline" disabled={syncing || uploading} onClick={sync}>
            {syncing ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1.5 h-3.5 w-3.5" />}
            {syncing ? 'Syncing…' : 'Sync from NetSuite'}
          </Button>
        </div>
      </div>
    </section>
  );
}

// ─── The year's files ────────────────────────────────────────────────────────

function FileList({ entity, files, onChanged, onReview }: {
  entity: Entity; files: BillingFile[]; onChanged: () => void; onReview: (id: string) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<BillingFile | null>(null);

  const toggle = async (f: BillingFile) => {
    setBusy(f.id);
    const res = await setFileLocked(f.id, !f.locked);
    setBusy(null);
    if ('error' in res) return void toast.error(res.error);
    toast.success(`${f.fileName} ${f.locked ? 'reopened' : 'marked as booked'}.`);
    onChanged();
  };

  const remove = async () => {
    if (!confirm) return;
    setBusy(confirm.id);
    const res = await deleteBillingFile(confirm.id);
    setBusy(null);
    setConfirm(null);
    if ('error' in res) return void toast.error(res.error);
    toast.success(`Deleted — ${count(res.lines)} lines removed.`);
    onChanged();
  };

  const total = useMemo(() => files.reduce((s, f) => s + (f.charges ?? 0), 0), [files]);

  const columns: DataColumn<BillingFile>[] = useMemo(() => [
    { key: 'fileName', label: 'File', render: (f) => <span className="font-medium">{f.fileName}</span> },
    { key: 'invoiceNo', label: 'Invoice #', render: (f) => f.invoiceNo ?? <span className="text-muted-foreground">{DASH}</span> },
    { key: 'periodEnd', label: 'Period ending', render: (f) => fmtDate(f.periodEnd) },
    { key: 'lineCount', label: 'Lines', align: 'right', render: (f) => <span className="tabular-nums">{count(f.lineCount)}</span> },
    { key: 'charges', label: 'Charges', align: 'right', render: (f) => <span className="tabular-nums">{money(f.charges)}</span> },
    { key: 'taxes', label: 'Taxes', align: 'right', defaultVisible: false, render: (f) => <span className="tabular-nums">{money(f.taxes)}</span> },
    { key: 'invAmt', label: 'Invoice amt', align: 'right', render: (f) => <span className="tabular-nums">{money(f.invAmt)}</span> },
    {
      key: 'confirmedAt', label: 'Review', accessor: (f) => (f.locked ? 2 : f.confirmedAt ? 1 : 0),
      render: (f) => (f.locked
        ? <span className="text-xs text-muted-foreground">Booked</span>
        : f.confirmedAt
          ? (
            <button type="button" onClick={() => onReview(f.id)} className="text-xs text-emerald-700 hover:underline dark:text-emerald-300"
              title={`Confirmed ${fmtDate(f.confirmedAt)}${f.confirmedBy ? ` by ${f.confirmedBy}` : ''} — click to review again`}>
              ✓ Confirmed
            </button>
          )
          : (
            <Button size="sm" variant="outline" className="h-7 border-amber-500/60 text-amber-700 dark:text-amber-300" onClick={() => onReview(f.id)}>
              Needs review
            </Button>
          )),
    },
    {
      key: 'locked', label: 'Booked', accessor: (f) => (f.locked ? 1 : 0),
      render: (f) => (
        <Button size="sm" variant="ghost" disabled={busy === f.id} onClick={() => toggle(f)}
          title={f.locked ? 'Booked in NetSuite — click to reopen for changes' : 'Mark as booked in NetSuite (freezes its coding)'}>
          {f.locked ? <><Lock className="mr-1 h-3.5 w-3.5" /> Booked</> : <><LockOpen className="mr-1 h-3.5 w-3.5 text-muted-foreground" /> Open</>}
        </Button>
      ),
    },
    { key: 'uploadedAt', label: 'Uploaded', defaultVisible: false, render: (f) => `${fmtDate(f.uploadedAt)}${f.uploadedBy ? ` · ${f.uploadedBy}` : ''}` },
    {
      key: 'actions', label: '', sortable: false,
      render: (f) => (
        <div className="flex justify-end gap-1">
          <Link
            href={`/invoices/results?entity=${entity}&files=${encodeURIComponent(f.id)}`}
            title="Cost per GL for this file"
            aria-label="Cost per GL for this file"
            className={buttonVariants({ variant: 'ghost', size: 'sm' })}
          >
            <BarChart3 className="h-3.5 w-3.5" />
          </Link>
          <span title={f.locked ? 'Reopen it first — a booked file cannot be deleted' : 'Delete this file and its lines'}>
            <Button size="sm" variant="ghost" disabled={f.locked || busy === f.id} onClick={() => setConfirm(f)} aria-label="Delete">
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </span>
        </div>
      ),
    },
  ], [busy, entity, onReview]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <DataTable
        title={`NRI ${entity} invoices on file · ${money(total)}`}
        noun="file"
        rows={files}
        columns={columns}
        rowKey={(f) => f.id}
        pageSize={24}
        storageKey="nri-billing-files-cols"
        initialSort={{ key: 'periodEnd', dir: 'desc' }}
        emptyText={`No NRI ${entity} invoices uploaded yet`}
        searchPlaceholder="Search file or invoice #…"
      />
      <ConfirmDialog
        open={!!confirm}
        title="Delete this invoice file?"
        description={confirm ? <>“{confirm.fileName}” and its {count(confirm.lineCount)} lines, including any manual coding, will be removed from the year’s results.</> : ''}
        confirmLabel="Delete"
        destructive
        busy={!!busy}
        onConfirm={remove}
        onCancel={() => setConfirm(null)}
      />
    </>
  );
}
