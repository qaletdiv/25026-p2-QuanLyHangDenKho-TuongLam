'use client';

// New SMS shipment (consignment) — the VENDOR self-serves this after handing the
// boxes to the courier: PO(s) with units & cartons, one tracking number + courier.
// No approval step. The server enforces vendor scope (own POs only) and the
// overship guard (409 → explicit "Ship anyway"); lot numbers are server-assigned.

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { createSmsShipment } from '@/modules/sms/actions';
import { facilityLabel } from './smsStatus';
import type { SmsPo, CourierOption } from '@/modules/sms/types';

type RowInput = { units?: string; cartons?: string };

export default function SmsShipmentForm({ open, onClose, pos, couriers }: {
  open: boolean;
  onClose: () => void;
  pos: SmsPo[];
  couriers: CourierOption[];
}) {
  const router = useRouter();
  const [courierId, setCourierId] = useState(() => couriers.find((c) => c.name === 'FedEx')?.id || couriers[0]?.id || '');
  const [trackingNumber, setTrackingNumber] = useState('');
  const [shipDate, setShipDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [facilityId, setFacilityId] = useState('');
  // View filter over the PO list only — NOT a constraint on the consignment.
  const [filterSupplierId, setFilterSupplierId] = useState('');
  const [rows, setRows] = useState<Record<string, RowInput>>({});
  const [submitting, setSubmitting] = useState(false);
  const [warning, setWarning] = useState<null | { warnings: Array<{ po_number: string; ordered: number; already_shipped: number; requested: number }> }>(null);

  // No client-side supplier filter: `/sms/pos` is ALREADY vendor-scoped at one
  // point on the server (smsPoController._ctx), so re-deriving visibility here was
  // redundant — and wrong. It compared supplier NAMES with plain trim/lowercase,
  // which fails the live vendor ("Best Star Fashions Co Ltd" vs the master-data
  // "Best Star Fashions Co., Ltd."): 0 of their POs matched, so `destinations` was
  // empty and the form was unusable. The server matches on supplierKey (punctuation
  // -insensitive) — the same trap fixed backend-side 2026-08-12. If a client-side
  // belt is ever wanted, key on supplier_id, never the name.
  const eligible = useMemo(
    () => [...pos].sort((a, b) => (b.remaining_qty > 0 ? 1 : 0) - (a.remaining_qty > 0 ? 1 : 0) || a.po_number.localeCompare(b.po_number)),
    [pos],
  );

  // Destinations that actually have eligible POs. A consignment ships to ONE
  // destination (we never mix warehouses in one box), so Destination is the
  // filter: it drives which POs are enterable, and is what's submitted.
  const destinations = useMemo(() => {
    const m = new Map<string, string>();
    eligible.forEach((p) => { if (p.facility_id && !m.has(p.facility_id)) m.set(p.facility_id, facilityLabel(p.facility) ?? p.facility_id); });
    return [...m.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [eligible]);

  // POs shown = only those going to the chosen destination.
  const displayed = useMemo(
    () => (facilityId ? eligible.filter((p) => p.facility_id === facilityId) : []),
    [eligible, facilityId],
  );

  // Suppliers present at the chosen destination. One or none → no filter rendered,
  // which is the vendor case (their POs are all one supplier).
  const supplierOptions = useMemo(() => {
    const m = new Map<string, string>();
    displayed.forEach((p) => { if (p.supplier_id && !m.has(p.supplier_id)) m.set(p.supplier_id, p.supplier ?? p.supplier_id); });
    return [...m.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [displayed]);

  // `selected` reads `displayed`, not this — narrowing the view must never silently
  // drop units already entered on a PO the filter happens to hide. That matters more
  // here than on the booking form, since a box MAY span suppliers.
  const visible = useMemo(
    () => (filterSupplierId ? displayed.filter((p) => p.supplier_id === filterSupplierId) : displayed),
    [displayed, filterSupplierId],
  );

  const setField = (po: string, field: keyof RowInput, value: string) =>
    setRows((r) => ({ ...r, [po]: { ...r[po], [field]: value } }));

  const selected = displayed
    .map((p) => {
      const r = rows[p.po_number] || {};
      const units = Number(r.units) || 0;
      return units > 0 ? { po_number: p.po_number, units, cartons: Number(r.cartons) || undefined } : null;
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  // switching destination clears any units entered for the previous one
  const changeDestination = (id: string) => { setFacilityId(id); setRows({}); setWarning(null); setFilterSupplierId(''); };

  function reset() {
    setRows({}); setWarning(null); setTrackingNumber('');
    setShipDate(new Date().toISOString().slice(0, 10)); setFacilityId(''); setFilterSupplierId('');
  }

  async function submit(force = false) {
    if (!courierId) { toast.error('Pick a courier'); return; }
    if (selected.length === 0) { toast.error('Enter units on at least one PO'); return; }
    setSubmitting(true);
    const res = await createSmsShipment({
      courier_id: courierId,
      tracking_number: trackingNumber.trim() || null,
      ship_date: shipDate || null,
      facility_id: facilityId || null,
      pos: selected,
      force_overship: force,
    });
    setSubmitting(false);
    if (res?.overship_warning) { setWarning(res); return; }
    if (res?.error) { toast.error(res.error); return; }
    toast.success(`Shipment created — ${selected.length} PO${selected.length === 1 ? '' : 's'}, lot number${selected.length === 1 ? '' : 's'} assigned automatically`);
    onClose(); reset(); router.refresh();
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) { onClose(); reset(); } }} modal={false}>
      {/* 5xl to match SmsBookingForm: the PO table gained a Supplier column (7 now),
          which does not fit 3xl without permanent horizontal scroll. */}
      <DialogContent className="w-[95vw] max-w-5xl" onInteractOutside={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle>New SMS Shipment</DialogTitle>
          <p className="text-sm text-muted-foreground">
            One physical consignment = one tracking number. If the box carries more than one PO,
            enter units for each — lot numbers per PO are assigned automatically.
          </p>
        </DialogHeader>

        {/* min-w-0: DialogContent is a CSS grid, so this child otherwise defaults to
            min-width:auto and refuses to shrink below the PO table's min-content
            width — overriding the table's own overflow-x-auto and pushing the form
            past the dialog edge on narrow screens. Same fix as SmsBookingForm. */}
        <div className="space-y-4 min-w-0">
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4">
            <div className="space-y-1.5">
              <Label>Courier</Label>
              <Select value={courierId} onValueChange={(v) => v && setCourierId(v)}>
                {/* label rendered directly — SelectValue shows the raw id (c1) when the value is set programmatically */}
                <SelectTrigger className="w-full">
                  <span className={cn(!courierId && 'text-muted-foreground')}>{couriers.find((c) => c.id === courierId)?.name || 'Courier'}</span>
                </SelectTrigger>
                <SelectContent>{couriers.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Tracking Number</Label>
              <Input value={trackingNumber} onChange={(e) => setTrackingNumber(e.target.value)} placeholder="e.g. 449044304137821" />
            </div>
            <div className="space-y-1.5">
              <Label>Ship Date</Label>
              <Input type="date" value={shipDate} onChange={(e) => setShipDate(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>Destination</Label>
              <Select value={facilityId} onValueChange={(v) => v && changeDestination(v)}>
                <SelectTrigger className="w-full">
                  <span className={cn(!facilityId && 'text-muted-foreground')}>{destinations.find((d) => d.id === facilityId)?.name || 'Select destination'}</span>
                </SelectTrigger>
                <SelectContent>{destinations.map((d) => <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <div className="flex flex-wrap items-end justify-between gap-2">
              <Label>POs in this shipment — enter units to include ({selected.length} selected)</Label>
              {/* Find-aid only. Unlike the BOOKING form there is NO supplier lock here:
                  a courier box may legitimately carry POs from more than one supplier
                  (there is no same-supplier guard server-side either), so restricting
                  it would contradict the multi-PO consignment design. Hidden when the
                  destination holds one supplier, which is always the vendor case. */}
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
            <div className="max-h-72 overflow-auto rounded-md border border-border">
              <Table className="bg-card">
                <TableHeader>
                  <TableRow className="bg-card/80 hover:bg-card/80">
                    <TableHead>PO</TableHead>
                    <TableHead>Supplier</TableHead>
                    <TableHead>Season</TableHead>
                    <TableHead>HOD</TableHead>
                    <TableHead className="text-right">Remaining / Ordered</TableHead>
                    <TableHead className="text-right">Units</TableHead>
                    <TableHead className="text-right">Cartons</TableHead>
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
                    return (
                      <TableRow key={p.po_number} className={cn('border-border', entered > 0 && 'bg-primary/5')}>
                        <TableCell className="font-medium whitespace-nowrap">{p.po_number}</TableCell>
                        <TableCell className="text-muted-foreground whitespace-nowrap">{p.supplier ?? '—'}</TableCell>
                        <TableCell className="text-muted-foreground whitespace-nowrap">{p.season ?? '—'}</TableCell>
                        <TableCell className="text-muted-foreground whitespace-nowrap">{p.hod ?? '—'}</TableCell>
                        <TableCell className="text-right tabular-nums whitespace-nowrap">
                          <span className="text-red-600">{p.remaining_qty.toLocaleString()}</span>
                          <span className="text-muted-foreground"> / {p.ordered_qty.toLocaleString()}</span>
                        </TableCell>
                        <TableCell className="text-right">
                          <Input type="number" min={0} className={cn('w-20 h-8 ml-auto', over && 'border-amber-500 focus-visible:ring-amber-500')} placeholder="0"
                            value={r.units ?? ''} onChange={(e) => setField(p.po_number, 'units', e.target.value)} />
                          {over && <div className="text-[10px] text-amber-600 mt-0.5">over by {(entered - p.remaining_qty).toLocaleString()}</div>}
                        </TableCell>
                        <TableCell className="text-right">
                          <Input type="number" min={0} className="w-20 h-8 ml-auto" placeholder="—" value={r.cartons ?? ''} onChange={(e) => setField(p.po_number, 'cartons', e.target.value)} />
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </div>

          {warning && (
            <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-700 space-y-1">
              <p className="font-medium">Overshipment warning</p>
              {warning.warnings.map((w, i) => (
                <p key={i}>{w.po_number}: already shipped {w.already_shipped.toLocaleString()} + {w.requested.toLocaleString()} exceeds ordered {w.ordered.toLocaleString()}</p>
              ))}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" disabled={submitting} onClick={() => { onClose(); reset(); }}>Cancel</Button>
          {warning
            ? <Button variant="destructive" disabled={submitting} onClick={() => submit(true)}>Ship anyway</Button>
            : <Button disabled={submitting || selected.length === 0} onClick={() => submit(false)}>{submitting ? 'Creating…' : `Create shipment (${selected.length} PO${selected.length === 1 ? '' : 's'})`}</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
