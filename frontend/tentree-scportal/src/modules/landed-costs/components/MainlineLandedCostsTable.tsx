'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Check, RotateCcw, FileJson, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useSession } from '@/components/providers/SessionProvider';
import DataTable, { type DataColumn } from '@/modules/mainline/components/DataTable';
import {
  postMainlineLandedCost, previewMainlineNetsuite,
  confirmMainlineReceiptMatch, clearMainlineReceiptMatch, manualMainlineReceiptMatch,
} from '@/modules/landed-costs/actions';
import type { MainlineLandedCostRow, MainlineLandedCostMatch } from '@/modules/landed-costs/types';

const DASH = '—';
const usd = (n: number | null | undefined) =>
  `$${(Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const irLabel = (m: MainlineLandedCostMatch) => m.netsuite_ir_tranid || (m.netsuite_ir_id ? `#${m.netsuite_ir_id}` : null);

type Line = {
  key: string;
  shipment_id: string;
  shipment_number: string | null;
  po_number: string;
  ci_value: number;
  freight: number;
  duty: number;
  m?: MainlineLandedCostMatch;
  row: MainlineLandedCostRow;
};

function postBlockReason(r: MainlineLandedCostRow): string | null {
  if (!r.has_shipping_data) return 'Upload packing data first (needed for the CI-value split)';
  if (!r.has_amounts) return 'Enter freight & duty on the shipment first';
  if (!r.ir_resolved) return 'No Item Receipt matched — add the IR # first';
  if (!r.matched) return 'Confirm the IR match first';
  if (!r.push_enabled) return 'NetSuite push is not enabled on the server';
  if (!r.push_allowed) return 'This shipment is not enabled for push yet';
  return null;
}

