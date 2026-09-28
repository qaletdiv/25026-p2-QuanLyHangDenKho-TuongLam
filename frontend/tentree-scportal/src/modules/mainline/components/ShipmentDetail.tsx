'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { ArrowLeft, Ban, Download, FileText, Flag, Pencil, Save, Trash2, X, ArrowRight } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { MoneyInput } from '@/components/ui/money-input';
import { Textarea } from '@/components/ui/textarea';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { docHref, generatedDocHref } from '@/lib/api';
import { cancelMainlineShipment, deleteMainlineShipment, generateMainlineAsn, updateMainlineShipment } from '@/modules/mainline/actions';
import { useSession } from '@/components/providers/SessionProvider';
import { hasPermission } from '@/lib/permissions';
import ConfirmDialog from './ConfirmDialog';
import type { MainlineShipment, MainlineShipmentStatus, MainlineDocument, PortOption, ContainerTypeOption, CourierOption } from '@/modules/mainline/types';

// The PROGRESS pipeline, which is all this dropdown sets. 'Cancelled' is not in
// it: cancelling is a decision with guards (handed over? received? costed?) behind
// the Cancel action below, and the server refuses the name on this route — a free
// dropdown entry would just be a way around those guards.
const STATUSES: MainlineShipmentStatus[] = ['Ready to Ship', 'In Transit', 'At Port', 'Delivered', 'Received'];
const STATUS_STYLES: Record<string, string> = {
  'Ready to Ship': 'bg-blue-500/10 text-blue-600 border-blue-500/20',
  'In Transit': 'bg-violet-500/10 text-violet-600 border-violet-500/20',
  'At Port': 'bg-cyan-500/10 text-cyan-600 border-cyan-500/20',
  'Delivered': 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20',
  'Received': 'bg-emerald-600/10 text-emerald-700 border-emerald-600/20',
  'Cancelled': 'bg-red-500/10 text-red-600 border-red-500/20',
};
const NONE = '__none__';   // base-ui Select can't hold an empty-string value

// One label + value/control cell. `hint` is a small sub-note (e.g. "derived").
function Cell({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div className="space-y-1">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className="text-sm">{children ?? '—'}</div>
      {hint && <div className="text-[10px] text-muted-foreground/70">{hint}</div>}
    </div>
  );
}

