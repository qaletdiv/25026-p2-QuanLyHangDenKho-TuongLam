'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Plus, Check, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { createMainlineBooking, approveMainlineBooking, deleteMainlineBooking } from '@/modules/mainline/actions';
import DataTable, { type DataColumn } from './DataTable';
import ConfirmDialog from './ConfirmDialog';
import { SeasonScopeFilter, seasonsFrom, applySeasonScope, type Scope } from '@/components/SeasonScopeFilter';
import type { MainlineBooking, PoMasterSummary, PoLegRow } from '@/modules/mainline/types';

// A booking's work is done once it's Approved (it has spawned its shipment) or
// terminal (Cancelled/Rejected). "Active" = still Pending approval.
const BOOKING_DONE = new Set(['Booking Approved', 'Cancelled', 'Rejected']);

const STATUS_STYLES: Record<string, string> = {
  'Booking Pending': 'bg-amber-500/10 text-amber-600 border-amber-500/20',
  'Booking Approved': 'bg-blue-500/10 text-blue-600 border-blue-500/20',
  'Cancelled': 'bg-red-500/10 text-red-600 border-red-500/20',
  'Rejected': 'bg-red-500/10 text-red-600 border-red-500/20',
  'No Booking': 'bg-slate-500/10 text-slate-600 border-slate-500/20',
};

type RowInput = { units?: string; cartons?: string; weight?: string; cbm?: string };

