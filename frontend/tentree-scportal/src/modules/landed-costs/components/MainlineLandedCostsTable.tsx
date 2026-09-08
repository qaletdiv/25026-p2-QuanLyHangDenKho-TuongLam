'use client';

import { useMemo, useState } from 'react';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import Link from 'next/link';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Check, RotateCcw, FileJson, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useSession } from '@/components/providers/SessionProvider';
import DataTable, { type DataColumn } from '@/modules/mainline/components/DataTable';
import {
  postMainlineLandedCost, previewMainlineNetsuite, unpostLandedCost,
  confirmMainlineReceiptMatch, clearMainlineReceiptMatch, rejectMainlineReceiptMatch, manualMainlineReceiptMatch,
} from '@/modules/landed-costs/actions';
import type { MainlineLandedCostRow, MainlineLandedCostMatch, MainlineLandedCostSplit } from '@/modules/landed-costs/types';

const DASH = '—';
const usd = (n: number | null | undefined) =>
  `$${(Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const dim = (v: string | null | undefined) => <span className="text-muted-foreground">{v ?? DASH}</span>;
const irLabel = (m: MainlineLandedCostMatch) => m.netsuite_ir_tranid || (m.netsuite_ir_id ? `#${m.netsuite_ir_id}` : null);

type Line = {
  key: string;
  shipment_id: string;
  shipment_number: string | null;
  mode: string | null;
  ship_date: string | null;
  po_number: string;
  ci_value: number;
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
  if (!r.has_shipping_data) return 'Upload packing data first (needed for the CI-value split)';
  // An ESTIMATE basis (FedEx/DHL) is postable as soon as there is a CI value and a
  // rate — there is no invoice to wait for. Only a FORWARDER shipment can be
  // "awaiting actual".
  if (r.is_estimate && !r.has_amounts) return 'No mainline landed-cost rate configured — set one in Settings → Landed Cost Rates';
  if (r.awaiting_actual) return 'Enter freight & duty on the shipment first';
  if (!l.m || !l.m.netsuite_ir_id) return 'No Item Receipt matched — add the IR # first';
  if (!l.m.confirmed) return 'Confirm the IR match first';
  if (!r.push_enabled) return 'NetSuite push is not enabled on the server';
  if (!r.push_allowed) return 'This shipment is not enabled for push yet';
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
    () => [...new Set(rows.map((r) => r.ship_month).filter(Boolean) as string[])].sort().reverse(),
    [rows],
  );
  // month filter lives in the URL (?month=YYYY-MM) so it survives a reload / is shareable
  const [month, setMonth] = useState<string>(searchParams.get('month') || 'all');
  const effMonth = month === 'all' && months.length ? months[0] : month;
  const changeMonth = (v: string) => {
    setMonth(v);
    const params = new URLSearchParams(Array.from(searchParams.entries()));
    if (v === 'all') params.delete('month'); else params.set('month', v);
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };

  const visibleRows = useMemo(
    () => (effMonth === 'all' ? rows : rows.filter((r) => r.ship_month === effMonth)),
    [rows, effMonth],
  );

  const lines = useMemo<Line[]>(() => visibleRows.flatMap((r) => {
    const matchByPo = new Map((r.match ?? []).map((m) => [m.po_number, m]));
    return r.split.map((s) => ({
      key: `${r.shipment_id}|${s.po_number}`,
      shipment_id: r.shipment_id, shipment_number: r.shipment_number, mode: r.mode, ship_date: r.ship_date,
      po_number: s.po_number, ci_value: s.ci_value, freight: s.freight, duty: s.duty, commission: s.commission, posted: s.posted,
      m: matchByPo.get(s.po_number), row: r,
    }));
  }), [visibleRows]);

  // counts are per-PO line now (each PO posts independently)
  const counts = useMemo(() => lines.reduce(
    (a, l) => { a[l.posted ? 'posted' : 'pending']++; return a; },
    { posted: 0, pending: 0 },
  ), [lines]);

  async function post(l: Line) {
    setBusy(l.key);
    const res = await postMainlineLandedCost(l.shipment_id, l.po_number);
    setBusy(null);
    if (res?.error) return void toast.error(res.error);
    toast.success(`Posted & sent to NetSuite — ${l.po_number}`);
    router.refresh();
  }
  async function unpost(l: Line) {
    if (!l.posted) return;
    setBusy(l.key);
    const res = await unpostLandedCost(l.posted.id);
    setBusy(null);
    if (res?.error) return void toast.error(res.error);
    toast.success(`Unposted ${l.po_number}`);
    router.refresh();
  }
  async function confirmMatch(m: MainlineLandedCostMatch, shipmentId: string) {
    if (!m.receipt_id) return;
    setBusy(shipmentId);
    const res = await confirmMainlineReceiptMatch(m.receipt_id, shipmentId);
    setBusy(null);
    if (res?.error) return void toast.error(res.error);
    toast.success(`Matched ${m.po_number} → ${irLabel(m)}`);
    router.refresh();
  }
  async function clearMatch(m: MainlineLandedCostMatch, shipmentId: string) {
    if (!m.receipt_id) return;
    setBusy(shipmentId);
    const res = await clearMainlineReceiptMatch(m.receipt_id);
    setBusy(null);
    if (res?.error) return void toast.error(res.error);
    toast.success('Match cleared');
    router.refresh();
  }
  // ✗ — "this is not the IR for this PO on this shipment". Recorded, so the
  // suggestion does not come back on the next read; the matcher offers the next one.
  async function rejectMatch(m: MainlineLandedCostMatch, shipmentId: string) {
    if (!m.receipt_id) return;
    setBusy(shipmentId);
    const res = await rejectMainlineReceiptMatch(m.receipt_id, shipmentId);
    setBusy(null);
    if (res?.error) return void toast.error(res.error);
    toast.success(`Rejected ${irLabel(m)} for ${m.po_number}`);
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
    setBusy(r.shipment_id);
    const data = await previewMainlineNetsuite(r.shipment_id);
    setBusy(null);
    if (data?.error) return void toast.error(data.error);
    setPreview({ shipment: r.shipment_number || `Shipment ${r.shipment_id}`, data });
  }

  function matchControl(l: Line) {
    const m = l.m;
    if (!m) return <span className="text-muted-foreground">{DASH}</span>;
    const key = l.key;
    if (m.confirmed) {
      return (
        <span className="inline-flex items-center gap-1">
          <span className="font-medium text-emerald-600 dark:text-emerald-400">{irLabel(m)}</span>
          <Check className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />
          {canEdit && !l.posted && (
            <Button size="sm" variant="ghost" className="h-6 px-1" disabled={busy !== null} title="Clear match" onClick={() => clearMatch(m, l.shipment_id)}><X className="h-3 w-3" /></Button>
          )}
        </span>
      );
    }
    if (m.netsuite_ir_id) {
      return (
        <span className="inline-flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground">{irLabel(m)}{m.ambiguous ? ' ⚠' : ''}</span>
          <span className="text-muted-foreground text-[10px]">({m.confidence})</span>
          {canEdit && (
            <>
              {/* the suggestion is answered either way: ✓ accept, ✗ reject (recorded,
                  so the matcher offers the next candidate instead of this one) */}
              <Button size="sm" variant="outline" className="h-6 w-6 p-0 text-emerald-600 dark:text-emerald-400"
                disabled={busy !== null} title={`Confirm ${irLabel(m)} for ${m.po_number}`}
                onClick={() => confirmMatch(m, l.shipment_id)}><Check className="h-3.5 w-3.5" /></Button>
              <Button size="sm" variant="outline" className="h-6 w-6 p-0 text-red-600 dark:text-red-400"
                disabled={busy !== null} title={`Reject — ${irLabel(m)} is not the receipt for this PO`}
                onClick={() => rejectMatch(m, l.shipment_id)}><X className="h-3.5 w-3.5" /></Button>
              {/* override the auto-suggested IR — decline it and set the correct one */}
              <span className="inline-flex items-center gap-1" title="Wrong IR? Type the correct IR number (e.g. IR65473) to override this suggestion">
                <Input value={manualIr[key] || ''} onChange={(e) => setManualIr((s) => ({ ...s, [key]: e.target.value }))} placeholder="IR #" className="h-6 w-24 text-xs" disabled={busy !== null} />
                <Button size="sm" variant="ghost" className="h-6" disabled={busy !== null || !(manualIr[key] || '').trim()} onClick={() => manualAdd(l.shipment_id, l.po_number)}>Change</Button>
              </span>
            </>
          )}
        </span>
      );
    }
    if (!canEdit) return <span className="text-amber-600 dark:text-amber-400">No IR</span>;
    return (
      <span className="inline-flex items-center gap-1" title="No Item Receipt matched — type the IR number (e.g. IR65377)">
        <Input value={manualIr[key] || ''} onChange={(e) => setManualIr((s) => ({ ...s, [key]: e.target.value }))} placeholder="IR #" className="h-6 w-24 text-xs" disabled={busy !== null} />
        <Button size="sm" variant="outline" className="h-6" disabled={busy !== null || !(manualIr[key] || '').trim()} onClick={() => manualAdd(l.shipment_id, l.po_number)}>Add</Button>
      </span>
    );
  }

  const columns: DataColumn<Line>[] = [
    { key: 'shipment_number', label: 'Shipment', accessor: (l) => l.shipment_number || l.shipment_id, render: (l) => (
      <Link href={`/mainline/shipments/${l.shipment_id}`} className="text-primary hover:underline font-mono text-xs font-medium">{l.shipment_number || `Shipment ${l.shipment_id}`}</Link>
    ) },
    { key: 'mode', label: 'Mode', accessor: (l) => l.mode, render: (l) => dim(l.mode) },
    { key: 'courier', label: 'Carrier', defaultVisible: false, accessor: (l) => l.row.courier, render: (l) => dim(l.row.courier) },
    // Which basis produced these figures. A FedEx/DHL shipment has no traceable
    // freight & duty invoice, so it is estimated from the CI value at the module rate.
    { key: 'basis', label: 'Basis', accessor: (l) => l.row.basis, render: (l) => (
      l.row.is_estimate
        ? <Badge variant="outline" className="border-amber-500/40 text-amber-600 dark:text-amber-400"
            title={`Estimated from the commercial-invoice value at ${l.row.estimate.freight_pct}% freight / ${l.row.estimate.duty_pct}% duty — ${l.row.courier ?? 'this carrier'} does not invoice them separately`}>
            Estimate {l.row.estimate.freight_pct}/{l.row.estimate.duty_pct}
          </Badge>
        : <span className="text-muted-foreground text-xs">Actual</span>
    ) },
    { key: 'ship_date', label: 'Ship Date', accessor: (l) => l.ship_date, render: (l) => dim(l.ship_date) },
    { key: 'po_number', label: 'PO', accessor: (l) => l.po_number, render: (l) => <span className="font-medium text-xs">{l.po_number}</span> },
    { key: 'ir', label: 'Item Receipt', accessor: (l) => l.m?.netsuite_ir_tranid ?? '', render: (l) => matchControl(l) },
    { key: 'ir_date', label: 'IR Date', accessor: (l) => l.m?.receipt_date ?? '', render: (l) => dim(l.m?.receipt_date) },
    { key: 'ci_value', label: 'CI Value', align: 'right', accessor: (l) => l.ci_value, render: (l) => <span className="tabular-nums">{usd(l.ci_value)}</span> },
    { key: 'freight', label: 'Freight', align: 'right', accessor: (l) => l.freight, render: (l) => <span className="tabular-nums">{l.row.has_amounts ? usd(l.freight) : DASH}</span> },
    { key: 'duty', label: 'Duty', align: 'right', accessor: (l) => l.duty, render: (l) => <span className="tabular-nums">{l.row.has_amounts ? usd(l.duty) : DASH}</span> },
    { key: 'commission', label: 'Commission', align: 'right', accessor: (l) => l.commission, render: (l) => (
      l.commission > 0 ? <span className="tabular-nums">{usd(l.commission)}</span> : <span className="text-muted-foreground">{DASH}</span>
    ) },
    // "No amounts" only makes sense on the ACTUAL basis — an estimate has nothing to
    // wait for, so `awaiting_actual` (not `!has_amounts`) is what gates it now.
    { key: 'status', label: 'Status', accessor: (l) => l.posted ? 'Posted' : !l.row.has_shipping_data ? 'No packing' : l.row.awaiting_actual ? 'Awaiting invoices' : 'Pending', render: (l) => (
      l.posted
        ? <Badge variant="outline" className="border-emerald-500/40 text-emerald-600 dark:text-emerald-400"><Check className="h-3 w-3 mr-1" />Posted</Badge>
        : !l.row.has_shipping_data
          ? <Badge variant="outline" className="border-amber-500/40 text-amber-600 dark:text-amber-400">No packing</Badge>
          : l.row.awaiting_actual
            ? <Badge variant="outline" className="border-amber-500/40 text-amber-600 dark:text-amber-400" title="Freight & duty invoices from the forwarder have not been entered on the shipment yet">Awaiting invoices</Badge>
            : <Badge variant="outline" className="text-muted-foreground">Pending</Badge>
    ) },
    { key: 'action', label: 'Action', align: 'right', sortable: false, accessor: () => '', render: (l) => {
      const blockReason = postBlockReason(l);
      return (
        <span className="inline-flex items-center gap-1 whitespace-nowrap">
          <Button size="sm" variant="ghost" className="h-7 px-1.5" disabled={busy !== null} title="Preview NetSuite payload" onClick={() => showPreview(l.row)}><FileJson className="h-3.5 w-3.5" /></Button>
          {canEdit && (l.posted
            ? <Button size="sm" variant="ghost" className="h-7 px-1.5" disabled={busy !== null} title="Unpost this PO" onClick={() => unpost(l)}><RotateCcw className="h-3.5 w-3.5" /></Button>
            : <Button size="sm" variant="outline" disabled={busy !== null || !!blockReason} onClick={() => post(l)} title={blockReason || 'Post this PO & send to NetSuite'}>{busy === l.key ? 'Posting…' : 'Post'}</Button>)}
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
        initialSort={{ key: 'ship_date', dir: 'desc' }}
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
