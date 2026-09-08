'use client';

// New SMS booking — the OPTIONAL authorization step. The vendor picks a
// destination and the PO-lots they intend to ship; Logistics approves, which
// creates the draft consignment(s). Mirrors SmsShipmentForm's shape (one
// destination per consignment, per-PO units) with the booking's own guards:
// the server enforces G1 (one supplier), G3 (one destination), the hard
// lot-not-double-booked check, and soft G2 overbooking (409 → "Book anyway").

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { createSmsBooking } from '@/modules/sms/actions';
import { facilityLabel } from './smsStatus';
import type { SmsPo, IncotermOption, CourierOption, ModeOption } from '@/modules/sms/types';

// Cartons + weight are the carrier ESTIMATE for this lot, exactly as on the
// mainline booking form — the actuals arrive later off the packing list
// (sms_cartons holds the per-box net/gross). Both are optional.
type RowInput = { units?: string; cartons?: string; weight?: string };
type Warning = { po_number: string; ordered: number; already_booked: number; requested: number; overage: number };

export default function SmsBookingForm({ open, onClose, pos, incoterms = [], couriers = [], modes = [] }: {
  open: boolean;
  onClose: () => void;
  pos: SmsPo[];
  incoterms?: IncotermOption[];
  couriers?: CourierOption[];
  modes?: ModeOption[];
}) {
  const router = useRouter();
  const [crd, setCrd] = useState('');
  const [incotermId, setIncotermId] = useState('');
  // Carrier + mode are REQUIRED and deliberately NOT pre-filled. Approve used to
  // stamp FedEx/Courier on the draft regardless, which is what sent the wrong
  // shipping method to NetSuite — a default here would just move the guess.
  const [courierId, setCourierId] = useState('');
  const [modeId, setModeId] = useState('');
  const [facilityId, setFacilityId] = useState('');
  // Supplier is a VIEW filter over the PO list, not a booking field — the booking's
  // supplier is still derived from the POs actually selected. Staff picking a busy
  // destination otherwise get every supplier's POs interleaved with no way to narrow;
  // vendors never see this control at all (their list is one supplier, so it hides).
  const [filterSupplierId, setFilterSupplierId] = useState('');
  const [rows, setRows] = useState<Record<string, RowInput>>({});
  const [submitting, setSubmitting] = useState(false);
  const [warnings, setWarnings] = useState<Warning[] | null>(null);

  // `eligible` is NOT filtered by supplier here: `/sms/pos` is already vendor-scoped
  // server-side (smsPoController._ctx), so a vendor's list is their own POs and
  // nothing else. The supplier control below is a staff convenience filter over an
  // already-authorized list, never a visibility control.
  //
  // It keys on supplier_id. NEVER on the name: a previous version compared supplier
  // NAMES with plain trim/lowercase and matched 0 POs for the live vendor account
  // ("Best Star Fashions Co Ltd" vs the master-data "Best Star Fashions Co., Ltd."),
  // leaving the form with no selectable destination. The server matches on
  // supplierKey (punctuation-insensitive) — same trap, fixed backend-side 2026-08-12.
  const eligible = useMemo(
    () => [...pos].sort((a, b) => (b.remaining_qty > 0 ? 1 : 0) - (a.remaining_qty > 0 ? 1 : 0) || a.po_number.localeCompare(b.po_number)),
    [pos],
  );

  // One booking = one destination (G3), so Destination drives which POs are enterable.
  const destinations = useMemo(() => {
    const m = new Map<string, string>();
    eligible.forEach((p) => { if (p.facility_id && !m.has(p.facility_id)) m.set(p.facility_id, facilityLabel(p.facility) ?? p.facility_id); });
    return [...m.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [eligible]);

  const displayed = useMemo(
    () => (facilityId ? eligible.filter((p) => p.facility_id === facilityId) : []),
    [eligible, facilityId],
  );

  // Suppliers present at the chosen destination. One or none → the filter is not
  // rendered, which is exactly the vendor case (their POs are all one supplier).
  const supplierOptions = useMemo(() => {
    const m = new Map<string, string>();
    displayed.forEach((p) => { if (p.supplier_id && !m.has(p.supplier_id)) m.set(p.supplier_id, p.supplier ?? p.supplier_id); });
    return [...m.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [displayed]);

  // What the table renders. `selected` deliberately reads `displayed`, NOT this —
  // narrowing the view must never silently drop units already entered on a PO that
  // the filter happens to hide.
  const visible = useMemo(
    () => (filterSupplierId ? displayed.filter((p) => p.supplier_id === filterSupplierId) : displayed),
    [displayed, filterSupplierId],
  );

  // G1: one supplier per booking. Which supplier is implied by the POs chosen.
  const selected = displayed
    .map((p) => {
      const r = rows[p.po_number] || {};
      const units = Number(r.units) || 0;
      return units > 0
        ? { po: p, po_number: p.po_number, units, cartons: Number(r.cartons) || undefined, weight_kg: Number(r.weight) || undefined }
        : null;
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
  const supplierIds = [...new Set(selected.map((s) => s.po.supplier_id).filter(Boolean))] as string[];
  // Kept as a last-resort guard. With the lock below it should never fire — but G1
  // is a real server rule, and this is cheaper than a 400 round-trip if it ever does.
  const supplierClash = supplierIds.length > 1;

  // Once ONE supplier has units, every other supplier's row locks. This turns G1
  // from "rejected at submit, after you filled in a long list" into something the
  // form simply won't let you express — mainline gets the same property for free by
  // making supplier the first pick. Clearing the units unlocks the rest.
  const lockedSupplierId = supplierIds.length === 1 ? supplierIds[0] : null;
  const lockedSupplierName = lockedSupplierId
    ? (selected.find((s) => s.po.supplier_id === lockedSupplierId)?.po.supplier ?? null)
    : null;
  const isLocked = (supplierId: string | null) => lockedSupplierId != null && supplierId !== lockedSupplierId;

  const setField = (po: string, field: keyof RowInput, value: string) =>
    setRows((r) => ({ ...r, [po]: { ...r[po], [field]: value } }));

  const changeDestination = (id: string) => { setFacilityId(id); setRows({}); setWarnings(null); setFilterSupplierId(''); };

  function reset() { setRows({}); setWarnings(null); setCrd(''); setIncotermId(''); setFacilityId(''); setCourierId(''); setModeId(''); setFilterSupplierId(''); }

  async function submit(force = false) {
    if (selected.length === 0) { toast.error('Enter units on at least one PO'); return; }
    if (supplierClash) { toast.error('One booking covers one supplier — deselect POs from the others'); return; }
    if (!courierId) { toast.error('Pick the carrier'); return; }
    if (!modeId) { toast.error('Pick the mode — it becomes the shipping method on the NetSuite receipt'); return; }
    setSubmitting(true);
    const res = await createSmsBooking({
      supplier_id: supplierIds[0],
      incoterm_id: incotermId || null,
      courier_id: courierId,
      mode_id: modeId,
      cargo_ready_date: crd || null,
      pos: selected.map(({ po_number, units, cartons, weight_kg }) => ({ po_number, units, cartons, weight_kg })),
      force_overbook: force,
    });
    setSubmitting(false);
    if (res?.overbook_warning) { setWarnings(res.warnings); return; }
    if (res?.error) { toast.error(res.error); return; }
    toast.success(`Booking ${res.booking_number} submitted — Logistics approves it, which creates the consignment`);
    onClose(); reset(); router.refresh();
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) { onClose(); reset(); } }} modal={false}>
      {/* Wider than SmsShipmentForm's 3xl on purpose: this form carries five header
          fields (Destination/Carrier/Mode/CRD/Incoterm) plus a seven-column PO table.
          At 3xl the fields wrapped to 3 + 2 with an orphan slot and the table was
          cramped; 5xl lets both sit on one row each. */}
      <DialogContent className="w-[95vw] max-w-5xl" onInteractOutside={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle>New SMS Booking</DialogTitle>
          <p className="text-sm text-muted-foreground">
            Authorize a consignment before it ships. Approval creates the shipment as a draft —
            the tracking number is added when the box actually goes out. One booking covers one
            supplier and one destination.
          </p>
        </DialogHeader>

      {/* min-w-0 is load-bearing: DialogContent is a CSS grid, so this child defaults
          to min-width:auto and refuses to shrink below the PO table's min-content
          width — which silently overrode the table's own overflow-auto and pushed the
          form past the dialog edge on narrower screens (measured 899px of content in
          an 853px box at a 900px viewport). With it, the table scrolls inside its
          bordered box instead and the dialog never overflows. */}
        <div className="space-y-4 min-w-0">
          {/* 5-across once there is room for it; 3-across on mid widths, stacked on
              mobile. Five fields in a 3-col grid left a hole in the second row. */}
          <div className="grid grid-cols-1 sm:grid-cols-3 lg:grid-cols-5 gap-4">
            <div className="space-y-1.5">
              <Label>Destination</Label>
              <Select value={facilityId} onValueChange={(v) => v && changeDestination(v)}>
                {/* label rendered directly — SelectValue shows the raw id for a programmatic value */}
                <SelectTrigger className="w-full">
                  <span className={cn(!facilityId && 'text-muted-foreground')}>{destinations.find((d) => d.id === facilityId)?.name || 'Select destination'}</span>
                </SelectTrigger>
                <SelectContent>{destinations.map((d) => <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            {/* Carrier + Mode. Independent on purpose — Ceva runs both sea and air,
                so the carrier cannot imply the mode. Mode is what the landed-cost
                push sends to NetSuite as the shipping method. */}
            <div className="space-y-1.5">
              <Label>Carrier</Label>
              <Select value={courierId} onValueChange={(v) => v && setCourierId(v)}>
                <SelectTrigger className="w-full">
                  <span className={cn(!courierId && 'text-muted-foreground')}>{couriers.find((c) => c.id === courierId)?.name || 'Select carrier'}</span>
                </SelectTrigger>
                <SelectContent>{couriers.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Mode</Label>
              <Select value={modeId} onValueChange={(v) => v && setModeId(v)}>
                <SelectTrigger className="w-full">
                  <span className={cn(!modeId && 'text-muted-foreground')}>{modes.find((m) => m.id === modeId)?.name || 'Select mode'}</span>
                </SelectTrigger>
                <SelectContent>{modes.map((m) => <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Cargo Ready Date</Label>
              <Input type="date" value={crd} onChange={(e) => setCrd(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>Incoterm <span className="text-muted-foreground font-normal">(optional)</span></Label>
              <Select value={incotermId} onValueChange={(v) => setIncotermId(v ?? '')}>
                <SelectTrigger className="w-full">
                  <span className={cn(!incotermId && 'text-muted-foreground')}>{incoterms.find((i) => i.id === incotermId)?.name || 'None'}</span>
                </SelectTrigger>
                <SelectContent>{incoterms.map((i) => <SelectItem key={i.id} value={i.id}>{i.name}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <div className="flex flex-wrap items-end justify-between gap-2">
              <Label>POs to authorize — enter units to include ({selected.length} selected)</Label>
              {/* Rendered only when the destination actually holds more than one
                  supplier — so a vendor never sees it. Filtering is a VIEW change:
                  `selected` reads the unfiltered list, so hiding a row cannot drop
                  units already entered on it. */}
              {supplierOptions.length > 1 && (
                <Select value={filterSupplierId || 'all'} onValueChange={(v) => setFilterSupplierId(v === 'all' ? '' : (v ?? ''))}>
                  <SelectTrigger className="h-8 w-56 text-xs">
                    <span className={cn(!filterSupplierId && 'text-muted-foreground')}>
                      {supplierOptions.find((s) => s.id === filterSupplierId)?.name || 'All suppliers'}
                    </span>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All suppliers</SelectItem>
                    {supplierOptions.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              )}
            </div>
            {lockedSupplierName && supplierOptions.length > 1 && (
              <p className="text-xs text-muted-foreground">
                One booking covers one supplier — POs from other suppliers are locked while{' '}
                <span className="text-foreground">{lockedSupplierName}</span> has units. Clear them to switch.
              </p>
            )}
            <div className="max-h-72 overflow-auto rounded-md border border-border">
              <Table className="bg-card">
                <TableHeader>
                  <TableRow className="bg-card/80 hover:bg-card/80">
                    <TableHead>PO</TableHead>
                    <TableHead>Supplier</TableHead>
                    <TableHead>HOD</TableHead>
                    <TableHead className="text-right">Remaining / Ordered</TableHead>
                    <TableHead className="text-right">Units</TableHead>
                    <TableHead className="text-right">Cartons</TableHead>
                    <TableHead className="text-right">Weight (kg)</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {!facilityId && (
                    <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground py-6">Pick a destination above to list its POs.</TableCell></TableRow>
                  )}
                  {facilityId && displayed.length === 0 && (
                    <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground py-6">No open POs for this destination.</TableCell></TableRow>
                  )}
                  {facilityId && displayed.length > 0 && visible.length === 0 && (
                    <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground py-6">No POs for this supplier at this destination.</TableCell></TableRow>
                  )}
                  {visible.map((p) => {
                    const r = rows[p.po_number] || {};
                    const entered = Number(r.units) || 0;
                    const over = entered > p.remaining_qty;
                    const locked = isLocked(p.supplier_id ?? null);
                    return (
                      <TableRow key={p.po_number} className={cn('border-border', entered > 0 && 'bg-primary/5', locked && 'opacity-40')}>
                        <TableCell className="font-medium whitespace-nowrap">{p.po_number}</TableCell>
                        <TableCell className="text-muted-foreground whitespace-nowrap">{p.supplier ?? '—'}</TableCell>
                        <TableCell className="text-muted-foreground whitespace-nowrap">{p.hod ?? '—'}</TableCell>
                        <TableCell className="text-right tabular-nums whitespace-nowrap">
                          <span className="text-red-600">{p.remaining_qty.toLocaleString()}</span>
                          <span className="text-muted-foreground"> / {p.ordered_qty.toLocaleString()}</span>
                        </TableCell>
                        <TableCell className="text-right">
                          <Input type="number" min={0} disabled={locked}
                            title={locked ? `Locked — this booking is for ${lockedSupplierName ?? 'another supplier'}` : undefined}
                            className={cn('w-20 h-8 ml-auto', over && 'border-amber-500 focus-visible:ring-amber-500')} placeholder="0"
                            value={r.units ?? ''} onChange={(e) => setField(p.po_number, 'units', e.target.value)} />
                          {over && <div className="text-[10px] text-amber-600 mt-0.5">over by {(entered - p.remaining_qty).toLocaleString()}</div>}
                        </TableCell>
                        <TableCell className="text-right">
                          <Input type="number" min={0} disabled={locked} className="w-20 h-8 ml-auto" placeholder="—" value={r.cartons ?? ''} onChange={(e) => setField(p.po_number, 'cartons', e.target.value)} />
                        </TableCell>
                        {/* step 0.01 — the column is a decimal, unlike Units/Cartons */}
                        <TableCell className="text-right">
                          <Input type="number" min={0} step="0.01" disabled={locked} className="w-24 h-8 ml-auto" placeholder="—" value={r.weight ?? ''} onChange={(e) => setField(p.po_number, 'weight', e.target.value)} />
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </div>

          {supplierClash && (
            <div className="rounded-md border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-600">
              One booking covers ONE supplier — you have POs from {supplierIds.length}. Split them into separate bookings.
            </div>
          )}

          {warnings && (
            <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-700 space-y-1">
              <p className="font-medium">Overbooking warning</p>
              {warnings.map((w, i) => (
                <p key={i}>{w.po_number}: already booked {w.already_booked.toLocaleString()} + {w.requested.toLocaleString()} exceeds ordered {w.ordered.toLocaleString()} (over by {w.overage.toLocaleString()})</p>
              ))}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" disabled={submitting} onClick={() => { onClose(); reset(); }}>Cancel</Button>
          {warnings
            ? <Button variant="destructive" disabled={submitting} onClick={() => submit(true)}>Book anyway</Button>
            : <Button disabled={submitting || selected.length === 0 || supplierClash || !courierId || !modeId} onClick={() => submit(false)}>
                {submitting ? 'Submitting…' : `Submit booking (${selected.length} PO${selected.length === 1 ? '' : 's'})`}
              </Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
