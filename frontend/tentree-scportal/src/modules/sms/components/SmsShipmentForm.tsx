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
import { useSession } from '@/components/providers/SessionProvider';
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
  const { user } = useSession();
  const [courierId, setCourierId] = useState(() => couriers.find((c) => c.name === 'FedEx')?.id || couriers[0]?.id || '');
  const [trackingNumber, setTrackingNumber] = useState('');
  const [shipDate, setShipDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [facilityId, setFacilityId] = useState('');
  const [rows, setRows] = useState<Record<string, RowInput>>({});
  const [submitting, setSubmitting] = useState(false);
  const [warning, setWarning] = useState<null | { warnings: Array<{ po_number: string; ordered: number; already_shipped: number; requested: number }> }>(null);

  // Vendors see only their own POs (the server enforces this regardless).
  const eligible = useMemo(() => {
    const mine = user?.role === 'Vendor' && user?.supplier
      ? pos.filter((p) => (p.supplier || '').trim().toLowerCase() === String(user.supplier).trim().toLowerCase())
      : pos;
    return [...mine].sort((a, b) => (b.remaining_qty > 0 ? 1 : 0) - (a.remaining_qty > 0 ? 1 : 0) || a.po_number.localeCompare(b.po_number));
  }, [pos, user]);

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
  const changeDestination = (id: string) => { setFacilityId(id); setRows({}); setWarning(null); };

  function reset() {
    setRows({}); setWarning(null); setTrackingNumber('');
    setShipDate(new Date().toISOString().slice(0, 10)); setFacilityId('');
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
      <DialogContent className="w-[95vw] max-w-3xl" onInteractOutside={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle>New SMS Shipment</DialogTitle>
          <p className="text-sm text-muted-foreground">
            One physical consignment = one tracking number. If the box carries more than one PO,
            enter units for each — lot numbers per PO are assigned automatically.
          </p>
        </DialogHeader>

        <div className="space-y-4">
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
            <Label>POs in this shipment — enter units to include ({selected.length} selected)</Label>
            <div className="max-h-72 overflow-auto rounded-md border border-border">
              <Table className="bg-card">
                <TableHeader>
                  <TableRow className="bg-card/80 hover:bg-card/80">
                    <TableHead>PO</TableHead>
                    <TableHead>Season</TableHead>
                    <TableHead>HOD</TableHead>
                    <TableHead className="text-right">Remaining / Ordered</TableHead>
                    <TableHead className="text-right">Units</TableHead>
                    <TableHead className="text-right">Cartons</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {!facilityId && (
                    <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground py-6">Pick a destination above to list its POs.</TableCell></TableRow>
                  )}
                  {facilityId && displayed.length === 0 && (
                    <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground py-6">No open POs for this destination.</TableCell></TableRow>
                  )}
                  {displayed.map((p) => {
                    const r = rows[p.po_number] || {};
                    const entered = Number(r.units) || 0;
                    const over = entered > p.remaining_qty;
                    return (
                      <TableRow key={p.po_number} className={cn('border-border', entered > 0 && 'bg-primary/5')}>
                        <TableCell className="font-medium whitespace-nowrap">{p.po_number}</TableCell>
                        <TableCell className="text-muted-foreground whitespace-nowrap">{p.season ?? '—'}</TableCell>
                        <TableCell className="text-muted-foreground whitespace-nowrap">{p.hod ?? '—'}</TableCell>
                        <TableCell className="text-right tabular-nums whitespace-nowrap">
                          <span className={cn(p.remaining_qty <= 0 ? 'text-red-500' : 'text-emerald-600')}>{p.remaining_qty.toLocaleString()}</span>
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
