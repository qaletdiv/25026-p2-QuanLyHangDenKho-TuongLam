'use client';

import { useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select';
import { RefreshCw, Upload } from 'lucide-react';
import { useSession } from '@/components/providers/SessionProvider';
import { cn } from '@/lib/utils';
import { importWip, syncNetSuite } from '@/modules/mainline/actions';
import DataTable, { type DataColumn } from './DataTable';
import type { PoLegRow } from '@/modules/mainline/types';

// Mainline POs are WIP-import-sourced (the importer bootstraps missing
// masters/orders). The mainline NetSuite sync exists but is DEACTIVATED for
// now (button disabled below) — it is unrelated to the SMS NetSuite sync,
// which lives in the SMS module with its own button.
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
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<null | 'wip' | 'sync'>(null);

  // Season filter (like the SMS PO table). Defaults to All so the full order book
  // shows unless narrowed. Download always exports everything, regardless of filter.
  const seasons = useMemo(
    () => [...new Set(legs.map((l) => l.season).filter(Boolean) as string[])].sort((a, b) => seasonRank(b) - seasonRank(a)),
    [legs],
  );
  const [season, setSeason] = useState<string>('all');
  const filtered = useMemo(() => (season === 'all' ? legs : legs.filter((l) => l.season === season)), [legs, season]);

  async function onWip(file: File) {
    setBusy('wip');
    const r = await importWip(file);
    setBusy(null);
    if (r?.error) return void toast.error(r.error);
    const mm = r?.reconciliation?.mismatch_count ?? 0;
    toast.success(`WIP import: ${r.added ?? 0} added, ${r.updated ?? 0} updated${mm ? ` · ⚠ ${mm} mismatch(es)` : ''}`);
    router.refresh();
  }

  async function onSync() {
    setBusy('sync');
    const r = await syncNetSuite();
    setBusy(null);
    if (r?.fetch_error) return void toast.error(`NetSuite: ${r.fetch_error}`);
    if (r?.error) return void toast.error(r.error);
    const prot = Array.isArray(r?.protected) ? r.protected.length : 0;
    toast.success(`NetSuite sync: ${r.masters_upserted ?? 0} PO master(s), ${r.orders_upserted ?? 0} order(s), ${r.lines_upserted ?? 0} line(s)${prot ? ` · ${prot} protected (booked) skipped` : ''}`);
    router.refresh();
  }

  const columns: DataColumn<PoLegRow>[] = [
    { key: 'po_number', label: 'PO Number', accessor: (l) => l.po_number, render: (l) => <span className="font-medium">{l.po_number}</span> },
    { key: 'trn_number', label: 'TRN', accessor: (l) => l.trn_number, render: (l) => l.trn_number ? <Link href={`/mainline/purchase-orders/${l.trn_number}`} className="text-primary hover:underline" onClick={(e) => e.stopPropagation()}>{l.trn_number}</Link> : <span className="text-muted-foreground">—</span> },
    { key: 'supplier', label: 'Supplier', accessor: (l) => l.supplier, render: (l) => <span className="text-muted-foreground">{l.supplier ?? '—'}</span> },
    { key: 'season', label: 'Season', accessor: (l) => l.season, render: (l) => <span className="text-muted-foreground">{l.season ?? '—'}</span> },
    { key: 'main_shoulder', label: 'Shoulder', defaultVisible: false, accessor: (l) => l.main_shoulder, render: (l) => <span className="text-muted-foreground">{l.main_shoulder ?? '—'}</span> },
    { key: 'lifecycle', label: 'Stage', accessor: (l) => l.lifecycle, render: (l) => (
      l.lifecycle === 'forecast'
        ? <Badge variant="outline" className="bg-amber-500/10 text-amber-600 border-amber-500/20">Forecast</Badge>
        : <Badge variant="outline" className="bg-emerald-500/10 text-emerald-600 border-emerald-500/20">Split</Badge>
    ) },
    { key: 'mode', label: 'Mode', accessor: (l) => l.mode, render: (l) => l.mode ?? '—' },
    { key: 'coo', label: 'COO', defaultVisible: false, accessor: (l) => l.coo, render: (l) => <span className="text-muted-foreground">{l.coo ?? '—'}</span> },
    { key: 'receiving_warehouse', label: 'Destination', accessor: (l) => l.receiving_warehouse, render: (l) => <span className="text-muted-foreground">{l.receiving_warehouse ?? '—'}</span> },
    { key: 'allocation_channel', label: 'Channel', accessor: (l) => l.allocation_channel, render: (l) => <span className="text-muted-foreground">{l.allocation_channel ?? '—'}</span> },
    { key: 'incoterm', label: 'Incoterm', accessor: (l) => l.incoterm, render: (l) => <span className="text-muted-foreground">{l.incoterm ?? '—'}</span> },
    { key: 'crd', label: 'CRD', accessor: (l) => l.crd, render: (l) => <span className="text-muted-foreground">{l.crd ?? '—'}</span> },
    { key: 'etd_pol', label: 'ETD POL', accessor: (l) => l.etd_pol, render: (l) => <span className="text-muted-foreground">{l.etd_pol ?? '—'}</span> },
    { key: 'e_del', label: 'E-DEL', defaultVisible: false, accessor: (l) => l.e_del, render: (l) => <span className="text-muted-foreground">{l.e_del ?? '—'}</span> },
    { key: 'expected_qty', label: 'Expected Qty', align: 'right', accessor: (l) => l.expected_qty, render: (l) => l.expected_qty.toLocaleString() },
    { key: 'sku_count', label: 'SKUs', align: 'right', defaultVisible: false, accessor: (l) => l.sku_count, render: (l) => l.sku_count.toLocaleString() },
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
      {isAdmin && (
        <>
          <Button variant="outline" size="sm" disabled={busy !== null} onClick={onSync} title="Pull mainline POs from NetSuite (upserts masters/orders/lines; booked orders are protected)">
            <RefreshCw className={cn('h-4 w-4 mr-1.5', busy === 'sync' && 'animate-spin')} />{busy === 'sync' ? 'Syncing…' : 'NetSuite Sync'}
          </Button>
          <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => fileRef.current?.click()}>
            <Upload className="h-4 w-4 mr-1.5" />{busy === 'wip' ? 'Uploading…' : 'Upload WIP'}
          </Button>
          <input ref={fileRef} type="file" accept=".xlsx,.xls" className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) onWip(f); e.target.value = ''; }} />
        </>
      )}
    </>
  );

  return (
    <DataTable
      rows={filtered} columns={columns} rowKey={(l) => l.id}
      noun="PO row" searchPlaceholder="Search PO, TRN, supplier…"
      toolbar={toolbar} emptyText="No purchase orders — sync from NetSuite or upload a WIP file" storageKey="mainline_po_columns"
      onRowClick={(l) => router.push(
        // forecast rows have no real leg → open the master detail; split rows open the leg
        l.lifecycle === 'forecast'
          ? `/mainline/purchase-orders/${encodeURIComponent(l.trn_number ?? '')}`
          : `/mainline/purchase-orders/${encodeURIComponent(l.trn_number ?? '')}/${l.id}`,
      )}
    />
  );
}
