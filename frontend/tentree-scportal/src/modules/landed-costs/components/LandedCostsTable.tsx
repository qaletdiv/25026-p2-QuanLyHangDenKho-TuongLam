'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
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
  postSmsLandedCost, unpostLandedCost, previewNetsuiteLandedCost,
  confirmReceiptMatch, clearReceiptMatch, manualMatchReceipt,
} from '@/modules/landed-costs/actions';
import type { SmsLandedCostRow, LandedCostMatch } from '@/modules/landed-costs/types';

const DASH = '—';
const usd = (n: number | null | undefined) =>
  `$${(Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const dim = (v: string | null | undefined) => <span className="text-muted-foreground">{v ?? DASH}</span>;
const irLabel = (m: LandedCostMatch) => m.netsuite_ir_tranid || (m.netsuite_ir_id ? `#${m.netsuite_ir_id}` : null);

// One PO's landed-cost line (the table is flattened per PO so IR / date / match
// each get their own sortable column; single-PO shipments = one line).
type LcLine = {
  key: string;
  shipment_id: string;
  tracking_number: string | null;
  supplier: string | null;
  ship_date: string | null;
  ship_month: string | null;
  po_number: string;
  ci_value: number;
  freight: number;
  duty: number;
  m?: LandedCostMatch;
  row: SmsLandedCostRow;   // parent shipment (post/preview/status act on the whole shipment)
};

// Why Post is disabled (Post commits the whole shipment to NetSuite).
function postBlockReason(r: SmsLandedCostRow): string | null {
  if (!r.has_shipping_data) return 'Upload shipping data first (needs the CI value)';
  if (!r.ir_resolved) return 'No Item Receipt matched — add the IR # first';
  if (!r.matched) return 'Confirm the IR match first';
  if (!r.push_enabled) return 'NetSuite push is not enabled on the server';
  if (!r.push_allowed) return 'This shipment is not enabled for push yet';
  return null;
}

