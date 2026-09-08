'use client';

// SMS booking detail — the authorization record. Logistics approves (creating the
// draft consignment), rejects, or cancels; the vendor sees it read-only once
// submitted. The PO-lot table shows BOOKED vs SHIPPED so the variance is visible
// without storing it.

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ArrowLeft, Check, X, Ban, Trash2, Pencil, Save } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useSession } from '@/components/providers/SessionProvider';
import ConfirmDialog from '@/modules/mainline/components/ConfirmDialog';
import { approveSmsBooking, rejectSmsBooking, cancelSmsBooking, deleteSmsBooking, updateSmsBooking } from '@/modules/sms/actions';
import { SMS_BOOKING_STATUS_STYLES } from './SmsBookingsTable';
import { facilityLabel } from './smsStatus';
import type { SmsBooking, IncotermOption, CourierOption, ModeOption } from '@/modules/sms/types';

const DASH = '—';

function Meta({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="space-y-0.5">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-sm">{value || DASH}</div>
    </div>
  );
}

export default function SmsBookingDetail({ booking, incoterms = [], couriers = [], modes = [] }: {
  booking: SmsBooking;
  incoterms?: IncotermOption[];
  couriers?: CourierOption[];
  modes?: ModeOption[];
}) {
  const router = useRouter();
  const { user } = useSession();
  const isVendor = user?.role === 'Vendor';
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<null | 'approve' | 'reject' | 'cancel' | 'delete'>(null);

  const status = booking.booking_status || '';
  const isPending = status === 'Booking Pending';
  const isApproved = status === 'Booking Approved';

  // ── Editing. The server allows PATCH only while the booking is PENDING (once
  // approved it has already created the draft consignments, so the way out is
  // Cancel) — the UI mirrors that rather than letting the user hit a 400. Editable:
  // cargo-ready date, incoterm, and each lot's units/cartons/weight. The vendor may
  // edit their OWN pending booking, so this is not staff-only.
  const [edit, setEdit] = useState(false);
  const [form, setForm] = useState({
    cargo_ready_date: booking.cargo_ready_date ?? '',
    incoterm_id: booking.incoterm_id ?? '',
    courier_id: booking.courier_id ?? '',
    mode_id: booking.mode_id ?? '',
    pos: booking.pos.map((p) => ({
      po_number: p.po_number,
      lot_number: p.lot_number,
      units: String(p.units ?? ''),
      cartons: p.cartons != null ? String(p.cartons) : '',
      weight: p.weight_kg != null ? String(p.weight_kg) : '',
    })),
  });

  function resetForm() {
    setForm({
      cargo_ready_date: booking.cargo_ready_date ?? '',
      incoterm_id: booking.incoterm_id ?? '',
      courier_id: booking.courier_id ?? '',
      mode_id: booking.mode_id ?? '',
      pos: booking.pos.map((p) => ({
        po_number: p.po_number,
        lot_number: p.lot_number,
        units: String(p.units ?? ''),
        cartons: p.cartons != null ? String(p.cartons) : '',
        weight: p.weight_kg != null ? String(p.weight_kg) : '',
      })),
    });
  }

  // Save, optionally re-sent with force_overbook after the user accepts the warning
  // (the server returns 409 + overbook_warning when a lot exceeds what's left).
  async function save(force = false) {
    const payload: Record<string, unknown> = {
      cargo_ready_date: form.cargo_ready_date || null,
      incoterm_id: form.incoterm_id || null,
      // omitted when blank — the server rejects an empty carrier/mode, and a
      // legacy booking (created before these existed) can only gain them here
      ...(form.courier_id ? { courier_id: form.courier_id } : {}),
      ...(form.mode_id ? { mode_id: form.mode_id } : {}),
      // The server replaces this booking's junction WHOLESALE, so every editable
      // column has to be re-sent — an omitted weight_kg comes back as null, i.e.
      // saving an unrelated date change would silently wipe the entered weight.
      pos: form.pos.map((p) => ({
        po_number: p.po_number,
        lot_number: p.lot_number,
        units: Number(p.units),
        cartons: p.cartons === '' ? null : Number(p.cartons),
        weight_kg: p.weight === '' ? null : Number(p.weight),
      })),
    };
    if (force) payload.force_overbook = true;
    setBusy(true);
    const res = await updateSmsBooking(booking.id, payload);
    setBusy(false);
    if (res?.overbook_warning) {
      const lines = (res.warnings ?? []).map((w: { po_number: string; ordered: number; already_booked: number; requested: number }) =>
        `${w.po_number}: ${w.requested} requested, ${w.already_booked} already booked of ${w.ordered} ordered`).join('\n');
      if (window.confirm(`This exceeds what is left to book:\n\n${lines}\n\nSave anyway?`)) return save(true);
      return;
    }
    if (res?.error) return void toast.error(res.error);
    setEdit(false);
    toast.success('Booking updated');
    router.refresh();
  }

  async function run(kind: 'approve' | 'reject' | 'cancel' | 'delete') {
    setBusy(true);
    const res = kind === 'approve' ? await approveSmsBooking(booking.id)
      : kind === 'reject' ? await rejectSmsBooking(booking.id)
      : kind === 'cancel' ? await cancelSmsBooking(booking.id)
      : await deleteSmsBooking(booking.id);
    setBusy(false);
    setConfirm(null);
    if (res?.error) return void toast.error(res.error);
    if (kind === 'approve') {
      const n = res?.created_shipments?.length ?? 0;
      toast.success(`Approved — ${n} draft consignment${n === 1 ? '' : 's'} created. Add the tracking number when the box ships.`);
    } else if (kind === 'cancel') {
      const n = res?.deleted_draft_shipments?.length ?? 0;
      toast.success(`Cancelled${n ? ` — ${n} draft consignment${n === 1 ? '' : 's'} removed` : ''}`);
    } else if (kind === 'delete') {
      toast.success('Booking deleted');
      router.push('/sms/bookings');
      return;
    } else {
      toast.success('Booking rejected — its lots are free to re-book');
    }
    router.refresh();
  }

  const totalShipped = booking.pos.reduce((a, p) => a + (p.shipped_units ?? 0), 0);

  return (
    <div className="p-4 md:p-6 space-y-6">
      <ConfirmDialog
        open={confirm === 'approve'}
        title={`Approve ${booking.booking_number}?`}
        description="This creates the consignment as a draft (no tracking number yet) and authorizes the booked lots. The tracking number is added when the box actually ships."
        confirmLabel="Approve"
        onCancel={() => setConfirm(null)}
        onConfirm={() => run('approve')}
      />
      <ConfirmDialog
        open={confirm === 'reject'}
        title={`Reject ${booking.booking_number}?`}
        description="The booked lots become free to re-book. Nothing is deleted."
        confirmLabel="Reject"
        onCancel={() => setConfirm(null)}
        onConfirm={() => run('reject')}
      />
      <ConfirmDialog
        open={confirm === 'cancel'}
        title={`Cancel ${booking.booking_number}?`}
        description="Any draft consignment created by approval is deleted. If a box has already shipped under this booking, the cancel is refused."
        confirmLabel="Cancel booking"
        onCancel={() => setConfirm(null)}
        onConfirm={() => run('cancel')}
      />
      <ConfirmDialog
        open={confirm === 'delete'}
        title={`Delete ${booking.booking_number}?`}
        description="This removes the booking record entirely. Only possible while it is Pending, Rejected or Cancelled."
        confirmLabel="Delete"
        onCancel={() => setConfirm(null)}
        onConfirm={() => run('delete')}
      />

      <div>
        <Link href="/sms/bookings" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground mb-3">
          <ArrowLeft className="w-4 h-4" /> SMS Bookings
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{booking.booking_number}</h1>
          <Badge variant="outline" className={cn(SMS_BOOKING_STATUS_STYLES[status])}>{status || DASH}</Badge>
          <div className="ml-auto flex flex-wrap gap-2">
            {/* Edit is available to the VENDOR too (it is their booking) — the server
                allows PATCH on a Pending booking regardless of role. */}
            {isPending && !edit && (
              <Button size="sm" variant="outline" disabled={busy} onClick={() => { resetForm(); setEdit(true); }}>
                <Pencil className="h-4 w-4 mr-1" /> Edit
              </Button>
            )}
            {isPending && edit && (
              <>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setEdit(false); resetForm(); }}>
                  <X className="h-4 w-4 mr-1" /> Cancel
                </Button>
                <Button size="sm" disabled={busy} onClick={() => save()}>
                  <Save className="h-4 w-4 mr-1" /> Save
                </Button>
              </>
            )}
            {!isVendor && !edit && (
              <>
                {isPending && (
                  <>
                    <Button size="sm" disabled={busy} onClick={() => setConfirm('approve')}>
                      <Check className="h-4 w-4 mr-1" /> Approve
                    </Button>
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => setConfirm('reject')}>
                      <X className="h-4 w-4 mr-1" /> Reject
                    </Button>
                  </>
                )}
                {isApproved && (
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => setConfirm('cancel')}>
                    <Ban className="h-4 w-4 mr-1" /> Cancel booking
                  </Button>
                )}
                {!isApproved && (
                  <Button size="sm" variant="ghost" disabled={busy} title="Delete booking" onClick={() => setConfirm('delete')}>
                    <Trash2 className="h-4 w-4 text-red-500" />
                  </Button>
                )}
              </>
            )}
          </div>
        </div>
        <p className="text-sm text-muted-foreground mt-1">
          {booking.supplier_name ?? DASH} · {booking.total_units.toLocaleString()} units authorized
          {totalShipped ? ` · ${totalShipped.toLocaleString()} shipped` : ''}
        </p>
        {/* Why there is no Edit button once approved — approval already created the
            draft consignments, so changing the authorization means cancelling it. */}
        {isApproved && (
          <p className="text-xs text-muted-foreground/80 mt-1">
            Approved bookings are locked — approval already created the draft consignment(s) below. To change what was
            authorized, <strong>Cancel booking</strong> (allowed until a box has shipped) and submit a new one. Tracking
            number, ship date and freight/duty are edited on the consignment itself.
          </p>
        )}
      </div>

      {/* Bookings made before carrier/mode existed were approved into a FedEx/COURIER
          draft. Approve now refuses rather than guessing, so say so up front. */}
      {isPending && (!booking.courier_id || !booking.mode_id) && (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-700">
          This booking has no {[!booking.courier_id && 'carrier', !booking.mode_id && 'mode'].filter(Boolean).join(' or ')} set,
          so it cannot be approved. <strong>Edit</strong> it and pick {!booking.mode_id ? 'them — the mode becomes the shipping method on the NetSuite item receipt.' : 'one.'}
        </div>
      )}

      <Card className="p-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4">
          <Meta label="Supplier" value={booking.supplier_name} />
          {edit ? (
            <div className="space-y-0.5">
              <div className="text-xs text-muted-foreground">Cargo Ready Date</div>
              <Input type="date" className="h-8 text-sm" value={form.cargo_ready_date}
                onChange={(e) => setForm((f) => ({ ...f, cargo_ready_date: e.target.value }))} />
            </div>
          ) : <Meta label="Cargo Ready Date" value={booking.cargo_ready_date} />}
          <Meta label="Destination" value={facilityLabel(booking.destination)} />
          {/* Carrier + Mode. Approval copies both onto the draft consignment; the
              MODE is what the landed-cost push sends to NetSuite as the shipping
              method, so getting it right here is what keeps custbody16 honest. */}
          {edit ? (
            <div className="space-y-0.5">
              <div className="text-xs text-muted-foreground">Carrier</div>
              <Select value={form.courier_id} onValueChange={(v) => v && setForm((f) => ({ ...f, courier_id: v }))}>
                <SelectTrigger className="h-8 w-full text-sm">
                  <span className={cn(!form.courier_id && 'text-muted-foreground')}>
                    {couriers.find((c) => c.id === form.courier_id)?.name || 'Select carrier'}
                  </span>
                </SelectTrigger>
                <SelectContent>{couriers.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          ) : <Meta label="Carrier" value={booking.courier} />}
          {edit ? (
            <div className="space-y-0.5">
              <div className="text-xs text-muted-foreground">Mode</div>
              <Select value={form.mode_id} onValueChange={(v) => v && setForm((f) => ({ ...f, mode_id: v }))}>
                <SelectTrigger className="h-8 w-full text-sm">
                  <span className={cn(!form.mode_id && 'text-muted-foreground')}>
                    {modes.find((m) => m.id === form.mode_id)?.name || 'Select mode'}
                  </span>
                </SelectTrigger>
                <SelectContent>{modes.map((m) => <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          ) : <Meta label="Mode" value={booking.mode} />}
          {edit ? (
            <div className="space-y-0.5">
              <div className="text-xs text-muted-foreground">Incoterm</div>
              {/* label rendered in the trigger — SelectValue can't derive it for a
                  programmatic/async value (see CLAUDE.md) */}
              <Select value={form.incoterm_id} onValueChange={(v) => setForm((f) => ({ ...f, incoterm_id: v ?? '' }))}>
                <SelectTrigger className="h-8 w-full text-sm">
                  <span className={cn(!form.incoterm_id && 'text-muted-foreground')}>
                    {incoterms.find((i) => i.id === form.incoterm_id)?.name || 'None'}
                  </span>
                </SelectTrigger>
                <SelectContent>
                  {incoterms.map((i) => <SelectItem key={i.id} value={i.id}>{i.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          ) : <Meta label="Incoterm" value={booking.incoterm} />}
          <Meta label="Season" value={booking.season} />
          <Meta label="Submitted" value={booking.submitted_at?.slice(0, 10)} />
          <Meta label="Approved" value={booking.approved_at?.slice(0, 10)} />
          <Meta label="Cartons" value={booking.total_cartons ? String(booking.total_cartons) : null} />
          {/* Σ over the lots, derived server-side — never stored on the header */}
          <Meta label="Weight (kg)" value={booking.total_weight_kg ? booking.total_weight_kg.toLocaleString() : null} />
        </div>
      </Card>

      {/* ── booked PO-lots, with the shipped figure alongside (variance derived) ── */}
      <section className="space-y-2">
        <h2 className="text-sm font-medium text-muted-foreground">
          Authorized lots — {booking.pos.length} PO{booking.pos.length === 1 ? '' : 's'}
        </h2>
        <Card className="overflow-x-auto">
          <Table className="bg-card">
            <TableHeader>
              <TableRow className="bg-card/80 hover:bg-card/80">
                <TableHead>PO</TableHead>
                <TableHead>Supplier</TableHead>
                <TableHead>Lot</TableHead>
                <TableHead className="text-right">Booked</TableHead>
                <TableHead className="text-right">Shipped</TableHead>
                <TableHead className="text-right">Cartons</TableHead>
                <TableHead className="text-right">Weight (kg)</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {booking.pos.map((p) => {
                const shipped = p.shipped_units;
                const variance = shipped == null ? null : shipped - p.units;
                return (
                  <TableRow key={p.id} className="border-border hover:bg-muted/30">
                    <TableCell>
                      <Link href={`/sms/purchase-orders/${encodeURIComponent(p.po_number)}`} className="text-primary hover:underline font-medium">{p.po_number}</Link>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{p.supplier ?? DASH}</TableCell>
                    <TableCell className="text-muted-foreground">Lot {p.lot_number}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {edit ? (
                        <Input type="number" min="1" className="h-8 w-24 ml-auto text-right"
                          value={form.pos.find((x) => x.po_number === p.po_number && x.lot_number === p.lot_number)?.units ?? ''}
                          onChange={(e) => setForm((f) => ({
                            ...f,
                            pos: f.pos.map((x) => (x.po_number === p.po_number && x.lot_number === p.lot_number
                              ? { ...x, units: e.target.value } : x)),
                          }))} />
                      ) : p.units.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {shipped == null ? <span className="text-muted-foreground">not shipped</span> : (
                        <>
                          {shipped.toLocaleString()}
                          {!!variance && (
                            <span className={cn('ml-1.5 text-[11px]', variance > 0 ? 'text-amber-600' : 'text-muted-foreground')}>
                              ({variance > 0 ? '+' : ''}{variance.toLocaleString()})
                            </span>
                          )}
                        </>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {edit ? (
                        <Input type="number" min="0" className="h-8 w-20 ml-auto text-right" placeholder="—"
                          value={form.pos.find((x) => x.po_number === p.po_number && x.lot_number === p.lot_number)?.cartons ?? ''}
                          onChange={(e) => setForm((f) => ({
                            ...f,
                            pos: f.pos.map((x) => (x.po_number === p.po_number && x.lot_number === p.lot_number
                              ? { ...x, cartons: e.target.value } : x)),
                          }))} />
                      ) : (p.cartons ?? DASH)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {edit ? (
                        <Input type="number" min="0" step="0.01" className="h-8 w-24 ml-auto text-right" placeholder="—"
                          value={form.pos.find((x) => x.po_number === p.po_number && x.lot_number === p.lot_number)?.weight ?? ''}
                          onChange={(e) => setForm((f) => ({
                            ...f,
                            pos: f.pos.map((x) => (x.po_number === p.po_number && x.lot_number === p.lot_number
                              ? { ...x, weight: e.target.value } : x)),
                          }))} />
                      ) : (p.weight_kg ?? DASH)}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Card>
      </section>

      {/* ── consignments this booking produced ── */}
      <section className="space-y-2">
        <h2 className="text-sm font-medium text-muted-foreground">Consignments</h2>
        <Card className="overflow-x-auto">
          {booking.shipments.length === 0 ? (
            <p className="text-sm text-muted-foreground py-8 text-center">
              {isPending ? 'None yet — approving this booking creates the draft consignment.' : 'No consignments.'}
            </p>
          ) : (
            <Table className="bg-card">
              <TableHeader>
                <TableRow className="bg-card/80 hover:bg-card/80">
                  <TableHead>Tracking #</TableHead>
                  <TableHead>Ship Date</TableHead>
                  <TableHead>State</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {booking.shipments.map((s) => (
                  <TableRow key={s.id} className="border-border hover:bg-muted/30">
                    <TableCell>
                      <Link href={`/sms/shipments/${s.id}`} className="text-primary hover:underline font-mono text-xs">
                        {s.tracking_number || `Shipment ${s.id}`}
                      </Link>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{s.ship_date ?? DASH}</TableCell>
                    <TableCell>
                      {s.is_draft
                        ? <Badge variant="outline" className="bg-amber-500/10 border-amber-500/30 text-amber-700">Draft — awaiting tracking #</Badge>
                        : <Badge variant="outline" className="bg-blue-500/10 border-blue-500/30 text-blue-600">Shipped</Badge>}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Card>
      </section>
    </div>
  );
}
