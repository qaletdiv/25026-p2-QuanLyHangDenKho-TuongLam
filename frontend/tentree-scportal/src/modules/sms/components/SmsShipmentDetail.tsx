'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { ArrowLeft, Trash2, Upload, FileText, Download, Pencil, Save, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { docHref } from '@/lib/api';
// Generic UI primitive shared across modules (no mainline data coupling)
import ConfirmDialog from '@/modules/mainline/components/ConfirmDialog';
import { updateSmsShipment, deleteSmsShipment, uploadSmsShippingData } from '@/modules/sms/actions';
import { SMS_MANUAL_STATUSES, SMS_SOURCE_LABELS, SMS_STATUS_STYLES, facilityLabel } from './smsStatus';
import type { SmsShipment, SmsDocument, CourierOption, ModeOption } from '@/modules/sms/types';

const DASH = '—';

// "Combined" first, then per-PO alphabetical
const scopeOrder = (docs: SmsDocument[]) =>
  [...new Set(docs.map((d) => d.scope))].sort((a, b) => (a.startsWith('Combined') ? -1 : b.startsWith('Combined') ? 1 : a.localeCompare(b)));

// Deterministic scan-time format — parsed straight from the ISO components so
// server and client render identically (no locale/timezone drift → no hydration
// mismatch). Shows the scan's LOCAL time as FedEx reports it (its offset varies
// by scan location), which is what couriers display.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmtScanTime(iso: string | null): string {
  if (!iso) return DASH;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso);
  if (!m) return iso;
  const [, y, mo, d, h, min] = m;
  let hr = Number(h);
  const ampm = hr >= 12 ? 'PM' : 'AM';
  hr = hr % 12 || 12;
  return `${MONTHS[Number(mo) - 1]} ${Number(d)}, ${y} · ${hr}:${min} ${ampm}`;
}

function Meta({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="space-y-0.5">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-sm font-medium">{value ?? DASH}</div>
    </div>
  );
}

