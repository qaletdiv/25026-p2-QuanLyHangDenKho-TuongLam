'use client';

import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Search, ChevronRight, ChevronDown, ChevronLeft } from 'lucide-react';
import { cn } from '@/lib/utils';
import { updateMainlineShipment } from '@/modules/mainline/actions';
import ColumnPicker from './ColumnPicker';
import { SeasonScopeFilter, seasonsFrom, applySeasonScope, type Scope } from '@/components/SeasonScopeFilter';
import type { MainlineShipment, MainlineShipmentStatus } from '@/modules/mainline/types';

// A mainline shipment is done once Received (or Delivered), or terminal (Cancelled).
const SHIP_DONE = new Set(['Received', 'Delivered', 'Cancelled']);

const STATUSES: MainlineShipmentStatus[] = ['Ready to Ship', 'In Transit', 'At Port', 'Delivered', 'Received', 'Cancelled'];
const STATUS_STYLES: Record<string, string> = {
  'Ready to Ship': 'bg-blue-500/10 text-blue-600 border-blue-500/20',
  'In Transit': 'bg-violet-500/10 text-violet-600 border-violet-500/20',
  'At Port': 'bg-cyan-500/10 text-cyan-600 border-cyan-500/20',
  'Delivered': 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20',
  'Received': 'bg-emerald-600/10 text-emerald-700 border-emerald-600/20',
  'Cancelled': 'bg-red-500/10 text-red-600 border-red-500/20',
};
const PAGE_SIZE = 10;
const STORAGE_KEY = 'mainline_shipment_columns';

type ShipColumn = {
  key: string;
  label: string;
  align?: 'right';
  defaultVisible?: boolean;    // default true; hidden columns stay selectable in the picker
  stopClick?: boolean;         // cell contains its own control — don't toggle the row expander
  render: (s: MainlineShipment) => ReactNode;
};

const dim = (v: string | null | undefined) => <span className="text-muted-foreground">{v || '—'}</span>;

