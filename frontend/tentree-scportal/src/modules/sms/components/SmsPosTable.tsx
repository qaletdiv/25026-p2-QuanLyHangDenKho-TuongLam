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
    toast.success(`NetSuite sync: ${r.pos_upserted ?? 0} POs, ${r.po_lines_upserted ?? 0} lines, ${r.receipts_upserted ?? 0} receipts${r.warnings?.length ? ` · ⚠ ${r.warnings.length} warning(s)` : ''}`);
    router.refresh();
  }

  const columns: DataColumn<SmsPo>[] = [
    { key: 'po_number', label: 'PO Number', accessor: (p) => p.po_number, render: (p) => <span className="font-medium">{p.po_number}</span> },
    { key: 'trn_number', label: 'tentree PO', defaultVisible: false, accessor: (p) => p.trn_number, render: (p) => dim(p.trn_number) },
    { key: 'supplier', label: 'Supplier', accessor: (p) => p.supplier, render: (p) => dim(p.supplier) },
    { key: 'season', label: 'Season', accessor: (p) => p.season, render: (p) => dim(p.season) },
    { key: 'hod', label: 'HOD', accessor: (p) => p.hod, render: (p) => dim(p.hod) },
    { key: 'expected_received_date', label: 'Expected Receive', accessor: (p) => p.expected_received_date, render: (p) => dim(p.expected_received_date) },
    { key: 'facility', label: 'Destination', accessor: (p) => facilityLabel(p.facility), render: (p) => dim(facilityLabel(p.facility)) },
    { key: 'allocation_channel', label: 'Channel', accessor: (p) => p.allocation_channel, render: (p) => dim(p.allocation_channel) },
    { key: 'ship_method', label: 'Ship Method', defaultVisible: false, accessor: (p) => p.ship_method, render: (p) => dim(p.ship_method) },
    { key: 'approval_status', label: 'Approval', defaultVisible: false, accessor: (p) => p.approval_status, render: (p) => dim(p.approval_status) },
    { key: 'ordered_qty', label: 'Ordered', align: 'right', accessor: (p) => p.ordered_qty, render: (p) => p.ordered_qty.toLocaleString() },
    { key: 'shipped_qty', label: 'Shipped', align: 'right', accessor: (p) => p.shipped_qty, render: (p) => p.shipped_qty.toLocaleString() },
    { key: 'received_qty', label: 'Received', align: 'right', defaultVisible: false, accessor: (p) => p.received_qty, render: (p) => p.received_qty.toLocaleString() },
    { key: 'remaining_qty', label: 'Remaining', align: 'right', accessor: (p) => p.remaining_qty, render: (p) => (
      <span className={cn('tabular-nums', p.remaining_qty < 0 && 'text-red-600 font-semibold')}>{p.remaining_qty.toLocaleString()}</span>
    ) },
    { key: 'lot_count', label: 'Lots', align: 'right', defaultVisible: false, accessor: (p) => p.lot_count, render: (p) => p.lot_count.toLocaleString() },
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
      rows={filtered} columns={columns} rowKey={(p) => p.po_number}
      noun="PO" searchPlaceholder="Search PO, supplier…"
      toolbar={toolbar} emptyText="No SMS purchase orders — run the NetSuite sync"
      storageKey="sms_po_columns"
      onRowClick={(p) => router.push(`/sms/purchase-orders/${encodeURIComponent(p.po_number)}`)}
    />
  );
}
