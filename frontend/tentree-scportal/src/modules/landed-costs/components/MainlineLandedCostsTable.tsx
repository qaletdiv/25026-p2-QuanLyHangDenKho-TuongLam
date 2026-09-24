'use client';

import { useMemo, useState } from 'react';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import Link from 'next/link';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Check, RotateCcw, FileJson, X, Download } from 'lucide-react';
import { cn } from '@/lib/utils';
import { landedCostExportHref } from '@/lib/api';
import { useSession } from '@/components/providers/SessionProvider';
import DataTable, { type DataColumn } from '@/modules/mainline/components/DataTable';
import {
  postMainlineLandedCost, previewMainlineNetsuite, unpostLandedCost,
  confirmMainlineReceiptMatch, clearMainlineReceiptMatch, rejectMainlineReceiptMatch, manualMainlineReceiptMatch,
} from '@/modules/landed-costs/actions';
import type { MainlineLandedCostRow, MainlineLandedCostMatch, MainlineLandedCostSplit } from '@/modules/landed-costs/types';

const DASH = '—';

// Same three constants as the SMS table (the two components are siblings, not a
// shared base): one FIXED status-pill size instead of the Badge's `w-fit`, and two
// pinned action slots so the preview icon keeps its x position whether the row is
// posted or shows the wider "Post" / "Posting…" button.
const STATUS_BADGE = 'w-32 justify-center';
const ICON_BTN = 'h-7 w-7 p-0';
const POST_SLOT = 'inline-flex h-7 w-16 items-center justify-end';
const usd = (n: number | null | undefined) =>
  `$${(Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const dim = (v: string | null | undefined) => <span className="text-muted-foreground">{v ?? DASH}</span>;
const irLabel = (m: MainlineLandedCostMatch) => m.netsuiteIrTranid || (m.netsuiteIrId ? `#${m.netsuiteIrId}` : null);

type Line = {
  key: string;
  shipmentId: string;
  shipmentNumber: string | null;
  mode: string | null;
  shipDate: string | null;
  poNumber: string;
  ciValue: number;
  freight: number;
  duty: number;
  commission: number;
  posted: MainlineLandedCostSplit['posted'];
  m?: MainlineLandedCostMatch;
  row: MainlineLandedCostRow;
};

// Per-PO block reason: posting is per PO, so gate on THIS PO's IR match (not the whole shipment).
function postBlockReason(l: Line): string | null {
  const r = l.row;
  if (!r.hasShippingData) return 'Upload packing data first (needed for the CI-value split)';
  // An ESTIMATE basis (FedEx/DHL) is postable as soon as there is a CI value and a
  // rate — there is no invoice to wait for. Only a FORWARDER shipment can be
  // "awaiting actual".
  if (r.isEstimate && !r.hasAmounts) return 'No mainline landed-cost rate configured — set one in Settings → Landed Cost Rates';
  if (r.awaitingActual) return 'Enter freight & duty on the shipment first';
  if (!l.m || !l.m.netsuiteIrId) return 'No Item Receipt matched — add the IR # first';
  if (!l.m.confirmed) return 'Confirm the IR match first';
  if (!r.pushEnabled) return 'NetSuite push is not enabled on the server';
  if (!r.pushAllowed) return 'This shipment is not enabled for push yet';
  return null;
}