export default function MainlineLandedCostsTable({ rows }: { rows: MainlineLandedCostRow[] }) {
  const router = useRouter();
  const { user } = useSession();
  const canEdit = !user || (user.permissions ? user.permissions.includes('landed_costs') : user.role === 'Admin');
  const [busy, setBusy] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ shipment: string; data: any } | null>(null);
  const [manualIr, setManualIr] = useState<Record<string, string>>({});

  const lines = useMemo<Line[]>(() => rows.flatMap((r) => {
    const matchByPo = new Map((r.match ?? []).map((m) => [m.po_number, m]));
    return r.split.map((s) => ({
      key: `${r.shipment_id}|${s.po_number}`,
      shipment_id: r.shipment_id, shipment_number: r.shipment_number,
      po_number: s.po_number, ci_value: s.ci_value, freight: s.freight, duty: s.duty,
      m: matchByPo.get(s.po_number), row: r,
    }));
  }), [rows]);

  const counts = useMemo(() => rows.reduce(
    (a, r) => { a[r.posted ? 'posted' : 'pending']++; return a; },
    { posted: 0, pending: 0 },
  ), [rows]);

  async function post(r: MainlineLandedCostRow) {
    setBusy(r.shipment_id);
    const res = await postMainlineLandedCost(r.shipment_id);
    setBusy(null);
    if (res?.error) return void toast.error(res.error);
    toast.success(`Posted & sent to NetSuite — ${r.shipment_number || `shipment ${r.shipment_id}`}`);
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
          {canEdit && !l.row.posted && (
            <Button size="sm" variant="ghost" className="h-6 px-1" disabled={busy !== null} title="Clear match" onClick={() => clearMatch(m, l.shipment_id)}><X className="h-3 w-3" /></Button>
          )}
        </span>
      );
    }
    if (m.netsuite_ir_id) {
      return (
        <span className="inline-flex items-center gap-2">
          <span className="text-muted-foreground">{irLabel(m)}{m.ambiguous ? ' ⚠' : ''}</span>
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

  const columns: DataColumn<Line>[] = [
    { key: 'shipment_number', label: 'Shipment', accessor: (l) => l.shipment_number || l.shipment_id, render: (l) => (
      <Link href={`/mainline/shipments/${l.shipment_id}`} className="text-primary hover:underline text-xs font-medium">{l.shipment_number || `Shipment ${l.shipment_id}`}</Link>
    ) },
    { key: 'po_number', label: 'PO', accessor: (l) => l.po_number, render: (l) => <span className="font-medium text-xs">{l.po_number}</span> },
    { key: 'ir', label: 'Item Receipt', accessor: (l) => l.m?.netsuite_ir_tranid ?? '', render: (l) => matchControl(l) },
    { key: 'ir_date', label: 'IR Date', accessor: (l) => l.m?.receipt_date ?? '', render: (l) => <span className="text-muted-foreground">{l.m?.receipt_date ?? DASH}</span> },
    { key: 'ci_value', label: 'CI Value', align: 'right', accessor: (l) => l.ci_value, render: (l) => <span className="tabular-nums">{usd(l.ci_value)}</span> },
    { key: 'freight', label: 'Freight', align: 'right', accessor: (l) => l.freight, render: (l) => <span className="tabular-nums">{l.row.has_amounts ? usd(l.freight) : DASH}</span> },
    { key: 'duty', label: 'Duty', align: 'right', accessor: (l) => l.duty, render: (l) => <span className="tabular-nums">{l.row.has_amounts ? usd(l.duty) : DASH}</span> },
    { key: 'status', label: 'Status', accessor: (l) => l.row.posted ? 'Posted' : !l.row.has_amounts ? 'No amounts' : 'Pending', render: (l) => (
      l.row.posted
        ? <Badge variant="outline" className="border-emerald-500/40 text-emerald-600 dark:text-emerald-400"><Check className="h-3 w-3 mr-1" />Posted</Badge>
        : !l.row.has_shipping_data
          ? <Badge variant="outline" className="border-amber-500/40 text-amber-600 dark:text-amber-400">No packing</Badge>
          : !l.row.has_amounts
            ? <Badge variant="outline" className="border-amber-500/40 text-amber-600 dark:text-amber-400">No amounts</Badge>
            : <Badge variant="outline" className="text-muted-foreground">Pending</Badge>
    ) },
    { key: 'action', label: 'Action', align: 'right', sortable: false, accessor: () => '', render: (l) => {
      const blockReason = postBlockReason(l.row);
      return (
        <span className="inline-flex items-center gap-1 whitespace-nowrap">
          <Button size="sm" variant="ghost" className="h-7 px-1.5" disabled={busy !== null} title="Preview NetSuite payload" onClick={() => showPreview(l.row)}><FileJson className="h-3.5 w-3.5" /></Button>
          {canEdit && !l.row.posted && (
            <Button size="sm" variant="outline" disabled={busy !== null || !!blockReason} onClick={() => post(l.row)} title={blockReason || 'Post & send to NetSuite'}>{busy === l.shipment_id ? 'Posting…' : 'Post'}</Button>
          )}
          {l.row.posted && <span title="Posted"><RotateCcw className="h-3.5 w-3.5 text-muted-foreground/50" /></span>}
        </span>
      );
    } },
  ];

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {'Freight & duty are entered on the shipment, split per PO by CI value, and posted to each PO’s Item Receipt. '}
        {'Amounts are read-only here — edit them on the shipment. '}
        <span className="text-muted-foreground">{counts.pending} pending · {counts.posted} posted</span>
      </p>
      <DataTable
        rows={lines}
        columns={columns}
        rowKey={(l) => l.key}
        noun="line"
        searchPlaceholder="Search shipment, PO, IR…"
        emptyText="No mainline shipments with landed cost yet."
        pageSize={20}
        initialSort={{ key: 'shipment_number', dir: 'desc' }}
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
                One Item Receipt per PO. Duty → landedCosts category 2, Freight → category 5, allocated by value;
                shipping method = Sea/Air by mode. This is what <strong>Post</strong> sends.
              </p>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