export default function BookingsTable({ bookings, masters, legs, initialNewSupplier = null }: {
  bookings: MainlineBooking[]; masters: PoMasterSummary[]; legs: PoLegRow[]; initialNewSupplier?: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<null | { kind: 'approve' | 'delete'; booking: MainlineBooking }>(null);

  // Season + Active/All filter (default: current season + still-pending bookings).
  const seasonOptions = useMemo(() => seasonsFrom(bookings), [bookings]);
  const [season, setSeason] = useState('all');
  const [scope, setScope] = useState<Scope>('active');
  useEffect(() => { setSeason((cur) => (cur === 'all' && seasonOptions.length ? seasonOptions[0] : cur)); }, [seasonOptions]);
  const visibleBookings = useMemo(
    () => applySeasonScope(bookings, { season, scope, isCompleted: (b) => BOOKING_DONE.has(b.booking_status || '') }),
    [bookings, season, scope],
  );

  // create-dialog state
  const [supplierId, setSupplierId] = useState('');
  const [bookingDate, setBookingDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [rows, setRows] = useState<Record<string, RowInput>>({});
  const [submitting, setSubmitting] = useState(false);
  const [warning, setWarning] = useState<null | { warnings: Array<{ po_number: string; capacity: number; already_booked: number; requested: number }> }>(null);

  const trnSupplier = useMemo(() => new Map(masters.map((m) => [m.trn_number, m.supplier_id])), [masters]);
  const suppliers = useMemo(() => {
    const m = new Map<string, string>();
    masters.forEach((ms) => {
      if (ms.supplier_id && ms.bookable && !m.has(ms.supplier_id)) {
        const leg = legs.find((l) => l.trn_number === ms.trn_number);
        m.set(ms.supplier_id, leg?.supplier || ms.supplier_id);
      }
    });
    return [...m.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [masters, legs]);

  const bookedByLeg = useMemo(() => {
    const m = new Map<string, number>();
    bookings.forEach((b) => {
      if (['Cancelled', 'Rejected'].includes(b.booking_status || '')) return;
      b.po_legs.forEach((pl) => m.set(pl.leg_id, (m.get(pl.leg_id) || 0) + (Number(pl.units) || 0)));
    });
    return m;
  }, [bookings]);
  const remainingOf = (l: PoLegRow) => l.expected_qty - (bookedByLeg.get(l.id) || 0);

  const supplierLegs = useMemo(
    () => (supplierId ? legs.filter((l) => trnSupplier.get(l.trn_number || '') === supplierId) : []),
    [legs, supplierId, trnSupplier]
  );

  const setField = (legId: string, field: keyof RowInput, value: string) =>
    setRows((r) => ({ ...r, [legId]: { ...r[legId], [field]: value } }));

  const num = (v?: string) => { const n = Number(v); return v && !isNaN(n) && n > 0 ? n : undefined; };
  const selected = supplierLegs
    .map((l) => {
      const r = rows[l.id] || {};
      const units = Number(r.units) || 0;
      return units > 0 ? { leg_id: l.id, units, cartons: num(r.cartons), weight_kg: num(r.weight), cbm: num(r.cbm) } : null;
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  // G3 — multiple POs can ship together only with one destination + one mode (same
  // supplier is already guaranteed by the supplier filter). Block before submit.
  const selectedRows = useMemo(
    () => supplierLegs.filter((l) => (Number(rows[l.id]?.units) || 0) > 0),
    [supplierLegs, rows],
  );
  const destinations = [...new Set(selectedRows.map((l) => l.receiving_warehouse ?? '—'))];
  const modesSel = [...new Set(selectedRows.map((l) => l.mode ?? '—'))];
  const consignmentConflict = selectedRows.length > 1 && (destinations.length > 1 || modesSel.length > 1);

  function resetForm() { setSupplierId(''); setRows({}); setWarning(null); setBookingDate(new Date().toISOString().slice(0, 10)); }

  // "Book Now" on the PO masters table lands here with ?new=<supplier_id> —
  // open the create dialog with that supplier preselected.
  useEffect(() => {
    if (!initialNewSupplier) return;
    resetForm();
    if (suppliers.some((s) => s.id === initialNewSupplier)) setSupplierId(initialNewSupplier);
    setOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialNewSupplier]);

  async function submit(force = false) {
    if (!supplierId || selected.length === 0) { toast.error('Pick a supplier and enter units on at least one PO'); return; }
    if (consignmentConflict) { toast.error('Multiple POs can be booked together only when they share one destination and one mode.'); return; }
    setSubmitting(true);
    const res = await createMainlineBooking({ supplier_id: supplierId, booking_date: bookingDate || undefined, po_legs: selected, force_overbook: force });
    setSubmitting(false);
    if (res?.overbook_warning) { setWarning(res); return; }
    if (res?.error) { toast.error(res.error); return; }
    toast.success(`Booking ${res.booking_number} created (${selected.length} PO${selected.length === 1 ? '' : 's'})`);
    setOpen(false); resetForm(); router.refresh();
  }
  async function approve(id: string) {
    setBusyId(id);
    const res = await approveMainlineBooking(id);
    setBusyId(null);
    if (res?.error) { toast.error(res.error); return; }
    toast.success(`Approved — ${res.shipments_created} shipment(s) created`);
    router.refresh();
  }
  async function remove(id: string) {
    setBusyId(id);
    const res = await deleteMainlineBooking(id);
    setBusyId(null);
    if (res?.error) { toast.error(res.error); return; }
    toast.success('Booking deleted');
    router.refresh();
  }

  const columns: DataColumn<MainlineBooking>[] = [
    { key: 'booking_number', label: 'Booking #', accessor: (b) => b.booking_number, render: (b) => <Link href={`/mainline/bookings/${b.id}`} className="text-primary hover:underline font-medium">{b.booking_number}</Link> },
    { key: 'supplier', label: 'Supplier', accessor: (b) => b.supplier_name ?? b.supplier_id, render: (b) => <span className="text-muted-foreground">{b.supplier_name ?? b.supplier_id ?? '—'}</span> },
    { key: 'season', label: 'Season', defaultVisible: false, accessor: (b) => b.season, render: (b) => <span className="text-muted-foreground">{b.season ?? '—'}</span> },
    { key: 'mode', label: 'Mode', accessor: (b) => b.mode, render: (b) => b.mode ?? '—' },
    { key: 'legs', label: 'POs', sortable: false, accessor: (b) => b.po_legs.map((l) => l.po_number).join(', '), render: (b) => <span className="text-xs">{b.po_legs.map((l) => l.po_number).filter(Boolean).join(', ') || '—'}</span> },
    { key: 'units', label: 'Units', align: 'right', defaultVisible: false, accessor: (b) => b.po_legs.reduce((a, l) => a + (Number(l.units) || 0), 0), render: (b) => b.po_legs.reduce((a, l) => a + (Number(l.units) || 0), 0).toLocaleString() },
    { key: 'booked', label: 'Booked', accessor: (b) => b.submitted_at, render: (b) => <span className="text-muted-foreground">{b.submitted_at ? b.submitted_at.slice(0, 10) : '—'}</span> },
    { key: 'approved', label: 'Approved', defaultVisible: false, accessor: (b) => b.approved_at, render: (b) => <span className="text-muted-foreground">{b.approved_at ? b.approved_at.slice(0, 10) : '—'}</span> },
    { key: 'cargo_ready_date', label: 'Cargo Ready', accessor: (b) => b.cargo_ready_date, render: (b) => <span className="text-muted-foreground">{b.cargo_ready_date ?? '—'}</span> },
    { key: 'booking_status', label: 'Status', accessor: (b) => b.booking_status, render: (b) => <Badge variant="outline" className={cn(STATUS_STYLES[b.booking_status || ''])}>{b.booking_status ?? '—'}</Badge> },
    { key: 'actions', label: 'Actions', align: 'right', sortable: false, render: (b) => (
      <div className="space-x-2 whitespace-nowrap">
        {b.booking_status === 'Booking Pending' && <Button size="sm" variant="outline" disabled={busyId === b.id} onClick={() => setConfirmAction({ kind: 'approve', booking: b })}><Check className="h-4 w-4 mr-1" /> Approve</Button>}
        <Button size="sm" variant="ghost" disabled={busyId === b.id} title="Delete booking" onClick={() => setConfirmAction({ kind: 'delete', booking: b })}><Trash2 className="h-4 w-4 text-red-500" /></Button>
      </div>
    ) },
  ];

  const toolbar = (
    <>
      <SeasonScopeFilter season={season} seasons={seasonOptions} onSeason={setSeason} scope={scope} onScope={setScope} activeLabel="Pending" />
      <Button onClick={() => { resetForm(); setOpen(true); }}><Plus className="h-4 w-4 mr-1" /> New Booking</Button>
    </>
  );

  return (
    <>
      <DataTable
        rows={visibleBookings} columns={columns} rowKey={(b) => b.id}
        title="Bookings" noun="booking" searchPlaceholder="Search booking #, supplier, PO…"
        toolbar={toolbar} emptyText="No bookings match this filter" storageKey="mainline_booking_columns"
      />

      <ConfirmDialog
        open={confirmAction !== null}
        title={confirmAction?.kind === 'delete' ? `Delete booking ${confirmAction.booking.booking_number}?` : `Approve booking ${confirmAction?.booking.booking_number}?`}
        description={confirmAction?.kind === 'delete'
          ? 'The booking and its linked shipments will be removed. This cannot be undone.'
          : 'Approving creates the shipment records for this booking (one per destination + mode) and hands them to logistics.'}
        confirmLabel={confirmAction?.kind === 'delete' ? 'Delete' : 'Approve'}
        destructive={confirmAction?.kind === 'delete'}
        busy={busyId === confirmAction?.booking.id}
        onCancel={() => setConfirmAction(null)}
        onConfirm={async () => {
          if (!confirmAction) return;
          const { kind, booking } = confirmAction;
          if (kind === 'delete') await remove(booking.id); else await approve(booking.id);
          setConfirmAction(null);
        }}
      />

      <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) resetForm(); }} modal={false}>
        <DialogContent
          className="w-[95vw] max-w-6xl max-h-[90vh] overflow-y-auto"
          /* Don't dismiss the form on any outside click (it's a multi-field form).
             Close only via the X button, Escape, or a successful submit. */
          onInteractOutside={(e) => e.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle>New Booking</DialogTitle>
            <p className="text-sm text-muted-foreground">Single PO, or multiple POs from the same supplier (G1). Cartons / gross weight are booking estimates for the freight forwarder — actuals come from the CI &amp; packing list.</p>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label>Supplier</Label>
                <Select value={supplierId} onValueChange={(v) => { setSupplierId(v ?? ''); setRows({}); setWarning(null); }}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Select a supplier">
                      {(value: string | null) => suppliers.find((s) => s.id === value)?.name ?? value}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent className="max-h-72 min-w-[16rem] sm:min-w-[28rem]">{suppliers.map((s) => <SelectItem key={s.id} value={s.id} className="whitespace-nowrap">{s.name}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Booking Date</Label>
                <Input type="date" value={bookingDate} onChange={(e) => setBookingDate(e.target.value)} />
              </div>
            </div>

            {supplierId && (
              <div className="space-y-1.5">
                <Label>POs / legs — enter units to include ({selected.length} selected)</Label>
                <div className="max-h-[55vh] overflow-auto rounded-md border border-border">
                  <Table className="bg-card">
                    <TableHeader>
                      <TableRow className="bg-card/80 hover:bg-card/80">
                        <TableHead>PO</TableHead>
                        <TableHead>Mode</TableHead>
                        <TableHead>Destination</TableHead>
                        <TableHead>Channel</TableHead>
                        <TableHead>CRD</TableHead>
                        <TableHead className="text-right">Remaining / Cap.</TableHead>
                        <TableHead className="text-right">Units</TableHead>
                        <TableHead className="text-right">Cartons</TableHead>
                        <TableHead className="text-right">Gross Wt (kg)</TableHead>
                        <TableHead className="text-right">CBM</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {supplierLegs.length === 0 && (
                        <TableRow><TableCell colSpan={10} className="text-center text-muted-foreground py-6">No bookable legs for this supplier.</TableCell></TableRow>
                      )}
                      {supplierLegs.map((l) => {
                        const r = rows[l.id] || {};
                        const remaining = remainingOf(l);
                        const entered = Number(r.units) || 0;
                        const over = entered > remaining;
                        return (
                          <TableRow key={l.id} className={cn('border-border', entered > 0 && 'bg-primary/5')}>
                            <TableCell className="font-medium whitespace-nowrap">{l.po_number}</TableCell>
                            <TableCell className="whitespace-nowrap">{l.mode ?? '—'}</TableCell>
                            <TableCell className="text-muted-foreground whitespace-nowrap">{l.receiving_warehouse ?? '—'}</TableCell>
                            <TableCell className="text-muted-foreground whitespace-nowrap">{l.allocation_channel ?? '—'}</TableCell>
                            <TableCell className="text-muted-foreground whitespace-nowrap">{l.crd ?? '—'}</TableCell>
                            <TableCell className="text-right tabular-nums whitespace-nowrap">
                              <span className={cn(remaining <= 0 ? 'text-red-500' : 'text-emerald-600')}>{remaining.toLocaleString()}</span>
                              <span className="text-muted-foreground"> / {l.expected_qty.toLocaleString()}</span>
                            </TableCell>
                            <TableCell className="text-right">
                              <Input type="number" min={0} className={cn('w-20 h-8 ml-auto', over && 'border-amber-500 focus-visible:ring-amber-500')} placeholder="0"
                                value={r.units ?? ''} onChange={(e) => setField(l.id, 'units', e.target.value)} />
                              {over && <div className="text-[10px] text-amber-600 mt-0.5">over by {(entered - remaining).toLocaleString()}</div>}
                            </TableCell>
                            <TableCell className="text-right"><Input type="number" min={0} className="w-20 h-8 ml-auto" placeholder="—" value={r.cartons ?? ''} onChange={(e) => setField(l.id, 'cartons', e.target.value)} /></TableCell>
                            <TableCell className="text-right"><Input type="number" min={0} step="0.01" className="w-24 h-8 ml-auto" placeholder="—" value={r.weight ?? ''} onChange={(e) => setField(l.id, 'weight', e.target.value)} /></TableCell>
                            <TableCell className="text-right"><Input type="number" min={0} step="0.001" className="w-20 h-8 ml-auto" placeholder="—" value={r.cbm ?? ''} onChange={(e) => setField(l.id, 'cbm', e.target.value)} /></TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              </div>
            )}

            {consignmentConflict && (
              <div className="rounded-md border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-700 space-y-1">
                <p className="font-medium">Can&apos;t combine these POs in one booking</p>
                <p>Multiple POs ship together only with one destination and one mode. Selected destinations: [{destinations.join(', ')}]; modes: [{modesSel.join(', ')}].</p>
              </div>
            )}

            {warning && (
              <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-700 space-y-1">
                <p className="font-medium">Overbooking warning</p>
                {warning.warnings.map((w, i) => <p key={i}>{w.po_number}: {w.already_booked}+{w.requested} &gt; capacity {w.capacity}</p>)}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={submitting} onClick={() => { setOpen(false); resetForm(); }}>Cancel</Button>
            {warning
              ? <Button variant="destructive" disabled={submitting} onClick={() => submit(true)}>Book anyway</Button>
              : <Button disabled={submitting || selected.length === 0 || consignmentConflict} onClick={() => submit(false)}>{submitting ? 'Creating…' : `Create booking (${selected.length} PO${selected.length === 1 ? '' : 's'})`}</Button>}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