export default function MainlineLandedCostsTable({ rows }: { rows: MainlineLandedCostRow[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { user } = useSession();
  const canEdit = !user || (user.permissions ? user.permissions.includes('landed_costs') : user.role === 'Admin');
  const [busy, setBusy] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ shipment: string; data: any } | null>(null);
  const [manualIr, setManualIr] = useState<Record<string, string>>({});

  const months = useMemo(
    () => [...new Set(rows.map((r) => r.shipMonth).filter(Boolean) as string[])].sort().reverse(),
    [rows],
  );
  // Month filter lives in the URL (?month=YYYY-MM) so it survives a reload / is
  // shareable. Default = the newest month with data; 'all' genuinely means ALL.
  // It used to read `month === 'all' && months.length ? months[0] : month`, which
  // silently coerced "All months" back to the newest month — so the option was a
  // no-op and the page showed 2 of 16 PO lines while claiming to show everything.
  // Same fix the SMS table already carries; do not reintroduce the coercion.
  const [month, setMonth] = useState<string>(() => searchParams.get('month') || months[0] || 'all');
  const effMonth = month;
  const changeMonth = (v: string) => {
    setMonth(v);
    const params = new URLSearchParams(Array.from(searchParams.entries()));
    if (v === 'all') params.delete('month'); else params.set('month', v);
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };

  const visibleRows = useMemo(
    () => (effMonth === 'all' ? rows : rows.filter((r) => r.shipMonth === effMonth)),
    [rows, effMonth],
  );

  const lines = useMemo<Line[]>(() => visibleRows.flatMap((r) => {
    const matchByPo = new Map((r.match ?? []).map((m) => [m.poNumber, m]));
    return r.split.map((s) => ({
      key: `${r.shipmentId}|${s.poNumber}`,
      shipmentId: r.shipmentId, shipmentNumber: r.shipmentNumber, mode: r.mode, shipDate: r.shipDate,
      poNumber: s.poNumber, ciValue: s.ciValue, freight: s.freight, duty: s.duty, commission: s.commission, posted: s.posted,
      m: matchByPo.get(s.poNumber), row: r,
    }));
  }), [visibleRows]);

  // counts are per-PO line now (each PO posts independently)
  const counts = useMemo(() => lines.reduce(
    (a, l) => { a[l.posted ? 'posted' : 'pending']++; return a; },
    { posted: 0, pending: 0 },
  ), [lines]);

  async function post(l: Line) {
    setBusy(l.key);
    const res = await postMainlineLandedCost(l.shipmentId, l.poNumber);
    setBusy(null);
    if (res?.error) return void toast.error(res.error);
    toast.success(`Posted & sent to NetSuite — ${l.poNumber}`);
    router.refresh();
  }
  async function unpost(l: Line) {
    if (!l.posted) return;
    setBusy(l.key);
    const res = await unpostLandedCost(l.posted.id);
    setBusy(null);
    if (res?.error) return void toast.error(res.error);
    toast.success(`Unposted ${l.poNumber}`);
    router.refresh();
  }
  async function confirmMatch(m: MainlineLandedCostMatch, shipmentId: string) {
    if (!m.receiptId) return;
    setBusy(shipmentId);
    const res = await confirmMainlineReceiptMatch(m.receiptId, shipmentId);
    setBusy(null);
    if (res?.error) return void toast.error(res.error);
    toast.success(`Matched ${m.poNumber} → ${irLabel(m)}`);
    router.refresh();
  }
  async function clearMatch(m: MainlineLandedCostMatch, shipmentId: string) {
    if (!m.receiptId) return;
    setBusy(shipmentId);
    const res = await clearMainlineReceiptMatch(m.receiptId);
    setBusy(null);
    if (res?.error) return void toast.error(res.error);
    toast.success('Match cleared');
    router.refresh();
  }
  // ✗ — "this is not the IR for this PO on this shipment". Recorded, so the
  // suggestion does not come back on the next read; the matcher offers the next one.
  async function rejectMatch(m: MainlineLandedCostMatch, shipmentId: string) {
    if (!m.receiptId) return;
    setBusy(shipmentId);
    const res = await rejectMainlineReceiptMatch(m.receiptId, shipmentId);
    setBusy(null);
    if (res?.error) return void toast.error(res.error);
    toast.success(`Rejected ${irLabel(m)} for ${m.poNumber}`);
    router.refresh();
  }
  async function manualAdd(shipmentId: string, poNumber: string) {
    const key = `${shipmentId}|${poNumber}`;
    const val = (manualIr[key] || '').trim();
    if (!val) return;
    setBusy(shipmentId);
    const res = await manualMainlineReceiptMatch(shipmentId, poNumber, val);
    setBusy(null);
    if (res?.error) return void toast.error(res.error);
    setManualIr((s) => ({ ...s, [key]: '' }));
    toast.success(`Matched ${poNumber} → ${val}`);
    router.refresh();
  }
  async function showPreview(r: MainlineLandedCostRow) {
    setBusy(r.shipmentId);
    const data = await previewMainlineNetsuite(r.shipmentId);
    setBusy(null);
    if (data?.error) return void toast.error(data.error);
    setPreview({ shipment: r.shipmentNumber || `Shipment ${r.shipmentId}`, data });
  }

  // Every state of this cell renders in the SAME fixed box — see the note in
  // LandedCostsTable. Answering a suggestion (✓/✗) used to resize the column
  // and reflow the whole table; h-7 (= the Action column's height) also keeps
  // every row the same height in every state.
  //
  // The "wrong IR? type the right one" override would make that box 22rem wide
  // on EVERY row, so it lives in an absolutely-positioned strip that covers the
  // cell on hover/focus instead: out of flow, so the column stays 13rem and
  // nothing moves when it appears.
  const IR_CELL = 'relative flex h-7 w-52 items-center gap-1 overflow-hidden';

  function matchControl(l: Line) {
    const m = l.m;
    if (!m) return <span className={cn(IR_CELL, 'text-muted-foreground')}>{DASH}</span>;
    const key = l.key;
    if (m.confirmed) {
      return (
        <span className={IR_CELL}>
          <span className="min-w-0 truncate font-medium text-emerald-600 dark:text-emerald-400">{irLabel(m)}</span>
          <Check className="h-3 w-3 shrink-0 text-emerald-600 dark:text-emerald-400" />
          {canEdit && !l.posted && (
            <Button size="sm" variant="ghost" className="h-6 w-6 shrink-0 p-0" disabled={busy !== null} title="Clear match" onClick={() => clearMatch(m, l.shipmentId)}><X className="h-3 w-3" /></Button>
          )}
        </span>
      );
    }
    if (m.netsuiteIrId) {
      return (
        <span className={cn(IR_CELL, 'group')}>
          {/* Identity of the suggestion. Hovering (or focusing) the cell swaps it
              for the override box below — same fixed footprint, so the swap is
              invisible to layout. ✓/✗ stay put and stay clickable throughout. */}
          <span className="flex min-w-0 items-center gap-1 group-hover:hidden group-focus-within:hidden">
            <span className="min-w-0 truncate text-muted-foreground">{irLabel(m)}{m.ambiguous ? ' ⚠' : ''}</span>
            <span className="shrink-0 text-muted-foreground text-[10px]">({m.confidence})</span>
          </span>
          {canEdit && (
            <>
              {/* override the auto-suggested IR — decline it and set the correct one */}
              <span className="hidden shrink-0 items-center gap-1 group-hover:flex group-focus-within:flex"
                title="Wrong IR? Type the correct IR number (e.g. IR65473) to override this suggestion">
                <Input value={manualIr[key] || ''} onChange={(e) => setManualIr((s) => ({ ...s, [key]: e.target.value }))} placeholder="IR #" className="h-6 w-20 text-xs" disabled={busy !== null} />
                <Button size="sm" variant="ghost" className="h-6 px-1.5 text-xs" disabled={busy !== null || !(manualIr[key] || '').trim()} onClick={() => manualAdd(l.shipmentId, l.poNumber)}>Change</Button>
              </span>
              {/* the suggestion is answered either way: ✓ accept, ✗ reject (recorded,
                  so the matcher offers the next candidate instead of this one) */}
              <Button size="sm" variant="outline" className="h-6 w-6 shrink-0 p-0 text-emerald-600 dark:text-emerald-400"
                disabled={busy !== null} title={`Confirm ${irLabel(m)} for ${m.poNumber}`}
                onClick={() => confirmMatch(m, l.shipmentId)}><Check className="h-3.5 w-3.5" /></Button>
              <Button size="sm" variant="outline" className="h-6 w-6 shrink-0 p-0 text-red-600 dark:text-red-400"
                disabled={busy !== null} title={`Reject — ${irLabel(m)} is not the receipt for this PO`}
                onClick={() => rejectMatch(m, l.shipmentId)}><X className="h-3.5 w-3.5" /></Button>
            </>
          )}
        </span>
      );
    }
    if (!canEdit) return <span className={cn(IR_CELL, 'text-amber-600 dark:text-amber-400')}>No IR</span>;
    return (
      <span className={IR_CELL} title="No Item Receipt matched — type the IR number (e.g. IR65377)">
        <Input value={manualIr[key] || ''} onChange={(e) => setManualIr((s) => ({ ...s, [key]: e.target.value }))} placeholder="IR #" className="h-6 w-24 shrink-0 text-xs" disabled={busy !== null} />
        <Button size="sm" variant="outline" className="h-6 shrink-0" disabled={busy !== null || !(manualIr[key] || '').trim()} onClick={() => manualAdd(l.shipmentId, l.poNumber)}>Add</Button>
      </span>
    );
  }

  const columns: DataColumn<Line>[] = [
    { key: 'shipmentNumber', label: 'Shipment', accessor: (l) => l.shipmentNumber || l.shipmentId, render: (l) => (
      <Link href={`/mainline/shipments/${l.shipmentId}`} className="text-primary hover:underline font-mono text-xs font-medium">{l.shipmentNumber || `Shipment ${l.shipmentId}`}</Link>
    ) },
    { key: 'mode', label: 'Mode', accessor: (l) => l.mode, render: (l) => dim(l.mode) },
    { key: 'courier', label: 'Carrier', defaultVisible: false, accessor: (l) => l.row.courier, render: (l) => dim(l.row.courier) },
    // Which basis produced these figures. A FedEx/DHL shipment has no traceable
    // freight & duty invoice, so it is estimated from the CI value at the module rate.
    { key: 'basis', label: 'Basis', accessor: (l) => l.row.basis, render: (l) => (
      l.row.isEstimate
        ? <Badge variant="outline" className="border-amber-500/40 text-amber-600 dark:text-amber-400"
            title={`Estimated from the commercial-invoice value at ${l.row.estimate.freightPct}% freight / ${l.row.estimate.dutyPct}% duty — ${l.row.courier ?? 'this carrier'} does not invoice them separately`}>
            Estimate {l.row.estimate.freightPct}/{l.row.estimate.dutyPct}
          </Badge>
        : <span className="text-muted-foreground text-xs">Actual</span>
    ) },
    { key: 'shipDate', label: 'Ship Date', accessor: (l) => l.shipDate, render: (l) => dim(l.shipDate) },
    { key: 'poNumber', label: 'PO', accessor: (l) => l.poNumber, render: (l) => <span className="font-medium text-xs">{l.poNumber}</span> },
    { key: 'ir', label: 'Item Receipt', accessor: (l) => l.m?.netsuiteIrTranid ?? '', render: (l) => matchControl(l) },
    { key: 'ir_date', label: 'IR Date', accessor: (l) => l.m?.receiptDate ?? '', render: (l) => dim(l.m?.receiptDate) },
    { key: 'ciValue', label: 'CI Value', align: 'right', accessor: (l) => l.ciValue, render: (l) => <span className="tabular-nums">{usd(l.ciValue)}</span> },
    { key: 'freight', label: 'Freight', align: 'right', accessor: (l) => l.freight, render: (l) => <span className="tabular-nums">{l.row.hasAmounts ? usd(l.freight) : DASH}</span> },
    { key: 'duty', label: 'Duty', align: 'right', accessor: (l) => l.duty, render: (l) => <span className="tabular-nums">{l.row.hasAmounts ? usd(l.duty) : DASH}</span> },
    { key: 'commission', label: 'Commission', align: 'right', accessor: (l) => l.commission, render: (l) => (
      l.commission > 0 ? <span className="tabular-nums">{usd(l.commission)}</span> : <span className="text-muted-foreground">{DASH}</span>
    ) },
    // "No amounts" only makes sense on the ACTUAL basis — an estimate has nothing to
    // wait for, so `awaitingActual` (not `!hasAmounts`) is what gates it now.
    { key: 'status', label: 'Status', accessor: (l) => l.posted ? 'Posted' : !l.row.hasShippingData ? 'No packing' : l.row.awaitingActual ? 'Awaiting invoices' : 'Pending', render: (l) => (
      l.posted
        ? <Badge variant="outline" className={cn(STATUS_BADGE, 'border-emerald-500/40 text-emerald-600 dark:text-emerald-400')}><Check className="h-3 w-3 mr-1" />Posted</Badge>
        : !l.row.hasShippingData
          ? <Badge variant="outline" className={cn(STATUS_BADGE, 'border-amber-500/40 text-amber-600 dark:text-amber-400')}>No packing</Badge>
          : l.row.awaitingActual
            ? <Badge variant="outline" className={cn(STATUS_BADGE, 'border-amber-500/40 text-amber-600 dark:text-amber-400')} title="Freight & duty invoices from the forwarder have not been entered on the shipment yet">Awaiting invoices</Badge>
            : <Badge variant="outline" className={cn(STATUS_BADGE, 'text-muted-foreground')}>Pending</Badge>
    ) },
    // Fixed-width for the same reason as the IR cell: Post → "Posting…" → the
    // unpost icon are three widths for one slot, so the column used to resize
    // on every click.
    { key: 'action', label: 'Action', align: 'right', sortable: false, accessor: () => '', render: (l) => {
      const blockReason = postBlockReason(l);
      return (
        <span className="inline-flex h-7 w-28 items-center justify-end gap-1 whitespace-nowrap">
          <Button size="sm" variant="ghost" className={ICON_BTN} disabled={busy !== null} title="Preview NetSuite payload" onClick={() => showPreview(l.row)}><FileJson className="h-3.5 w-3.5" /></Button>
          <span className={POST_SLOT}>
            {canEdit && (l.posted
              ? <Button size="sm" variant="ghost" className={ICON_BTN} disabled={busy !== null} title="Unpost this PO" onClick={() => unpost(l)}><RotateCcw className="h-3.5 w-3.5" /></Button>
              : <Button size="sm" variant="outline" className="h-7 px-2" disabled={busy !== null || !!blockReason} onClick={() => post(l)} title={blockReason || 'Post this PO & send to NetSuite'}>{busy === l.key ? 'Posting…' : 'Post'}</Button>)}
          </span>
        </span>
      );
    } },
  ];

  const toolbar = (
    <>
      <Select value={month} onValueChange={(v) => changeMonth(v ?? 'all')}>
        <SelectTrigger className="w-36">{effMonth === 'all' ? 'All months' : effMonth}</SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All months</SelectItem>
          {months.map((m) => <SelectItem key={m} value={m}>{m}</SelectItem>)}
        </SelectContent>
      </Select>
      <span className="text-xs text-muted-foreground whitespace-nowrap">{counts.pending} pending · {counts.posted} posted</span>
      {/* Exports what the month filter is showing — see the SMS table. */}
      <a href={landedCostExportHref('mainline', effMonth)} download
         className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'ml-auto')}>
        <Download className="h-3.5 w-3.5 mr-1" /> Export Excel
      </a>
    </>
  );

  return (
    <>
      <DataTable
        rows={lines}
        columns={columns}
        rowKey={(l) => l.key}
        noun="line"
        toolbar={toolbar}
        searchPlaceholder="Search shipment, PO, IR…"
        emptyText="No mainline shipments with landed cost yet."
        pageSize={20}
        initialSort={{ key: 'shipDate', dir: 'desc' }}
        storageKey="mainline_landed_cost_columns"
      />

      <Dialog open={preview !== null} onOpenChange={(o) => !o && setPreview(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><FileJson className="h-4 w-4" /> NetSuite Item Receipt — {preview?.shipment}</DialogTitle>
          </DialogHeader>
          {preview?.data && (
            <div className="space-y-3 text-sm">
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="border-amber-500/40 text-amber-600 dark:text-amber-400">Preview only — not sent</Badge>
                <span className="text-xs text-muted-foreground">{preview.data.payloads?.length} payload(s) · amounts from {preview.data.source}</span>
              </div>
              <pre className="bg-muted/50 rounded-md p-3 text-xs overflow-x-auto max-h-[50vh]">{JSON.stringify(preview.data.payloads, null, 2)}</pre>
              <p className="text-xs text-muted-foreground">
                One Item Receipt per PO. Duty → landedCosts category 2, Freight → category 5, Commission → category 7
                (only for suppliers with a commission rate, e.g. Pratibha), allocated by value; shipping method = Sea/Air
                by mode. This is what <strong>Post</strong> sends. Freight &amp; duty are entered on the shipment.
              </p>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