export default function ShipmentsTable({ shipments }: { shipments: MainlineShipment[] }) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  // in-progress inline edits of the carrier reference # (per shipment id); absent = not edited
  const [carrierRefEdits, setCarrierRefEdits] = useState<Record<string, string>>({});

  // Season + Active/All filter (default: current season + in-flight shipments).
  const seasonOptions = useMemo(() => seasonsFrom(shipments), [shipments]);
  const [season, setSeason] = useState('all');
  const [scope, setScope] = useState<Scope>('active');
  useEffect(() => { setSeason((cur) => (cur === 'all' && seasonOptions.length ? seasonOptions[0] : cur)); }, [seasonOptions]);

  const sorted = useMemo(
    () => [...shipments].sort((a, b) => (a.shipment_number || '').localeCompare(b.shipment_number || '', undefined, { numeric: true })),
    [shipments],
  );

  const filtered = useMemo(() => {
    const scoped = applySeasonScope(sorted, { season, scope, isCompleted: (s) => SHIP_DONE.has(s.status || '') });
    const q = search.trim().toLowerCase();
    if (!q) return scoped;
    return scoped.filter((s) =>
      [s.shipment_number, s.booking_number, s.supplier_name, s.destination_facility, s.bl_no, s.carrier_reference, ...s.po_numbers]
        .some((v) => (v || '').toLowerCase().includes(q)),
    );
  }, [sorted, search, season, scope]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const current = Math.min(page, totalPages);
  const paged = filtered.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);
  const totalLegs = shipments.reduce((a, s) => a + (s.legs?.length || 0), 0);

  async function changeStatus(id: string, status: string) {
    setBusyId(id);
    const res = await updateMainlineShipment(id, { status });
    setBusyId(null);
    if (res?.error) { toast.error(res.error); return; }
    toast.success(`Status → ${status}`);
    router.refresh();
  }

  // Inline save of a carrier reference # (on blur / Enter). No-op if unchanged.
  async function saveCarrierRef(sh: MainlineShipment) {
    const draft = carrierRefEdits[sh.id];
    if (draft === undefined) return;                       // never edited this cell
    const next = draft.trim();
    const dropDraft = () => setCarrierRefEdits((p) => { const n = { ...p }; delete n[sh.id]; return n; });
    if (next === (sh.carrier_reference ?? '')) { dropDraft(); return; }   // unchanged
    setBusyId(sh.id);
    const res = await updateMainlineShipment(sh.id, { carrier_reference: next || null });
    setBusyId(null);
    if (res?.error) { toast.error(res.error); return; }    // keep the draft so the edit isn't lost
    dropDraft();
    toast.success('Carrier reference updated');
    router.refresh();
  }

  const columns: ShipColumn[] = [
    { key: 'shipment', label: 'Shipment', render: (s) => (
      <Link href={`/mainline/shipments/${s.id}`} className="text-primary hover:underline font-medium" onClick={(e) => e.stopPropagation()}>{s.shipment_number}</Link>
    ) },
    { key: 'booking', label: 'Booking', render: (s) => s.booking_number
      ? <Link href={`/mainline/bookings/${s.booking_id}`} className="text-primary hover:underline" onClick={(e) => e.stopPropagation()}>{s.booking_number}</Link>
      : '—' },
    { key: 'supplier', label: 'Supplier', render: (s) => dim(s.supplier_name) },
    { key: 'destination', label: 'Destination', render: (s) => s.destination_facility ?? '—' },
    { key: 'season', label: 'Season', defaultVisible: false, render: (s) => dim(s.season) },
    { key: 'mode', label: 'Mode', render: (s) => s.mode ?? '—' },
    { key: 'container_type', label: 'Container', defaultVisible: false, render: (s) => dim(s.container_type) },
    { key: 'pos', label: 'POs', render: (s) => <span className="text-xs">{s.po_numbers.length} PO{s.po_numbers.length === 1 ? '' : 's'}: {s.po_numbers.join(', ') || '—'}</span> },
    { key: 'total_qty', label: 'Total Qty', align: 'right', render: (s) => <span className="tabular-nums">{s.total_expected_quantity.toLocaleString()}</span> },
    { key: 'bl_no', label: 'BL No', defaultVisible: false, render: (s) => dim(s.bl_no) },
    { key: 'courier', label: 'Carrier', render: (s) => dim(s.courier) },
    { key: 'carrier_reference', label: 'Carrier Ref #', stopClick: true, render: (s) => (
      <Input
        className="h-8 w-40"
        placeholder="—"
        value={carrierRefEdits[s.id] ?? (s.carrier_reference ?? '')}
        disabled={busyId === s.id}
        onChange={(e) => setCarrierRefEdits((p) => ({ ...p, [s.id]: e.target.value }))}
        onBlur={() => saveCarrierRef(s)}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
      />
    ) },
    { key: 'pol_port', label: 'POL', defaultVisible: false, render: (s) => dim(s.pol_port) },
    { key: 'pod_port', label: 'POD', defaultVisible: false, render: (s) => dim(s.pod_port) },
    { key: 'coo', label: 'COO', defaultVisible: false, render: (s) => dim(s.coo.join(', ')) },
    { key: 'crd', label: 'CRD', defaultVisible: false, render: (s) => dim(s.crd) },
    { key: 'etd_pol', label: 'ETD POL', defaultVisible: false, render: (s) => dim(s.etd_pol) },
    { key: 'eta_pod', label: 'ETA POD', defaultVisible: false, render: (s) => dim(s.eta_pod) },
    { key: 'e_del', label: 'E-DEL', render: (s) => dim(s.e_del) },
    { key: 'ata', label: 'ATA', defaultVisible: false, render: (s) => dim(s.ata) },
    { key: 'status', label: 'Status', stopClick: true, render: (s) => (
      <Select value={s.status ?? undefined} onValueChange={(v) => v && changeStatus(s.id, v)} disabled={busyId === s.id}>
        <SelectTrigger className="h-8 w-[150px] border-0 p-0 shadow-none focus:ring-0">
          <Badge variant="outline" className={cn(STATUS_STYLES[s.status || ''])}><SelectValue placeholder="—" /></Badge>
        </SelectTrigger>
        <SelectContent>{STATUSES.map((st) => <SelectItem key={st} value={st}>{st}</SelectItem>)}</SelectContent>
      </Select>
    ) },
  ];

  const [visible, setVisible] = useState<string[]>(columns.filter((c) => c.defaultVisible !== false).map((c) => c.key));
  // restore the saved column selection after mount (localStorage is client-only)
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (Array.isArray(saved)) {
        const valid = saved.filter((k): k is string => typeof k === 'string' && columns.some((c) => c.key === k));
        if (valid.length) setVisible(valid);
      }
    } catch { /* corrupt pref — keep defaults */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function toggleColumn(key: string) {
    setVisible((prev) => {
      const next = prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key];
      if (next.length === 0) return prev; // keep at least one column visible
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* quota/private mode */ }
      return next;
    });
  }

  const visibleCols = columns.filter((c) => visible.includes(c.key));

  return (
    <div className="p-4 md:p-6 space-y-4">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm text-muted-foreground">{filtered.length} shipment{filtered.length === 1 ? '' : 's'} · {totalLegs} PO leg{totalLegs === 1 ? '' : 's'}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <SeasonScopeFilter season={season} seasons={seasonOptions} onSeason={(v) => { setSeason(v); setPage(1); }} scope={scope} onScope={(v) => { setScope(v); setPage(1); }} activeLabel="In Transit" />
          <ColumnPicker columns={columns.map((c) => ({ key: c.key, label: c.label }))} visible={visible} onToggle={toggleColumn} />
          <div className="relative w-full sm:w-64">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input className="pl-8" placeholder="Search shipment, booking, PO, dest…" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} />
          </div>
        </div>
      </div>

      <Card className="overflow-x-auto">
        <Table className="bg-card">
          <TableHeader>
            <TableRow className="bg-card/80 hover:bg-card/80">
              <TableHead className="w-8" />
              {visibleCols.map((c) => (
                <TableHead key={c.key} className={cn('whitespace-nowrap', c.align === 'right' && 'text-right')}>{c.label}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {paged.length === 0 && (
              <TableRow><TableCell colSpan={visibleCols.length + 1} className="text-center text-muted-foreground py-10">No shipments</TableCell></TableRow>
            )}
            {paged.map((s) => {
              const isOpen = !!open[s.id];
              return (
                <Fragment key={s.id}>
                  <TableRow className="border-border hover:bg-muted/30 cursor-pointer" onClick={() => setOpen((o) => ({ ...o, [s.id]: !o[s.id] }))}>
                    <TableCell>{isOpen ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}</TableCell>
                    {visibleCols.map((c) => (
                      <TableCell
                        key={c.key}
                        className={cn(c.align === 'right' && 'text-right')}
                        onClick={c.stopClick ? (e) => e.stopPropagation() : undefined}
                      >
                        {c.render(s)}
                      </TableCell>
                    ))}
                  </TableRow>
                  {isOpen && (
                    <TableRow className="bg-muted/20 hover:bg-muted/20">
                      <TableCell />
                      <TableCell colSpan={visibleCols.length} className="p-0">
                        <Table>
                          <TableHeader>
                            <TableRow className="hover:bg-transparent">
                              <TableHead>PO</TableHead><TableHead>Mode</TableHead><TableHead>Channel</TableHead>
                              <TableHead className="text-right">Qty</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {s.legs.map((l) => (
                              <TableRow key={l.leg_id} className="border-border/50 hover:bg-muted/30">
                                <TableCell className="font-medium">{l.po_number ?? `#${l.leg_id}`}</TableCell>
                                <TableCell>{l.mode ?? '—'}</TableCell>
                                <TableCell className="text-muted-foreground">{l.allocation_channel ?? '—'}</TableCell>
                                <TableCell className="text-right tabular-nums">{(l.expected_quantity ?? 0).toLocaleString()}</TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              );
            })}
          </TableBody>
        </Table>
      </Card>

      {filtered.length > 0 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">Showing {(current - 1) * PAGE_SIZE + 1}–{Math.min(current * PAGE_SIZE, filtered.length)} of {filtered.length}</p>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" disabled={current <= 1} onClick={() => setPage(current - 1)}><ChevronLeft className="h-4 w-4 mr-1" /> Prev</Button>
            <span className="text-sm text-muted-foreground tabular-nums">Page {current} of {totalPages}</span>
            <Button variant="outline" size="sm" disabled={current >= totalPages} onClick={() => setPage(current + 1)}>Next <ChevronRight className="h-4 w-4 ml-1" /></Button>
          </div>
        </div>
      )}
    </div>
  );
}
