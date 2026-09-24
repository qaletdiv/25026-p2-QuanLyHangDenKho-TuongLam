'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select';
import { RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useSession } from '@/components/providers/SessionProvider';
// DataTable is a generic UI primitive (search/sort/pagination/column picker) —
// no mainline data coupling; reused across modules.
import DataTable, { type DataColumn } from '@/modules/mainline/components/DataTable';
import { syncSmsNetsuite } from '@/modules/sms/actions';
import { FULFILLMENT_LABELS, FULFILLMENT_STYLES, seasonRank, facilityLabel } from './smsStatus';
import type { SmsPo } from '@/modules/sms/types';

const dim = (v: string | null) => <span className="text-muted-foreground">{v ?? '—'}</span>;

export default function SmsPosTable({ pos }: { pos: SmsPo[] }) {
  const router = useRouter();
  const { user } = useSession();
  const isAdmin = user?.role === 'Admin';
  const [syncing, setSyncing] = useState(false);

  // Season filter — defaults to the newest season that still has open POs
  // (production/logistics only care about the current season).
  const seasons = useMemo(
    () => [...new Set(pos.map((p) => p.season).filter(Boolean) as string[])].sort((a, b) => seasonRank(b) - seasonRank(a)),
    [pos],
  );
  const defaultSeason = useMemo(
    () => seasons.find((s) => pos.some((p) => p.season === s && p.fulfillment !== 'received')) || seasons[0] || 'all',
    [seasons, pos],
  );
  const [season, setSeason] = useState<string>(defaultSeason);
  const filtered = useMemo(() => (season === 'all' ? pos : pos.filter((p) => p.season === season)), [pos, season]);

  async function onSync() {
    setSyncing(true);
    const r = await syncSmsNetsuite();
    setSyncing(false);
    if (r?.fetch_error) return void toast.error(`NetSuite: ${r.fetch_error}`);
    if (r?.error) return void toast.error(r.error);
    // Receipts NetSuite has deleted are now REMOVED here, not left to accumulate
    // (PO04801 read 658 received against NetSuite's 329). Deleting rows is never
    // silent: they are named, and a removed CONFIRMED match gets its own warning
    // because it withdraws something a human asserted.
    const removed: { ir: string; poNumber: string; was_confirmed?: boolean }[] = r?.receipts_removed ?? [];
    toast.success(`NetSuite sync: ${r.pos_upserted ?? 0} POs, ${r.po_lines_upserted ?? 0} lines, ${r.receipts_upserted ?? 0} receipts`
      + (removed.length ? ` · ${removed.length} deleted receipt(s) removed` : '')
      + (r.warnings?.length ? ` · ⚠ ${r.warnings.length} warning(s)` : ''));
    if (removed.length) {
      const confirmed = removed.filter((x) => x.was_confirmed);
      toast.warning(
        `No longer in NetSuite, removed: ${removed.map((x) => `${x.ir} (${x.poNumber})`).join(', ')}`
        + (confirmed.length ? ` — ${confirmed.length} of them carried a CONFIRMED match, so those lots need re-matching.` : ''),
        { duration: 12000 },
      );
    }
    router.refresh();
  }

  const columns: DataColumn<SmsPo>[] = [
    { key: 'poNumber', label: 'PO Number', accessor: (p) => p.poNumber, render: (p) => <span className="font-medium">{p.poNumber}</span> },
    { key: 'trnNumber', label: 'tentree PO', defaultVisible: false, accessor: (p) => p.trnNumber, render: (p) => dim(p.trnNumber) },
    { key: 'supplier', label: 'Supplier', accessor: (p) => p.supplier, render: (p) => dim(p.supplier) },
    { key: 'season', label: 'Season', accessor: (p) => p.season, render: (p) => dim(p.season) },
    { key: 'hod', label: 'HOD', accessor: (p) => p.hod, render: (p) => dim(p.hod) },
    { key: 'expectedReceivedDate', label: 'Expected Receive', accessor: (p) => p.expectedReceivedDate, render: (p) => dim(p.expectedReceivedDate) },
    { key: 'facility', label: 'Destination', accessor: (p) => facilityLabel(p.facility), render: (p) => dim(facilityLabel(p.facility)) },
    { key: 'allocationChannel', label: 'Channel', accessor: (p) => p.allocationChannel, render: (p) => dim(p.allocationChannel) },
    { key: 'shipMethod', label: 'Ship Method', defaultVisible: false, accessor: (p) => p.shipMethod, render: (p) => dim(p.shipMethod) },
    { key: 'approvalStatus', label: 'Approval', defaultVisible: false, accessor: (p) => p.approvalStatus, render: (p) => dim(p.approvalStatus) },
    { key: 'orderedQty', label: 'Ordered', align: 'right', accessor: (p) => p.orderedQty, render: (p) => p.orderedQty.toLocaleString() },
    { key: 'shippedQty', label: 'Shipped', align: 'right', accessor: (p) => p.shippedQty, render: (p) => p.shippedQty.toLocaleString() },
    { key: 'receivedQty', label: 'Received', align: 'right', defaultVisible: false, accessor: (p) => p.receivedQty, render: (p) => p.receivedQty.toLocaleString() },
    { key: 'remainingQty', label: 'Remaining', align: 'right', accessor: (p) => p.remainingQty, render: (p) => (
      <span className={cn('tabular-nums', p.remainingQty < 0 && 'text-red-600 font-semibold')}>{p.remainingQty.toLocaleString()}</span>
    ) },
    { key: 'lotCount', label: 'Lots', align: 'right', defaultVisible: false, accessor: (p) => p.lotCount, render: (p) => p.lotCount.toLocaleString() },
    { key: 'fulfillment', label: 'Status', accessor: (p) => FULFILLMENT_LABELS[p.fulfillment], render: (p) => (
      <Badge variant="outline" className={cn(FULFILLMENT_STYLES[p.fulfillment])}>{FULFILLMENT_LABELS[p.fulfillment]}</Badge>
    ) },
  ];

  const toolbar = (
    <>
      <Select value={season} onValueChange={(v) => v && setSeason(v)}>
        {/* label rendered directly — SelectValue shows the raw "all" instead of "All Seasons" */}
        <SelectTrigger className="w-32 h-9">{season === 'all' ? 'All Seasons' : season}</SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All Seasons</SelectItem>
          {seasons.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
        </SelectContent>
      </Select>
      {isAdmin && (
        <Button variant="outline" size="sm" disabled={syncing} onClick={onSync} title="Pull SMS POs (custbody_tt_po_type='smm') + Item Receipts from NetSuite">
          <RefreshCw className={cn('h-4 w-4 mr-1.5', syncing && 'animate-spin')} />{syncing ? 'Syncing…' : 'NetSuite Sync'}
        </Button>
      )}
    </>
  );

  return (
    <DataTable
      rows={filtered} columns={columns} rowKey={(p) => p.poNumber}
      noun="PO" searchPlaceholder="Search PO, supplier…"
      toolbar={toolbar} emptyText="No SMS purchase orders — run the NetSuite sync"
      storageKey="sms_po_columns"
      onRowClick={(p) => router.push(`/sms/purchase-orders/${encodeURIComponent(p.poNumber)}`)}
    />
  );
}
