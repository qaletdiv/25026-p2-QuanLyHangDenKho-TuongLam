'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select';
import { RefreshCw } from 'lucide-react';
import { useSession } from '@/components/providers/SessionProvider';
import { cn } from '@/lib/utils';
import { syncNetSuite } from '@/modules/mainline/actions';
import DataTable, { type DataColumn } from './DataTable';
import ApprovalBadge from './ApprovalBadge';
import type { PoLegRow } from '@/modules/mainline/types';

// Mainline POs come from the NetSuite sync, which since 2026-09-25 also creates
// ONE leg per PO for SS27 onward. The v1 WIP import was RETIRED 2026-09-28, so
// this is now the only ingestion path; FW26's WIP-built legs stay as history.
// Unrelated to the SMS NetSuite sync, which has its own button in that module.
// "SS27" → sortable number (year, then SS before FW) so seasons list newest-first.
const seasonRank = (code: string) => {
  const m = String(code || '').match(/^([A-Za-z]+)\s*(\d+)$/);
  if (!m) return -1;
  return Number(m[2]) * 2 + (m[1].toUpperCase() === 'FW' ? 1 : 0);
};

export default function PoLegsTable({ legs }: { legs: PoLegRow[] }) {
  const router = useRouter();
  const { user } = useSession();
  const isAdmin = user?.role === 'Admin';
  const [busy, setBusy] = useState<null | 'sync'>(null);

  // Season filter (like the SMS PO table). Defaults to All so the full order book
  // shows unless narrowed. Download always exports everything, regardless of filter.
  const seasons = useMemo(
    () => [...new Set(legs.map((l) => l.season).filter(Boolean) as string[])].sort((a, b) => seasonRank(b) - seasonRank(a)),
    [legs],
  );
  const [season, setSeason] = useState<string>('all');
  const filtered = useMemo(() => (season === 'all' ? legs : legs.filter((l) => l.season === season)), [legs, season]);

  async function onSync() {
    setBusy('sync');
    const r = await syncNetSuite();
    setBusy(null);
    if (r?.fetch_error) return void toast.error(`NetSuite: ${r.fetch_error}`);
    if (r?.error) return void toast.error(r.error);
    const prot = Array.isArray(r?.protected) ? r.protected.length : 0;
    // Rejected POs: refused on the way in, and removed if they were already here
    // (NetSuite usually rejects a PO after it was synced). Both are reported —
    // silently deleting rows from the order book would be worse than the bug.
    const rejectedIn = Array.isArray(r?.rejected_skipped) ? r.rejected_skipped.length : 0;
    const removed: string[] = r?.rejected_removed?.poNumbers ?? [];
    const stuck: string[] = r?.rejected_kept_referenced ?? [];
    toast.success(`NetSuite sync: ${r.masters_upserted ?? 0} PO master(s), ${r.orders_upserted ?? 0} order(s), ${r.lines_upserted ?? 0} line(s)`
      + (prot ? ` · ${prot} protected (booked) skipped` : '')
      + (rejectedIn ? ` · ${rejectedIn} rejected skipped` : '')
      + (removed.length ? ` · ${removed.length} rejected removed (${removed.join(', ')})` : ''));
    if (stuck.length) {
      toast.warning(`Rejected in NetSuite but booked/received here — left in place for review: ${stuck.join(', ')}`, { duration: 10000 });
    }
    // Item Receipts NetSuite has deleted are removed rather than left to add up
    // (the fold used to only ever insert). Named, never silent — and a removed
    // CONFIRMED match withdraws a human's assertion, so it is called out.
    const irsGone: { ir: string; poNumber: string; was_confirmed?: boolean }[] = r?.receipts_removed ?? [];
    if (irsGone.length) {
      const confirmed = irsGone.filter((x) => x.was_confirmed);
      toast.warning(
        `No longer in NetSuite, removed: ${irsGone.map((x) => `${x.ir} (${x.poNumber})`).join(', ')}`
        + (confirmed.length ? ` — ${confirmed.length} carried a CONFIRMED match and need re-matching.` : ''),
        { duration: 12000 },
      );
    }
    router.refresh();
  }

  const columns: DataColumn<PoLegRow>[] = [
    { key: 'poNumber', label: 'PO Number', accessor: (l) => l.poNumber, render: (l) => <span className="font-medium">{l.poNumber}</span> },
    { key: 'trnNumber', label: 'TRN', accessor: (l) => l.trnNumber, render: (l) => l.trnNumber ? <Link href={`/mainline/purchase-orders/${l.trnNumber}`} className="text-primary hover:underline" onClick={(e) => e.stopPropagation()}>{l.trnNumber}</Link> : <span className="text-muted-foreground">—</span> },
    { key: 'supplier', label: 'Supplier', accessor: (l) => l.supplier, render: (l) => <span className="text-muted-foreground">{l.supplier ?? '—'}</span> },
    { key: 'season', label: 'Season', accessor: (l) => l.season, render: (l) => <span className="text-muted-foreground">{l.season ?? '—'}</span> },
    { key: 'mainShoulder', label: 'Shoulder', defaultVisible: false, accessor: (l) => l.mainShoulder, render: (l) => <span className="text-muted-foreground">{l.mainShoulder ?? '—'}</span> },
    // Stage describes the v1 WIP air/sea SPLIT. A v2 leg (SS27+) is created 1:1 by
    // the NetSuite sync, so there was no split to do and the API sends null —
    // rendered BLANK, not "Split", which would assert an operation that never
    // happened. Same blank-when-unremarkable rule as Carrier Ref # and Approval.
    // "Where is this" is answered by the forecast's stage ladder instead.
    { key: 'lifecycle', label: 'Stage', accessor: (l) => l.lifecycle ?? '', render: (l) => (
      l.lifecycle === 'forecast'
        ? <Badge variant="outline" className="bg-amber-500/10 text-amber-600 border-amber-500/20">Forecast</Badge>
        : l.lifecycle === 'split'
          ? <Badge variant="outline" className="bg-emerald-500/10 text-emerald-600 border-emerald-500/20">Split</Badge>
          : null
    ) },
    // NetSuite sign-off. Its OWN column rather than a second pill in Stage: they
    // answer different questions (has WIP split it / has a supervisor approved it),
    // and stacking two badges in one cell makes both harder to scan. Blank on the
    // approved POs — only the exceptions are worth ink.
    //
    // The accessor is rank-PREFIXED text, and it has to be both:
    //  · a bare label sorted "Approved" before "Pending" (A < P), so the one click
    //    anyone makes on this header buried the rows the column exists to surface;
    //  · a bare rank number broke the SEARCH box — DataTable filters on the same
    //    accessor, so typing "pending" matched 0 of 104 rows.
    // "1 Pending Approval" satisfies both: it sorts most-urgent-first and still
    // contains the words people type.
    { key: 'approvalStatus', label: 'Approval',
      accessor: (l) => (
        l.approvalStatus === 'Rejected' ? '0 Rejected'
          : l.approvalStatus === 'Pending Approval' ? '1 Pending Approval'
            : l.approvalStatus === 'Approved' ? '2 Approved' : '3'
      ),
      render: (l) => <ApprovalBadge status={l.approvalStatus} /> },
    { key: 'mode', label: 'Mode', accessor: (l) => l.mode, render: (l) => l.mode ?? '—' },
    { key: 'coo', label: 'COO', defaultVisible: false, accessor: (l) => l.coo, render: (l) => <span className="text-muted-foreground">{l.coo ?? '—'}</span> },
    { key: 'receivingWarehouse', label: 'Destination', accessor: (l) => l.receivingWarehouse, render: (l) => <span className="text-muted-foreground">{l.receivingWarehouse ?? '—'}</span> },
    { key: 'allocationChannel', label: 'Channel', accessor: (l) => l.allocationChannel, render: (l) => <span className="text-muted-foreground">{l.allocationChannel ?? '—'}</span> },
    { key: 'incoterm', label: 'Incoterm', accessor: (l) => l.incoterm, render: (l) => <span className="text-muted-foreground">{l.incoterm ?? '—'}</span> },
    { key: 'crd', label: 'CRD', accessor: (l) => l.crd, render: (l) => <span className="text-muted-foreground">{l.crd ?? '—'}</span> },
    // Hand-over date (NetSuite custbody8) — the supplier hands the goods to the
    // forwarder. A DIFFERENT event from Cargo Ready: 7 days later on live rows.
    // v2 only, so FW26 legs show '—'.
    { key: 'hod', label: 'HOD', accessor: (l) => l.hod, render: (l) => <span className="text-muted-foreground">{l.hod ?? '—'}</span> },
    { key: 'etdPol', label: 'ETD POL', accessor: (l) => l.etdPol, render: (l) => <span className="text-muted-foreground">{l.etdPol ?? '—'}</span> },
    { key: 'eDel', label: 'E-DEL', defaultVisible: false, accessor: (l) => l.eDel, render: (l) => <span className="text-muted-foreground">{l.eDel ?? '—'}</span> },
    { key: 'expectedQty', label: 'Expected Qty', align: 'right', accessor: (l) => l.expectedQty, render: (l) => l.expectedQty.toLocaleString() },
    { key: 'skuCount', label: 'SKUs', align: 'right', defaultVisible: false, accessor: (l) => l.skuCount, render: (l) => l.skuCount.toLocaleString() },
  ];

  const toolbar = (
    <>
      <Select value={season} onValueChange={(v) => v && setSeason(v)}>
        {/* label rendered directly — Base UI SelectValue shows the raw value when it
            differs from the label (e.g. "all" vs "All Seasons") */}
        <SelectTrigger className="w-32 h-9">{season === 'all' ? 'All Seasons' : season}</SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All Seasons</SelectItem>
          {seasons.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
        </SelectContent>
      </Select>
      {/* "Upload WIP" was REMOVED 2026-09-28 with the v1 import. The NetSuite sync
          is now the only way a leg is created. */}
      {isAdmin && (
        <Button variant="outline" size="sm" disabled={busy !== null} onClick={onSync} title="Pull mainline POs from NetSuite (upserts masters/orders/lines; creates one leg per PO from SS27 on; booked orders are protected)">
          <RefreshCw className={cn('h-4 w-4 mr-1.5', busy === 'sync' && 'animate-spin')} />{busy === 'sync' ? 'Syncing…' : 'NetSuite Sync'}
        </Button>
      )}
    </>
  );

  return (
    <DataTable
      rows={filtered} columns={columns} rowKey={(l) => l.id}
      noun="PO row" searchPlaceholder="Search PO, TRN, supplier…"
      toolbar={toolbar} emptyText="No purchase orders — run the NetSuite Sync" storageKey="mainline_po_columns"
      onRowClick={(l) => router.push(
        // forecast rows have no real leg → open the master detail; split rows open the leg
        l.lifecycle === 'forecast'
          ? `/mainline/purchase-orders/${encodeURIComponent(l.trnNumber ?? '')}`
          : `/mainline/purchase-orders/${encodeURIComponent(l.trnNumber ?? '')}/${l.id}`,
      )}
    />
  );
}