export default function LandedCostsTable({ rows }: { rows: SmsLandedCostRow[] }) {
  const router = useRouter();
  const { user } = useSession();
  const canEdit = !user || (user.permissions ? user.permissions.includes('landed_costs') : user.role === 'Admin');
  const [busy, setBusy] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ shipment: string; data: any } | null>(null);
  const [manualIr, setManualIr] = useState<Record<string, string>>({});

  const months = useMemo(
    () => [...new Set(rows.map((r) => r.ship_month).filter(Boolean) as string[])].sort().reverse(),
    [rows],
  );
  const [month, setMonth] = useState<string>('all');
  const effMonth = month === 'all' && months.length ? months[0] : month;

  const visibleRows = useMemo(
    () => (effMonth === 'all' ? rows : rows.filter((r) => r.ship_month === effMonth)),
    [rows, effMonth],
  );

  // flatten shipment rows → per-PO lines (split carries the effective per-PO amounts)
  const lines = useMemo<LcLine[]>(() => visibleRows.flatMap((r) => {
    const matchByPo = new Map((r.match ?? []).map((m) => [m.po_number, m]));
    return r.split.map((s) => ({
      key: `${r.shipment_id}|${s.po_number}`,
      shipment_id: r.shipment_id,
      tracking_number: r.tracking_number,
      supplier: r.supplier,
      ship_date: r.ship_date,
      ship_month: r.ship_month,
      po_number: s.po_number,
      ci_value: s.ci_value,
      freight: s.freight,
      duty: s.duty,
      m: matchByPo.get(s.po_number),
      row: r,
    }));
  }), [visibleRows]);

  const counts = useMemo(() => visibleRows.reduce(
    (a, r) => { a[r.posted ? 'posted' : 'pending']++; return a; },
    { posted: 0, pending: 0 },
  ), [visibleRows]);

  async function post(r: SmsLandedCostRow) {
    setBusy(r.shipment_id);
    const res = await postSmsLandedCost(r.shipment_id);
    setBusy(null);
    if (res?.error) return void toast.error(res.error);
    toast.success(`Posted & sent to NetSuite — ${r.tracking_number || `shipment ${r.shipment_id}`}`);
    router.refresh();
  }
  async function unpost(r: SmsLandedCostRow) {
    if (!r.posted) return;
    setBusy(r.shipment_id);
    const res = await unpostLandedCost(r.posted.id);
    setBusy(null);
    if (res?.error) return void toast.error(res.error);
    toast.success('Landed cost unposted (NetSuite value unchanged)');
    router.refresh();
  }
  async function confirmMatch(m: LandedCostMatch, shipmentId: string) {
    if (!m.receipt_id) return;
    setBusy(shipmentId);
    const res = await confirmReceiptMatch(m.receipt_id, shipmentId);
    setBusy(null);
    if (res?.error) return void toast.error(res.error);
    toast.success(`Matched ${m.po_number} → ${irLabel(m)}`);
    router.refresh();
  }
  async function clearMatch(m: LandedCostMatch, shipmentId: string) {
    if (!m.receipt_id) return;
    setBusy(shipmentId);
    const res = await clearReceiptMatch(m.receipt_id);
    setBusy(null);
    if (res?.error) return void toast.error(res.error);
    toast.success('Match cleared');
    router.refresh();
  }
  async function manualAdd(shipmentId: string, poNumber: string) {
    const key = `${shipmentId}|${poNumber}`;
    const val = (manualIr[key] || '').trim();
    if (!val) return;
    setBusy(shipmentId);
    const res = await manualMatchReceipt(shipmentId, poNumber, val);
    setBusy(null);
    if (res?.error) return void toast.error(res.error);
    setManualIr((s) => ({ ...s, [key]: '' }));
    toast.success(`Matched ${poNumber} → ${val}`);
    router.refresh();
  }
  async function showNetsuitePreview(r: SmsLandedCostRow) {
    setBusy(r.shipment_id);
    const data = await previewNetsuiteLandedCost(r.shipment_id);
    setBusy(null);
    if (data?.error) return void toast.error(data.error);
    setPreview({ shipment: r.tracking_number || `Shipment ${r.shipment_id}`, data });
  }

  // Item Receipt cell — number when matched, or an inline input to type the IR # when not.
  function matchControl(l: LcLine) {
    const m = l.m;
    if (!m) return <span className="text-muted-foreground">{DASH}</span>;
    const key = l.key;
    if (m.confirmed) {
      return (
        <span className="inline-flex items-center gap-1">
          <span className="font-medium text-emerald-600 dark:text-emerald-400">{irLabel(m)}</span>
          <Check className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />
          {canEdit && !l.row.posted && (
            <Button size="sm" variant="ghost" className="h-6 px-1" disabled={busy !== null} title="Clear match" onClick={() => clearMatch(m, l.shipment_id)}><X className="h-3 w-3" /></Button>
          )}
        </span>
      );
    }
    if (m.netsuite_ir_id) {
      return (
        <span className="inline-flex items-center gap-2">
          <span className="text-muted-foreground">{irLabel(m)}</span>
          {canEdit && (
            <Button size="sm" variant="outline" className="h-6" disabled={busy !== null} onClick={() => confirmMatch(m, l.shipment_id)}>
              Confirm <span className="text-muted-foreground ml-1">({m.confidence})</span>
            </Button>
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

  const columns: DataColumn<LcLine>[] = [
    { key: 'tracking_number', label: 'Tracking #', accessor: (l) => l.tracking_number, render: (l) => (
      <Link href={`/sms/shipments/${l.shipment_id}`} className="text-primary hover:underline font-mono text-xs font-medium">{l.tracking_number || `Shipment ${l.shipment_id}`}</Link>
    ) },
    { key: 'supplier', label: 'Supplier', accessor: (l) => l.supplier, render: (l) => dim(l.supplier) },
    { key: 'ship_date', label: 'Ship Date', accessor: (l) => l.ship_date, render: (l) => dim(l.ship_date) },
    { key: 'po_number', label: 'PO', accessor: (l) => l.po_number, render: (l) => <span className="font-medium text-xs">{l.po_number}</span> },
    { key: 'ir', label: 'Item Receipt', accessor: (l) => l.m?.netsuite_ir_tranid ?? '', render: (l) => matchControl(l) },
    { key: 'ir_date', label: 'IR Date', accessor: (l) => l.m?.receipt_date ?? '', render: (l) => dim(l.m?.receipt_date) },
    { key: 'ci_value', label: 'CI Value', align: 'right', accessor: (l) => l.ci_value, render: (l) => <span className="tabular-nums">{usd(l.ci_value)}</span> },
    { key: 'freight', label: 'Freight', align: 'right', accessor: (l) => l.freight, render: (l) => <span className="tabular-nums">{usd(l.freight)}</span> },
    { key: 'duty', label: 'Duty', align: 'right', accessor: (l) => l.duty, render: (l) => <span className="tabular-nums">{usd(l.duty)}</span> },
    { key: 'status', label: 'Status', accessor: (l) => l.row.posted ? 'Posted' : !l.row.has_shipping_data ? 'No shipping data' : 'Pending', render: (l) => (
      l.row.posted
        ? <Badge variant="outline" className="border-emerald-500/40 text-emerald-600 dark:text-emerald-400"><Check className="h-3 w-3 mr-1" />Posted</Badge>
        : !l.row.has_shipping_data
          ? <Badge variant="outline" className="border-amber-500/40 text-amber-600 dark:text-amber-400">No shipping data</Badge>
          : <Badge variant="outline" className="text-muted-foreground">Pending</Badge>
    ) },
    { key: 'action', label: 'Action', align: 'right', sortable: false, accessor: () => '', render: (l) => {
      const blockReason = postBlockReason(l.row);
      return (
        <span className="inline-flex items-center gap-1 whitespace-nowrap">
          <Button size="sm" variant="ghost" className="h-7 px-1.5" disabled={busy !== null} title="Preview NetSuite payload" onClick={() => showNetsuitePreview(l.row)}><FileJson className="h-3.5 w-3.5" /></Button>
          {canEdit && (l.row.posted
            ? <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => unpost(l.row)} title="Unpost (correction — NetSuite value stays)"><RotateCcw className="h-3.5 w-3.5" /></Button>
            : <Button size="sm" variant="outline" disabled={busy !== null || !!blockReason} onClick={() => post(l.row)} title={blockReason || 'Post & send to NetSuite'}>{busy === l.shipment_id ? 'Posting…' : 'Post'}</Button>)}
        </span>
      );
    } },
  ];

  const toolbar = (
    <>
      <Select value={month} onValueChange={(v) => setMonth(v ?? 'all')}>
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
        searchPlaceholder="Search tracking #, PO, IR…"
        emptyText="No SMS shipments for this period."
        pageSize={20}
        initialSort={{ key: 'ship_date', dir: 'desc' }}
        storageKey="landed_cost_columns"
      />

      {/* NetSuite payload preview — READ ONLY. */}
      <Dialog open={preview !== null} onOpenChange={(o) => !o && setPreview(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><FileJson className="h-4 w-4" /> NetSuite Item Receipt — {preview?.shipment}</DialogTitle>
          </DialogHeader>
          {preview?.data && (
            <div className="space-y-3 text-sm">
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="border-amber-500/40 text-amber-600 dark:text-amber-400">Preview only — not sent</Badge>
                <span className="text-xs text-muted-foreground">
                  {preview.data.payloads?.length} Item Receipt payload(s) · amounts from {preview.data.source}
                </span>
              </div>
              <div className="text-xs text-muted-foreground">
                {preview.data.target?.method} {preview.data.target?.url_template}
              </div>
              <pre className="bg-muted/50 rounded-md p-3 text-xs overflow-x-auto max-h-[50vh]">
                {JSON.stringify(preview.data.payloads, null, 2)}
              </pre>
              <p className="text-xs text-muted-foreground">
                One Item Receipt per PO (memo = PO number). Duty → landedCosts category 2, Freight → category 5,
                allocated by value; shipping method = COURIER. This is what <strong>Post</strong> sends.
              </p>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