const money = (n: number | null) =>
  n == null ? DASH : `$${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function SmsShipmentDetail({ shipment, documents = [], couriers = [], modes = [] }: {
  shipment: SmsShipment;
  documents?: SmsDocument[];
  couriers?: CourierOption[];
  modes?: ModeOption[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [tracking, setTracking] = useState(shipment.tracking_number ?? '');
  const trackingDirty = tracking.trim() !== (shipment.tracking_number ?? '');
  // Ship date is editable for the same reason the tracking number is: a booking
  // approval creates the consignment as a DRAFT with both fields empty (neither is
  // known until the box actually goes), and it is the field the Landed Costs
  // month-end view groups on — with it null a booked consignment sits in
  // "Unscheduled" no matter what the booking's cargo-ready date says.
  const [shipDate, setShipDate] = useState(shipment.ship_date ?? '');
  const shipDateDirty = shipDate !== (shipment.ship_date ?? '');
  const fileRef = useRef<HTMLInputElement>(null);

  // Booked consignments carry ACTUAL freight/duty off the broker bill + the customs
  // entry number — the same three fields a mainline shipment carries, edited the
  // same way. An unbooked (vendor-entered) consignment has none of this: its landed
  // cost is the derived CI × rate estimate shown on the Landed Costs page.
  const [editFin, setEditFin] = useState(false);
  const [fin, setFin] = useState({
    customs_entry_number: shipment.customs_entry_number ?? '',
    freight: shipment.freight != null ? String(shipment.freight) : '',
    duty: shipment.duty != null ? String(shipment.duty) : '',
  });

  async function saveFinancials() {
    setBusy(true);
    const res = await updateSmsShipment(shipment.id, {
      customs_entry_number: fin.customs_entry_number.trim() || null,
      freight: fin.freight === '' ? null : Number(fin.freight),
      duty: fin.duty === '' ? null : Number(fin.duty),
    });
    setBusy(false);
    if (res?.error) { toast.error(res.error); return; }
    setEditFin(false);
    toast.success('Freight, duty and entry number saved — the Landed Costs page now splits these per PO');
    router.refresh();
  }

  async function onUpload(file: File) {
    setBusy(true);
    const res = await uploadSmsShippingData(shipment.id, file);
    setBusy(false);
    if (res?.error) { toast.error(res.error); return; }
    toast.success(`Shipping data imported — ${res.lines} line item${res.lines === 1 ? '' : 's'} across ${res.cartons} carton${res.cartons === 1 ? '' : 's'} · ${res.documents} document(s) generated`);
    router.refresh();
  }

  async function saveTracking() {
    setBusy(true);
    const res = await updateSmsShipment(shipment.id, { tracking_number: tracking.trim() || null });
    setBusy(false);
    if (res?.error) { toast.error(res.error); return; }
    toast.success('Tracking number updated');
    router.refresh();
  }

  async function saveShipDate() {
    setBusy(true);
    const res = await updateSmsShipment(shipment.id, { ship_date: shipDate || null });
    setBusy(false);
    if (res?.error) { toast.error(res.error); return; }
    toast.success(shipDate
      ? `Ship date set to ${shipDate} — the Landed Costs month-end view now groups this consignment under ${shipDate.slice(0, 7)}`
      : 'Ship date cleared');
    router.refresh();
  }

  async function saveCarrier(courier_id: string) {
    if (courier_id === shipment.courier_id) return;
    setBusy(true);
    const res = await updateSmsShipment(shipment.id, { courier_id });
    setBusy(false);
    if (res?.error) { toast.error(res.error); return; }
    toast.success(`Carrier → ${couriers.find((c) => c.id === courier_id)?.name ?? courier_id}`);
    router.refresh();
  }

  // The mode is what the landed-cost push sends as the NetSuite shipping method
  // (custbody16). Changing it affects the NEXT post — an already-posted row keeps
  // its snapshot, so say that rather than implying NetSuite updates itself.
  async function saveMode(mode_id: string) {
    if (mode_id === shipment.mode_id) return;
    setBusy(true);
    const res = await updateSmsShipment(shipment.id, { mode_id });
    setBusy(false);
    if (res?.error) { toast.error(res.error); return; }
    const name = modes.find((m) => m.id === mode_id)?.name ?? mode_id;
    toast.success(`Mode → ${name} — the landed cost will post to NetSuite as ${name}`);
    router.refresh();
  }

  async function setManualStatus(name: string) {
    setBusy(true);
    const res = await updateSmsShipment(shipment.id, { manual_status: name });
    setBusy(false);
    if (res?.error) { toast.error(res.error); return; }
    toast.success(`Status → ${name}`);
    router.refresh();
  }

  async function remove() {
    setBusy(true);
    const res = await deleteSmsShipment(shipment.id);
    setBusy(false);
    if (res?.error) { toast.error(res.error); setConfirmDelete(false); return; }
    toast.success('Shipment deleted');
    router.push('/sms/shipments');
  }

  // The manual status is only a FALLBACK: a courier scan wins over it, and a
  // NetSuite Item Receipt (status "Received") wins over the courier's Delivered.
  const derived = shipment.status_source !== 'manual';
  const receivedInNs = shipment.status_source === 'netsuite';

  return (
    <div className="p-4 md:p-6 space-y-6 max-w-4xl mx-auto">
      <ConfirmDialog
        open={confirmDelete}
        title={`Delete shipment ${shipment.tracking_number || shipment.id}?`}
        description="The shipment, its PO lots and tracking history will be removed. This cannot be undone."
        confirmLabel="Delete"
        destructive
        busy={busy}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={remove}
      />

      <div>
        <Link href="/sms/shipments" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground mb-3">
          <ArrowLeft className="w-4 h-4" /> SMS Shipments
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight font-mono">{shipment.tracking_number || `Shipment ${shipment.id}`}</h1>
          <Badge variant="outline" className={cn(SMS_STATUS_STYLES[shipment.status || ''])}>{shipment.status ?? DASH}</Badge>
          {shipment.is_draft && (
            <Badge variant="outline" className="bg-amber-500/10 border-amber-500/30 text-amber-700">Draft — add the tracking number</Badge>
          )}
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground/70">
            {SMS_SOURCE_LABELS[shipment.status_source] ?? 'manual'}
          </span>
          <Button size="sm" variant="outline" className="ml-auto" disabled={busy} onClick={() => fileRef.current?.click()}>
            <Upload className="h-4 w-4 mr-1.5" /> {shipment.has_shipping_data ? 'Re-upload Shipping Data' : 'Upload Shipping Data'}
          </Button>
          <input ref={fileRef} type="file" accept=".xlsx,.xls" className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) onUpload(f); e.target.value = ''; }} />
          <Button size="sm" variant="ghost" disabled={busy} title="Delete shipment" onClick={() => setConfirmDelete(true)}>
            <Trash2 className="h-4 w-4 text-red-500" />
          </Button>
        </div>
        <p className="text-sm text-muted-foreground mt-1">{shipment.courier ?? DASH} · shipped {shipment.ship_date ?? DASH}</p>
      </div>

      {/* An Item Receipt was matched to this lot but nobody has confirmed the link, so
          the status deliberately stays Delivered — Received is a done state and is not
          asserted off a suggestion. Says so explicitly, with the one-click fix. */}
      {shipment.received_irs.length > 0 && !shipment.received_confirmed && (
        <Card className="p-3 border-amber-500/30 bg-amber-500/5">
          <p className="text-xs text-amber-600">
            {'Item Receipt '}
            <strong>{shipment.received_irs.join(', ')}</strong>
            {' looks like it received this lot, but the match is a suggestion nobody has confirmed — so the status stays Delivered rather than Received. Confirm the match on the '}
            <Link href="/landed-costs/sms" className="underline">Landed Costs</Link>
            {' page and it becomes Received (that confirmation is also required before the landed cost can be posted).'}
          </p>
        </Card>
      )}

      <Card className="p-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4">
          {/* Tracking number is editable — vendors often add it after shipping,
              and it's the key the FedEx poll matches on. */}
          <div className="space-y-0.5 sm:col-span-2">
            <div className="text-xs text-muted-foreground">Tracking Number</div>
            <div className="flex items-center gap-2">
              <Input value={tracking} onChange={(e) => setTracking(e.target.value)} placeholder="Add a tracking number" className="h-8 font-mono text-sm" />
              {trackingDirty && <Button size="sm" disabled={busy} onClick={saveTracking}>Save</Button>}
            </div>
          </div>
          {/* Carrier and Mode are EDITABLE (2026-08-24). They were display-only, and
              because booking-approve stamped every draft FedEx, a Ceva sea consignment
              had no way to be corrected — and its landed cost posted to NetSuite as
              COURIER. Mode drives custbody16 on the next post; Courier is the fallback
              when it is unset (a plain vendor-entered parcel). */}
          <div className="space-y-0.5">
            <div className="text-xs text-muted-foreground">Carrier</div>
            <Select value={shipment.courier_id ?? ''} onValueChange={(v) => v && saveCarrier(v)} disabled={busy}>
              <SelectTrigger className="h-8 w-full">
                <span className={cn(!shipment.courier_id && 'text-muted-foreground')}>{shipment.courier || 'Select carrier'}</span>
              </SelectTrigger>
              <SelectContent>{couriers.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="space-y-0.5">
            <div className="text-xs text-muted-foreground">
              Mode {!shipment.mode_id && <span className="text-muted-foreground/60">(unset — posts as Courier)</span>}
            </div>
            <Select value={shipment.mode_id ?? ''} onValueChange={(v) => v && saveMode(v)} disabled={busy}>
              <SelectTrigger className="h-8 w-full">
                <span className={cn(!shipment.mode_id && 'text-muted-foreground')}>{shipment.mode || 'Courier (default)'}</span>
              </SelectTrigger>
              <SelectContent>{modes.map((m) => <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <Meta label="Supplier" value={shipment.supplier} />
          {/* Editable: a booking-approved draft starts with no ship date, and this is
              what the Landed Costs month-end view groups on. */}
          <div className="space-y-0.5">
            <div className="text-xs text-muted-foreground">Ship Date</div>
            <div className="flex items-center gap-2">
              <Input type="date" value={shipDate} onChange={(e) => setShipDate(e.target.value)} className="h-8 text-sm" />
              {shipDateDirty && <Button size="sm" disabled={busy} onClick={saveShipDate}>Save</Button>}
            </div>
          </div>
          <Meta label="Destination" value={facilityLabel(shipment.facility)} />
          {/* Receiving in NetSuite — the Item Receipt(s) attributed to this lot.
              This is what promotes the status from Delivered to Received; correct a
              wrong match on the Landed Costs page and the status follows. */}
          {shipment.received_irs.length > 0 && (
            <Meta
              // An UNCONFIRMED attribution is only a suggestion — it no longer moves
              // the status to Received, so label it as what it is rather than implying
              // the goods are booked in.
              label={shipment.received_confirmed ? 'Received in NetSuite' : 'Item Receipt found'}
              value={
                <span>
                  {shipment.received_date ?? DASH}
                  <span className="ml-1.5 font-normal text-xs text-muted-foreground">
                    {shipment.received_irs.join(', ')}
                    {!shipment.received_confirmed && ' · not confirmed'}
                  </span>
                </span>
              }
            />
          )}
          {/* Booking is OPTIONAL — most SMS consignments are entered directly. */}
          <Meta label="Booking" value={shipment.booking_id
            ? <Link href={`/sms/bookings/${shipment.booking_id}`} className="text-primary hover:underline">{shipment.booking_number ?? 'view booking'}</Link>
            : <span className="text-muted-foreground font-normal">None — entered directly</span>} />
          <div className="space-y-0.5">
            <div className="text-xs text-muted-foreground">
              Manual Status {derived && <span className="text-muted-foreground/60">(fallback — {receivedInNs ? 'the NetSuite receipt' : 'courier tracking'} wins)</span>}
            </div>
            <Select value={!derived ? (shipment.status ?? '') : ''} onValueChange={(v) => v && setManualStatus(v)} disabled={busy}>
              <SelectTrigger className="h-8 w-full sm:w-44">
                <SelectValue placeholder={receivedInNs ? 'Received in NetSuite' : derived ? 'Courier-controlled' : 'Set status'} />
              </SelectTrigger>
              <SelectContent>{SMS_MANUAL_STATUSES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent>
            </Select>
          </div>
        </div>
      </Card>

      {/* ── Landed Cost — ACTUAL freight & duty off the bill, plus the clearance
             number. Booked consignments only: same three fields, same inline
             Edit/Save as the mainline shipment detail. An unbooked consignment has
             no formal entry — its landed cost is the derived CI × rate estimate. ── */}
      <section className="space-y-2">
        <h2 className="text-sm font-medium text-muted-foreground">Landed Cost — Freight &amp; Duty</h2>
        <Card className="p-4">
          {!shipment.is_booked ? (
            <p className="text-sm text-muted-foreground">
              Entered directly with no booking — freight and duty are ESTIMATED as a percentage of the
              commercial-invoice value (Settings → Landed Cost Rates) and shown on the{' '}
              <Link href="/landed-costs/sms" className="text-primary hover:underline">Landed Costs</Link> page.
              Actual bills are recorded only on booked consignments, which clear customs formally.
            </p>
          ) : (
            <>
              <div className="flex items-center justify-between mb-3">
                <p className="text-xs text-muted-foreground">
                  Actuals from the broker / courier bill — split per PO by CI-value share on the{' '}
                  <Link href="/landed-costs/sms" className="text-primary hover:underline">Landed Costs</Link> page.
                </p>
                {editFin ? (
                  <div className="flex gap-2">
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => {
                      setEditFin(false);
                      setFin({
                        customs_entry_number: shipment.customs_entry_number ?? '',
                        freight: shipment.freight != null ? String(shipment.freight) : '',
                        duty: shipment.duty != null ? String(shipment.duty) : '',
                      });
                    }}><X className="h-4 w-4 mr-1" /> Cancel</Button>
                    <Button size="sm" disabled={busy} onClick={saveFinancials}><Save className="h-4 w-4 mr-1" /> Save</Button>
                  </div>
                ) : (
                  <Button size="sm" variant="outline" onClick={() => setEditFin(true)}><Pencil className="h-4 w-4 mr-1" /> Edit</Button>
                )}
              </div>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                <Meta label="Total Freight (USD)" value={editFin
                  ? <Input type="number" min="0" step="0.01" className="h-8" placeholder="0.00" value={fin.freight}
                      onChange={(e) => setFin((f) => ({ ...f, freight: e.target.value }))} />
                  : money(shipment.freight)} />
                <Meta label="Total Duty (USD)" value={editFin
                  ? <Input type="number" min="0" step="0.01" className="h-8" placeholder="0.00" value={fin.duty}
                      onChange={(e) => setFin((f) => ({ ...f, duty: e.target.value }))} />
                  : money(shipment.duty)} />
                <Meta label="Entry Number" value={editFin
                  ? <Input className="h-8" placeholder="Customs entry #" value={fin.customs_entry_number}
                      onChange={(e) => setFin((f) => ({ ...f, customs_entry_number: e.target.value }))} />
                  : (shipment.customs_entry_number ?? DASH)} />
              </div>
              {(shipment.freight == null || shipment.duty == null) && !editFin && (
                <p className="text-xs text-amber-600 mt-3">
                  Awaiting the actual bill — the landed cost cannot be posted until freight and duty are entered.
                </p>
              )}
              {/* The month-end view groups on SHIP DATE, not the booking's cargo-ready
                  date, so a draft that never got one lands in "Unscheduled". */}
              {!shipment.ship_date && (
                <p className="text-xs text-amber-600 mt-3">
                  {'No ship date yet — this consignment appears under '}
                  <strong>Unscheduled</strong>
                  {' on the '}
                  <Link href="/landed-costs/sms" className="underline">Landed Costs</Link>
                  {/* Explicit string expressions, not bare JSX text: a text node that
                      begins with a space AND wraps across source lines gets its
                      leading whitespace collapsed differently by the SSR and client
                      passes, which is a hydration mismatch (React reported exactly
                      this here). Braced literals are never re-collapsed. */}
                  {" page. Set the Ship Date above to file it under its month — the booking's cargo-ready date is a plan and is not used for this."}
                </p>
              )}
            </>
          )}
        </Card>
      </section>

      {/* ── PO lots in this box ── */}
      <section className="space-y-2">
        <h2 className="text-sm font-medium text-muted-foreground">
          Contents — {shipment.pos.length} PO{shipment.pos.length === 1 ? '' : 's'} · {shipment.total_units.toLocaleString()} units{shipment.total_cartons ? ` · ${shipment.total_cartons.toLocaleString()} cartons` : ''}
        </h2>
        <Card className="overflow-x-auto">
          <Table className="bg-card">
            <TableHeader>
              <TableRow className="bg-card/80 hover:bg-card/80">
                <TableHead>PO</TableHead>
                <TableHead>Supplier</TableHead>
                <TableHead>Lot</TableHead>
                {/* Booked qty only exists on a booked consignment — the variance
                    against shipped is derived at read, never stored. */}
                {shipment.is_booked && <TableHead className="text-right">Booked</TableHead>}
                <TableHead className="text-right">{shipment.is_booked ? 'Shipped' : 'Units'}</TableHead>
                <TableHead className="text-right">Cartons</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shipment.pos.map((p) => {
                const variance = p.booked_units == null ? null : p.units - p.booked_units;
                return (
                  <TableRow key={p.po_number} className="border-border hover:bg-muted/30">
                    <TableCell>
                      <Link href={`/sms/purchase-orders/${encodeURIComponent(p.po_number)}`} className="text-primary hover:underline font-medium">{p.po_number}</Link>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{p.supplier ?? DASH}</TableCell>
                    <TableCell className="text-muted-foreground">Lot {p.lot_number}</TableCell>
                    {shipment.is_booked && (
                      <TableCell className="text-right tabular-nums text-muted-foreground">{p.booked_units?.toLocaleString() ?? DASH}</TableCell>
                    )}
                    <TableCell className="text-right tabular-nums">
                      {p.units.toLocaleString()}
                      {!!variance && (
                        <span className={cn('ml-1.5 text-[11px]', variance > 0 ? 'text-amber-600' : 'text-muted-foreground')}>
                          ({variance > 0 ? '+' : ''}{variance.toLocaleString()})
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{p.cartons ?? DASH}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Card>
      </section>

      {/* ── shipping data: packing summary + generated documents ── */}
      <section className="space-y-2">
        <h2 className="text-sm font-medium text-muted-foreground">Shipping data &amp; documents</h2>
        <Card className="p-4 space-y-4">
          {!shipment.has_shipping_data ? (
            <p className="text-sm text-muted-foreground py-2 text-center">
              No shipping data yet — upload the packing Excel (cartons × SKUs) to record shipped quantities and generate the commercial invoice &amp; packing list.
            </p>
          ) : (
            <>
              {shipment.packing_summary && (
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-4 text-sm">
                  <Meta label="Pieces" value={shipment.packing_summary.total_pcs.toLocaleString()} />
                  <Meta label="Cartons" value={shipment.packing_summary.total_cartons.toLocaleString()} />
                  <Meta label="Value" value={`$${shipment.packing_summary.total_value.toLocaleString()}`} />
                  <Meta label="Net Wt (kg)" value={shipment.packing_summary.total_net_weight.toLocaleString()} />
                  <Meta label="Gross Wt (kg)" value={shipment.packing_summary.total_gross_weight.toLocaleString()} />
                  <Meta label="CBM" value={shipment.packing_summary.total_cbm.toLocaleString()} />
                </div>
              )}
              {documents.length > 0 && (
                <div className="space-y-1.5 border-t border-border/50 pt-3">
                  {scopeOrder(documents).map((scope) => (
                    <div key={scope} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                      <span className="w-full sm:w-40 shrink-0 text-muted-foreground">{scope}</span>
                      {documents.filter((d) => d.scope === scope).sort((a) => (a.doc_type === 'commercial_invoice' ? -1 : 1)).map((d) => (
                        <a key={d.id} href={docHref(d.file_url)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
                          {d.doc_type === 'commercial_invoice' ? <FileText className="h-3.5 w-3.5" /> : <Download className="h-3.5 w-3.5" />}
                          {d.doc_type === 'commercial_invoice' ? 'Commercial Invoice' : 'Packing List'}
                        </a>
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </Card>
      </section>

      {/* ── tracking timeline (courier scans, newest first) ── */}
      <section className="space-y-2">
        <h2 className="text-sm font-medium text-muted-foreground">Tracking history ({shipment.tracking_events.length} scan{shipment.tracking_events.length === 1 ? '' : 's'})</h2>
        <Card className="p-4">
          {shipment.tracking_events.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">
              No courier scans yet — events appear after the next tracking poll (every 4 hours, or use Poll Tracking on the shipments list).
            </p>
          ) : (
            <ol className="space-y-3">
              {shipment.tracking_events.map((e) => (
                <li key={e.id} className="flex gap-3 text-sm">
                  <div className="w-36 shrink-0 text-xs text-muted-foreground tabular-nums pt-0.5">
                    {fmtScanTime(e.event_time)}
                  </div>
                  <div className="w-2 shrink-0 flex flex-col items-center">
                    <div className="w-2 h-2 rounded-full bg-primary mt-1.5" />
                    <div className="flex-1 w-px bg-border" />
                  </div>
                  <div className="pb-1">
                    <div className="font-medium">{e.description || e.courier_code}</div>
                    <div className="text-xs text-muted-foreground">{[e.courier_code, e.location].filter(Boolean).join(' · ')}</div>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </Card>
      </section>
    </div>
  );
}