export default function ShipmentDetail({
  shipment: s, documents, asn, ports, containerTypes, couriers = [],
}: { shipment: MainlineShipment; documents: MainlineDocument[]; asn: { fileUrl?: string } | null; ports: PortOption[]; containerTypes: ContainerTypeOption[]; couriers?: CourierOption[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState<null | 'cancel' | 'delete'>(null);

  const { user } = useSession();
  const canCancel = hasPermission(user, 'shipment_update_status');
  const canDelete = hasPermission(user, 'shipment_delete');
  // Its OWN key — shipment_update_status is held by the Freight Forwarder and
  // Production too, and the flag is Logistics' marker. The server is still the
  // authority; this only stops the UI offering what the API would refuse.
  const canFlagPriority = hasPermission(user, 'shipment_flag_priority');

  // Mirror of the server's handover predicate (shipmentLifecycle.js), so the button
  // can explain itself instead of costing a round trip to be told no. The SERVER is
  // still the authority, and it knows two things this page does not — whether a
  // confirmed Item Receipt or a posted landed cost points here — so a refusal can
  // still come back; its message is written to be shown as-is.
  const isCancelled = s.status === 'Cancelled';
  const handover = [
    s.cargoReceivedDate && `received at port ${s.cargoReceivedDate}`,
    s.etdPol && `ETD ${s.etdPol}`,
    s.blNo && `BL ${s.blNo}`,
  ].filter(Boolean) as string[];
  // POL = origin ports; POD (arrival) is one of the two NRI discharge ports only.
  const loadingPorts = ports.filter((p) => p.role !== 'discharge');
  const dischargePorts = ports.filter((p) => p.role === 'discharge');
  // arrival port defaults from the destination facility (NRI US → LA, NRI CA → Vancouver)
  const FACILITY_POD: Record<string, string> = {
    fac_nri_us: dischargePorts.find((p) => /los angeles/i.test(p.name))?.id ?? '',
    fac_nri_ca: dischargePorts.find((p) => /vancouver/i.test(p.name))?.id ?? '',
  };
  // editable header-level fields — one edit covers every PO leg in this shipment
  const blank = {
    status: s.status ?? '', blNo: s.blNo ?? '', courierId: s.courierId ?? '', carrierReference: s.carrierReference ?? '', customsEntryNumber: s.customsEntryNumber ?? '', containerTypeId: s.containerTypeId ?? '',
    polPortId: s.polPortId ?? '', podPortId: s.podPortId ?? (FACILITY_POD[s.facilityId ?? ''] ?? ''),
    // REVISED cargo ready — this shipment's own, the forwarder's to keep current.
    // The PO's (s.crd) and the booked one (s.bookedCargoReadyDate) are shown beside
    // it as read-only reference and are deliberately NOT in the form.
    cargoReadyDate: s.cargoReadyDate ?? '',
    cargoReceivedDate: s.cargoReceivedDate ?? '', etdPol: s.etdPol ?? '', etaPod: s.etaPod ?? '', eDel: s.eDel ?? '',
    ata: s.ata ?? '',   // actual receipt date — manual entry
    freight: s.freight != null ? String(s.freight) : '',   // total landed-cost freight/duty
    duty: s.duty != null ? String(s.duty) : '',
    notes: s.notes ?? '',
  };
  const [form, setForm] = useState(blank);
  const setF = (k: keyof typeof blank, v: string) => setForm((f) => ({ ...f, [k]: v }));

  // Landed-cost BASIS follows the carrier currently selected in the form (not the
  // saved one), so switching to FedEx immediately hides the freight/duty inputs
  // rather than letting the user type values the server will reject.
  const selectedCourier = couriers.find((c) => c.id === form.courierId) || null;
  const isEstimateBasis = !!selectedCourier && selectedCourier.providesCostInvoices === false;

  const legIds = useMemo(() => new Set(s.legs.map((l) => l.legId)), [s.legs]);
  const shipmentDocs = documents.filter((d) => d.legId === null || legIds.has(d.legId as string));
  const portLabel = (p: PortOption) => (p.code ? `${p.name} (${p.code})` : p.name);

  async function save() {
    setBusy(true);
    const res = await updateMainlineShipment(s.id, {
      status: form.status || undefined,
      blNo: form.blNo || null,
      courierId: form.courierId || null,
      carrierReference: form.carrierReference || null,
      customsEntryNumber: form.customsEntryNumber || null,
      containerTypeId: form.containerTypeId || null,
      polPortId: form.polPortId || null,
      podPortId: form.podPortId || null,
      cargoReadyDate: form.cargoReadyDate || null,
      cargoReceivedDate: form.cargoReceivedDate || null,
      etdPol: form.etdPol || null,
      etaPod: form.etaPod || null,
      eDel: form.eDel || null,
      notes: form.notes || null,
      // ATA is derived from NetSuite Item Receipts when present — don't overwrite it
      ata: s.ataSource === 'netsuite' ? undefined : (form.ata || null),
      // Omitted entirely on an estimate-basis carrier: the server refuses typed
      // amounts there (they would contradict the derived CI × rate figure), and
      // sending even a null would be asserting something about a field we don't own.
      ...(isEstimateBasis ? {} : {
        freight: form.freight === '' ? null : Number(form.freight),
        duty: form.duty === '' ? null : Number(form.duty),
      }),
    });
    setBusy(false);
    if (res?.error) { toast.error(res.error); return; }
    toast.success('Shipment updated');
    setEditing(false);
    router.refresh();
  }

  // Saves on its own, outside the Edit form: flagging is a one-click act, and
  // making someone open an editor, tick a box and press Save to say "look at this"
  // is enough friction that it stops being used.
  async function togglePriority() {
    setBusy(true);
    const next = !s.priority;
    const res = await updateMainlineShipment(s.id, { priority: next });
    setBusy(false);
    if (res?.error) { toast.error(res.error); return; }
    toast.success(next ? `${s.shipmentNumber} flagged as priority` : `Priority cleared on ${s.shipmentNumber}`);
    router.refresh();
  }

  async function doCancel() {
    setBusy(true);
    const res = await cancelMainlineShipment(s.id);
    setBusy(false);
    setConfirm(null);
    if (res?.error) { toast.error(res.error); return; }
    toast.success(`${s.shipmentNumber} cancelled — the booking still holds these units, so re-approving it issues a new consignment`);
    router.refresh();
  }

  async function doDelete() {
    setBusy(true);
    const res = await deleteMainlineShipment(s.id);
    setBusy(false);
    if (res?.error) { toast.error(res.error); setConfirm(null); return; }
    toast.success(`${s.shipmentNumber} deleted`);
    router.push('/mainline/shipments');
  }

  async function genAsn() {
    setBusy(true);
    const res = await generateMainlineAsn(s.id);
    setBusy(false);
    if (res?.error) { toast.error(res.error); return; }
    toast.success('ASN generated');
    router.refresh();
  }

  // edit controls bound to form state
  const dateInput = (k: keyof typeof blank) => (
    <Input type="date" className="h-8" value={form[k] ?? ''} onChange={(e) => setF(k, e.target.value)} />
  );
  // label rendered directly in the trigger — base-ui <SelectValue> shows the raw id
  // when the value is set programmatically (see CLAUDE.md Radix/base-ui Select gotcha).
  const portSelect = (k: 'polPortId' | 'podPortId', options: PortOption[]) => {
    const sel = options.find((p) => p.id === form[k]);
    return (
      <Select value={form[k] || NONE} onValueChange={(v) => setF(k, v === NONE ? '' : (v ?? ''))}>
        <SelectTrigger className="h-8"><span className={cn(!sel && 'text-muted-foreground')}>{sel ? portLabel(sel) : '—'}</span></SelectTrigger>
        <SelectContent><SelectItem value={NONE}>—</SelectItem>{options.map((p) => <SelectItem key={p.id} value={p.id}>{portLabel(p)}</SelectItem>)}</SelectContent>
      </Select>
    );
  };

  return (
    <div className="p-4 md:p-6 space-y-6 max-w-4xl mx-auto">
      {/* ── Slim header: identity + quick status + actions ── */}
      <div>
        <Link href="/mainline/shipments" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground mb-3">
          <ArrowLeft className="w-4 h-4" /> Shipments
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight">{s.shipmentNumber}</h1>
            {/* PRIORITY is a standalone toggle, not part of the Edit form: it is a
                different ACT (asking for someone's attention) under a different
                permission, and burying it behind Edit would hide it from the people
                who read it. Same visible-but-disabled rule the Approve button uses —
                a forwarder should still SEE that Logistics has flagged this. */}
            <span title={canFlagPriority
              ? (s.priority ? 'Clear the priority flag' : 'Flag this consignment as needing attention')
              : 'Only Admin or a Logistics Coordinator can change this'} className="inline-block">
              <Button
                size="sm"
                variant={s.priority ? 'default' : 'outline'}
                disabled={busy || !canFlagPriority}
                onClick={togglePriority}
                className={cn(s.priority && 'bg-amber-500 hover:bg-amber-600 text-white border-amber-500')}
              >
                <Flag className={cn('h-3.5 w-3.5 mr-1.5', s.priority && 'fill-current')} />
                {s.priority ? 'Priority' : 'Flag priority'}
              </Button>
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {asn?.fileUrl && <a href={docHref(asn.fileUrl)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline text-sm"><Download className="h-3.5 w-3.5" /> Latest ASN</a>}
            <Button size="sm" variant="outline" disabled={busy || !s.eDel} title={s.eDel ? 'Generate ASN' : 'Needs an estimated delivery date (E-DEL)'} onClick={genAsn}>
              <FileText className="h-4 w-4 mr-1" /> {asn ? 'Regenerate ASN' : 'Generate ASN'}
            </Button>
            {editing ? (
              <>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setEditing(false); setForm(blank); }}><X className="h-4 w-4 mr-1" /> Cancel</Button>
                <Button size="sm" disabled={busy} onClick={save}><Save className="h-4 w-4 mr-1" /> Save</Button>
              </>
            ) : (
              <>
                <Button size="sm" variant="outline" onClick={() => setEditing(true)}><Pencil className="h-4 w-4 mr-1" /> Edit</Button>
                {/* "Cancel consignment", never bare "Cancel" — the edit mode above
                    already owns that word for "stop editing". */}
                {canCancel && !isCancelled && (
                  <span title={handover.length
                    ? `Already handed over (${handover.join(', ')}) — cancel is for a consignment that has not left the supplier`
                    : undefined} className="inline-block">
                    <Button size="sm" variant="outline" disabled={busy || handover.length > 0} onClick={() => setConfirm('cancel')}>
                      <Ban className="h-4 w-4 mr-1" /> Cancel consignment
                    </Button>
                  </span>
                )}
                {/* Delete only ever appears on a cancelled row: erasing a live
                    consignment should not be one click away, and the server
                    refuses it anyway. */}
                {canDelete && isCancelled && (
                  <Button size="sm" variant="ghost" disabled={busy} title="Delete this consignment" onClick={() => setConfirm('delete')}>
                    <Trash2 className="h-4 w-4 text-red-500" />
                  </Button>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={confirm === 'cancel'}
        title={`Cancel ${s.shipmentNumber}?`}
        description="The consignment is called off, but its booking keeps authorizing these units — re-approving the booking issues a new one. Cancelled consignments can then be deleted."
        confirmLabel="Cancel consignment"
        busy={busy}
        onCancel={() => setConfirm(null)}
        onConfirm={doCancel}
      />
      <ConfirmDialog
        open={confirm === 'delete'}
        title={`Delete ${s.shipmentNumber}?`}
        description="Its lot rows, ASN and receipt-match rejections are removed and any item receipts are unlinked (never deleted). The booking's commercial invoice and packing data are untouched. This cannot be undone."
        confirmLabel="Delete"
        destructive
        busy={busy}
        onCancel={() => setConfirm(null)}
        onConfirm={doDelete}
      />

      {/* ── Overview: identity & cargo ── */}
      <section className="space-y-2">
        <h2 className="text-sm font-medium text-muted-foreground">Overview</h2>
        <Card className="p-4 space-y-4">
          {/* line 1 — booking + status + carrier + its reference */}
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
            <Cell label="Booking">
              {s.bookingId
                ? <Link href={`/mainline/bookings/${s.bookingId}`} className="text-primary hover:underline">{s.bookingNumber ?? 'view booking'}</Link>
                : '—'}
            </Cell>
            <Cell label="Status">
              {editing
                ? <Select value={form.status || undefined} onValueChange={(v) => setF('status', v ?? '')}>
                    <SelectTrigger className="h-8"><SelectValue placeholder="—" /></SelectTrigger>
                    <SelectContent>{STATUSES.map((st) => <SelectItem key={st} value={st}>{st}</SelectItem>)}</SelectContent>
                  </Select>
                : <Badge variant="outline" className={cn(STATUS_STYLES[s.status || ''])}>{s.status ?? '—'}</Badge>}
            </Cell>
            {/* Carrier — WHO moved it. Not every mainline shipment goes with a
                forwarder, and this is what decides whether the landed cost is the
                actual off their invoices or an estimate from the CI value. */}
            <Cell label="Carrier" hint={isEstimateBasis ? 'no separate freight & duty invoice — landed cost is estimated' : undefined}>
              {editing
                ? <Select value={form.courierId || NONE} onValueChange={(v) => setF('courierId', v === NONE ? '' : (v ?? ''))}>
                    {/* label rendered directly — see the Radix Select gotcha in CLAUDE.md */}
                    <SelectTrigger className="h-8">
                      <span className={cn(!form.courierId && 'text-muted-foreground')}>
                        {couriers.find((c) => c.id === form.courierId)?.name ?? '—'}
                      </span>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE}>—</SelectItem>
                      {couriers.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                : (s.courier ?? '—')}
            </Cell>
            {/* Was "CEVA Shipment #". Deliberately NOT "Shipment #" — that is the
                portal's own SHP-N in the header above. */}
            <Cell label="Carrier Ref #" hint="the carrier's own reference for this shipment">
              {editing
                ? <Input className="h-8" placeholder="carrier reference" value={form.carrierReference} onChange={(e) => setF('carrierReference', e.target.value)} />
                : (s.carrierReference ?? '—')}
            </Cell>
          </div>
          {/* line 2 — cargo identity */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Cell label="Supplier">{s.supplierName ?? '—'}</Cell>
            <Cell label="Mode">{s.mode ?? '—'}</Cell>
            <Cell label="Container Type">
              {editing
                ? <Select value={form.containerTypeId || NONE} onValueChange={(v) => setF('containerTypeId', v === NONE ? '' : (v ?? ''))}>
                    {/* label rendered directly — <SelectValue> shows the raw id (ct_lcl) for a programmatic value */}
                    <SelectTrigger className="h-8"><span className={cn(!form.containerTypeId && 'text-muted-foreground')}>{containerTypes.find((c) => c.id === form.containerTypeId)?.name ?? '—'}</span></SelectTrigger>
                    <SelectContent><SelectItem value={NONE}>—</SelectItem>{containerTypes.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}</SelectContent>
                  </Select>
                : (s.containerType ?? '—')}
            </Cell>
            <Cell label="BL No.">
              {editing
                ? <Input className="h-8" placeholder="Bill of lading #" value={form.blNo} onChange={(e) => setF('blNo', e.target.value)} />
                : (s.blNo ?? '—')}
            </Cell>
          </div>
        </Card>
      </section>

      {/* ── Route & Schedule: ports + chronological dates ── */}
      <section className="space-y-2">
        <h2 className="text-sm font-medium text-muted-foreground">Route &amp; Schedule</h2>
        <Card className="p-4 space-y-4">
          {/* route */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Cell label="COO">{s.coo.length ? s.coo.join(', ') : '—'}</Cell>
            <Cell label="Departure Port (POL)">{editing ? portSelect('polPortId', loadingPorts) : (s.polPort ?? '—')}</Cell>
            <Cell label="Arrival Port (POD)" hint={editing ? 'NRI CA → Vancouver · NRI US → Los Angeles' : undefined}>{editing ? portSelect('podPortId', dischargePorts) : (s.podPort ?? '—')}</Cell>
            <Cell label="Destination">{s.destinationFacility ?? '—'}</Cell>
          </div>
          {/* timeline — chronological order */}
          <div className="border-t border-border pt-4">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {/* THREE cargo-ready dates, oldest commitment first. They are NOT
                  three readings of one date — each has its own owner, and the
                  drift between them is the thing this row exists to show:
                    PO      NetSuite custbody46, earliest across this
                            consignment's legs. Read-only here; edit it in NetSuite.
                    Booked  what the vendor committed to on the booking.
                    Revised this shipment's own — the forwarder keeps it current.
                  "Received at Port" below is a different EVENT again (the carrier
                  physically has the cargo), which is why it is not in this group. */}
              <Cell label="Cargo Ready (PO)" hint="from NetSuite — earliest across this shipment's legs">{s.crd ?? '—'}</Cell>
              <Cell label="Cargo Ready (booked)" hint="stated by the vendor on the booking">{s.bookedCargoReadyDate ?? '—'}</Cell>
              <Cell label="Cargo Ready (revised)" hint={editing ? 'the forwarder’s working date for this consignment' : undefined}>
                {editing ? dateInput('cargoReadyDate') : (s.cargoReadyDate ?? '—')}
              </Cell>
              <Cell label="Received at Port" hint={editing ? 'the carrier has the cargo — later than Cargo Ready' : undefined}>{editing ? dateInput('cargoReceivedDate') : (s.cargoReceivedDate ?? '—')}</Cell>
              <Cell label="ETD POL">{editing ? dateInput('etdPol') : (s.etdPol ?? '—')}</Cell>
              <Cell label="ETA POD">{editing ? dateInput('etaPod') : (s.etaPod ?? '—')}</Cell>
              <Cell label="E-DEL">{editing ? dateInput('eDel') : (s.eDel ?? '—')}</Cell>
              <Cell label="Expected ATA" hint="derived = E-DEL + 5">{s.expectedAta ?? '—'}</Cell>
              <Cell label="ATA" hint={s.ataSource === 'netsuite' ? 'from NetSuite Item Receipt' : 'actual — received in system'}>
                {s.ataSource === 'netsuite' ? (s.ata ?? '—') : (editing ? dateInput('ata') : (s.ata ?? '—'))}
              </Cell>
            </div>
          </div>
        </Card>
      </section>

      {/* ── Notes ──
          A SHARED operational note, not a private one: everyone who can see this
          shipment sees it, vendors included (they are supplier-scoped, not
          excluded). Single field, so it has no author and no history — a later
          edit REPLACES what was there. Said out loud under the box, because a note
          people think is private or appended is the way that bites.
          Edited with the rest of the header so one Save covers the whole card. */}
      <section className="space-y-2">
        <h2 className="text-sm font-medium text-muted-foreground">Notes</h2>
        <Card className="p-4 space-y-2">
          {editing ? (
            <>
              <Textarea
                value={form.notes}
                onChange={(e) => setF('notes', e.target.value)}
                placeholder="Anything the next person needs to know — a rolled sailing, a split delivery, who to chase."
                rows={4}
                maxLength={4000}
                className="text-sm"
              />
              <p className="text-[10px] text-muted-foreground/70">
                Visible to everyone who can see this shipment. Saving replaces the previous note.
              </p>
            </>
          ) : (
            <p className={cn('text-sm whitespace-pre-wrap', !s.notes && 'text-muted-foreground')}>
              {s.notes || 'No notes.'}
            </p>
          )}
        </Card>
      </section>

      {/* ── Landed Cost: total freight & duty for this shipment (split per PO on the Landed Costs page) ── */}
      <section className="space-y-2">
        <h2 className="text-sm font-medium text-muted-foreground">Landed Cost — Freight &amp; Duty</h2>
        <Card className="p-4">
          {/* An estimate-basis carrier (FedEx/DHL) invoices no freight or duty that
              finance can trace, so the figures are DERIVED from the commercial-invoice
              value on the Landed Costs page. Typing them here is refused server-side,
              so the inputs are replaced by an explanation rather than shown disabled. */}
          {isEstimateBasis && (
            <p className="mb-3 text-xs text-amber-600 dark:text-amber-400">
              {/* explicit {' '} — this toolchain drops the literal space after an expression */}
              {selectedCourier?.name}{' '}does not invoice freight &amp; duty separately, so this shipment&apos;s landed cost is
              estimated from the commercial-invoice value — see the{' '}
              <Link href="/landed-costs/mainline" className="underline">Landed Costs</Link> page. Amounts cannot be entered by hand.
            </p>
          )}
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            {/* MoneyInput, not `type="number"`: these are four- and five-figure
                bills off a forwarder invoice, and a number input cannot show group
                separators, so 14763.30 and 1476.33 looked alike while typing. It
                still hands back a plain comma-free string, so `Number(form.freight)`
                in save() is unchanged. */}
            <Cell label="Total Freight (USD)">
              {editing && !isEstimateBasis
                ? <MoneyInput className="h-8" placeholder="0.00" value={form.freight} onValueChange={(v) => setF('freight', v)} />
                : isEstimateBasis
                  ? <span className="text-muted-foreground">estimated</span>
                  : (s.freight != null ? `$${Number(s.freight).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—')}
            </Cell>
            <Cell label="Total Duty (USD)">
              {editing && !isEstimateBasis
                ? <MoneyInput className="h-8" placeholder="0.00" value={form.duty} onValueChange={(v) => setF('duty', v)} />
                : isEstimateBasis
                  ? <span className="text-muted-foreground">estimated</span>
                  : (s.duty != null ? `$${Number(s.duty).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—')}
            </Cell>
            <Cell label="Entry Number">
              {editing
                ? <Input className="h-8" placeholder="Customs entry #" value={form.customsEntryNumber} onChange={(e) => setF('customsEntryNumber', e.target.value)} />
                : (s.customsEntryNumber ?? '—')}
            </Cell>
          </div>
        </Card>
      </section>

      {/* ── PO legs carried by this physical shipment ── */}
      <section className="space-y-2">
        <h2 className="text-sm font-medium text-muted-foreground">Purchase Orders</h2>
        <Card className="overflow-x-auto">
          <Table className="bg-card">
            <TableHeader>
              <TableRow className="bg-card/80 hover:bg-card/80">
                <TableHead>PO</TableHead><TableHead>NetSuite ID</TableHead><TableHead>TRN</TableHead><TableHead>Channel</TableHead>
                <TableHead>CRD</TableHead>
                <TableHead className="text-right">Cartons</TableHead><TableHead className="text-right">Qty</TableHead>
                <TableHead className="text-right">Invoice Value</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {s.legs.map((l) => (
                <TableRow key={l.legId} className="border-border hover:bg-muted/30">
                  <TableCell className="font-medium">
                    {l.poNumber && l.trnNumber
                      ? <Link href={`/mainline/purchase-orders/${encodeURIComponent(l.trnNumber)}/${l.legId}`} className="text-primary hover:underline">{l.poNumber}</Link>
                      : (l.poNumber ?? `#${l.legId}`)}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">{l.netsuiteId ?? '—'}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {l.trnNumber ? <Link href={`/mainline/purchase-orders/${l.trnNumber}`} className="text-primary hover:underline">{l.trnNumber}</Link> : '—'}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{l.allocationChannel ?? '—'}</TableCell>
                  <TableCell className="text-muted-foreground">{l.crd ?? '—'}</TableCell>
                  <TableCell className="text-right tabular-nums">{l.cartons != null ? l.cartons.toLocaleString() : '—'}</TableCell>
                  <TableCell className="text-right tabular-nums">{(l.expectedQuantity ?? 0).toLocaleString()}</TableCell>
                  <TableCell className="text-right tabular-nums">{l.invoiceValue != null ? `$${l.invoiceValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—'}</TableCell>
                </TableRow>
              ))}
              <TableRow className="bg-card/80 font-medium border-border">
                <TableCell colSpan={5}>Total ({s.legs.length} PO{s.legs.length === 1 ? '' : 's'})</TableCell>
                <TableCell className="text-right tabular-nums">{s.legs.reduce((a, l) => a + (l.cartons ?? 0), 0).toLocaleString()}</TableCell>
                <TableCell className="text-right tabular-nums">{s.totalExpectedQuantity.toLocaleString()}</TableCell>
                <TableCell className="text-right tabular-nums">{(() => { const t = s.legs.reduce((a, l) => a + (l.invoiceValue ?? 0), 0); return t ? `$${t.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—'; })()}</TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </Card>
      </section>

      {/* ── Documents ── */}
      <section className="space-y-2">
        <h2 className="text-sm font-medium text-muted-foreground">Shipping Docs</h2>
        <Card className="p-4">
          {shipmentDocs.length === 0 ? (
            <p className="text-sm text-muted-foreground italic">No documents yet — upload shipment data on the booking.</p>
          ) : (
            <div className="space-y-1.5">
              {[...new Set(shipmentDocs.map((d) => d.scope))].sort((a, b) => (a.startsWith('Combined') ? -1 : b.startsWith('Combined') ? 1 : a.localeCompare(b))).map((scope) => (
                <div key={scope} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                  <span className="w-full sm:w-44 shrink-0 text-muted-foreground">{scope}</span>
                  {shipmentDocs.filter((d) => d.scope === scope).sort((a) => (a.docType === 'commercial_invoice' ? -1 : 1)).map((d) => (
                    <a key={d.id} href={generatedDocHref('mainline', d.id)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
                      <Download className="h-3.5 w-3.5" /> {d.docType === 'commercial_invoice' ? 'Commercial Invoice' : 'Packing Slip'}
                    </a>
                  ))}
                </div>
              ))}
            </div>
          )}
        </Card>
      </section>
    </div>
  );
}
