'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { ArrowLeft, Download, FileText, Pencil, Save, X, ArrowRight } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { docHref } from '@/lib/api';
import { generateMainlineAsn, updateMainlineShipment } from '@/modules/mainline/actions';
import type { MainlineShipment, MainlineShipmentStatus, MainlineDocument, PortOption, ContainerTypeOption, CourierOption } from '@/modules/mainline/types';

const STATUSES: MainlineShipmentStatus[] = ['Ready to Ship', 'In Transit', 'At Port', 'Delivered', 'Received', 'Cancelled'];
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
}: { shipment: MainlineShipment; documents: MainlineDocument[]; asn: { file_url?: string } | null; ports: PortOption[]; containerTypes: ContainerTypeOption[]; couriers?: CourierOption[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
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
    status: s.status ?? '', bl_no: s.bl_no ?? '', courier_id: s.courier_id ?? '', carrier_reference: s.carrier_reference ?? '', customs_entry_number: s.customs_entry_number ?? '', container_type_id: s.container_type_id ?? '',
    pol_port_id: s.pol_port_id ?? '', pod_port_id: s.pod_port_id ?? (FACILITY_POD[s.facility_id ?? ''] ?? ''),
    cargo_received_date: s.cargo_received_date ?? '', etd_pol: s.etd_pol ?? '', eta_pod: s.eta_pod ?? '', e_del: s.e_del ?? '',
    ata: s.ata ?? '',   // actual receipt date — manual entry
    freight: s.freight != null ? String(s.freight) : '',   // total landed-cost freight/duty
    duty: s.duty != null ? String(s.duty) : '',
  };
  const [form, setForm] = useState(blank);
  const setF = (k: keyof typeof blank, v: string) => setForm((f) => ({ ...f, [k]: v }));

  // Landed-cost BASIS follows the carrier currently selected in the form (not the
  // saved one), so switching to FedEx immediately hides the freight/duty inputs
  // rather than letting the user type values the server will reject.
  const selectedCourier = couriers.find((c) => c.id === form.courier_id) || null;
  const isEstimateBasis = !!selectedCourier && selectedCourier.provides_cost_invoices === false;

  const legIds = useMemo(() => new Set(s.legs.map((l) => l.leg_id)), [s.legs]);
  const shipmentDocs = documents.filter((d) => d.leg_id === null || legIds.has(d.leg_id as string));
  const portLabel = (p: PortOption) => (p.code ? `${p.name} (${p.code})` : p.name);

  async function save() {
    setBusy(true);
    const res = await updateMainlineShipment(s.id, {
      status: form.status || undefined,
      bl_no: form.bl_no || null,
      courier_id: form.courier_id || null,
      carrier_reference: form.carrier_reference || null,
      customs_entry_number: form.customs_entry_number || null,
      container_type_id: form.container_type_id || null,
      pol_port_id: form.pol_port_id || null,
      pod_port_id: form.pod_port_id || null,
      cargo_received_date: form.cargo_received_date || null,
      etd_pol: form.etd_pol || null,
      eta_pod: form.eta_pod || null,
      e_del: form.e_del || null,
      // ATA is derived from NetSuite Item Receipts when present — don't overwrite it
      ata: s.ata_source === 'netsuite' ? undefined : (form.ata || null),
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
  const portSelect = (k: 'pol_port_id' | 'pod_port_id', options: PortOption[]) => {
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
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{s.shipment_number}</h1>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {asn?.file_url && <a href={docHref(asn.file_url)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline text-sm"><Download className="h-3.5 w-3.5" /> Latest ASN</a>}
            <Button size="sm" variant="outline" disabled={busy || !s.e_del} title={s.e_del ? 'Generate ASN' : 'Needs an estimated delivery date (E-DEL)'} onClick={genAsn}>
              <FileText className="h-4 w-4 mr-1" /> {asn ? 'Regenerate ASN' : 'Generate ASN'}
            </Button>
            {editing ? (
              <>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setEditing(false); setForm(blank); }}><X className="h-4 w-4 mr-1" /> Cancel</Button>
                <Button size="sm" disabled={busy} onClick={save}><Save className="h-4 w-4 mr-1" /> Save</Button>
              </>
            ) : (
              <Button size="sm" variant="outline" onClick={() => setEditing(true)}><Pencil className="h-4 w-4 mr-1" /> Edit</Button>
            )}
          </div>
        </div>
      </div>

      {/* ── Overview: identity & cargo ── */}
      <section className="space-y-2">
        <h2 className="text-sm font-medium text-muted-foreground">Overview</h2>
        <Card className="p-4 space-y-4">
          {/* line 1 — booking + status + carrier + its reference */}
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
            <Cell label="Booking">
              {s.booking_id
                ? <Link href={`/mainline/bookings/${s.booking_id}`} className="text-primary hover:underline">{s.booking_number ?? 'view booking'}</Link>
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
                ? <Select value={form.courier_id || NONE} onValueChange={(v) => setF('courier_id', v === NONE ? '' : (v ?? ''))}>
                    {/* label rendered directly — see the Radix Select gotcha in CLAUDE.md */}
                    <SelectTrigger className="h-8">
                      <span className={cn(!form.courier_id && 'text-muted-foreground')}>
                        {couriers.find((c) => c.id === form.courier_id)?.name ?? '—'}
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
                ? <Input className="h-8" placeholder="carrier reference" value={form.carrier_reference} onChange={(e) => setF('carrier_reference', e.target.value)} />
                : (s.carrier_reference ?? '—')}
            </Cell>
          </div>
          {/* line 2 — cargo identity */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Cell label="Supplier">{s.supplier_name ?? '—'}</Cell>
            <Cell label="Mode">{s.mode ?? '—'}</Cell>
            <Cell label="Container Type">
              {editing
                ? <Select value={form.container_type_id || NONE} onValueChange={(v) => setF('container_type_id', v === NONE ? '' : (v ?? ''))}>
                    {/* label rendered directly — <SelectValue> shows the raw id (ct_lcl) for a programmatic value */}
                    <SelectTrigger className="h-8"><span className={cn(!form.container_type_id && 'text-muted-foreground')}>{containerTypes.find((c) => c.id === form.container_type_id)?.name ?? '—'}</span></SelectTrigger>
                    <SelectContent><SelectItem value={NONE}>—</SelectItem>{containerTypes.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}</SelectContent>
                  </Select>
                : (s.container_type ?? '—')}
            </Cell>
            <Cell label="BL No.">
              {editing
                ? <Input className="h-8" placeholder="Bill of lading #" value={form.bl_no} onChange={(e) => setF('bl_no', e.target.value)} />
                : (s.bl_no ?? '—')}
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
            <Cell label="Departure Port (POL)">{editing ? portSelect('pol_port_id', loadingPorts) : (s.pol_port ?? '—')}</Cell>
            <Cell label="Arrival Port (POD)" hint={editing ? 'NRI CA → Vancouver · NRI US → Los Angeles' : undefined}>{editing ? portSelect('pod_port_id', dischargePorts) : (s.pod_port ?? '—')}</Cell>
            <Cell label="Destination">{s.destination_facility ?? '—'}</Cell>
          </div>
          {/* timeline — chronological order */}
          <div className="border-t border-border pt-4">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <Cell label="CRD">{s.crd ?? '—'}</Cell>
              <Cell label="Received at Port">{editing ? dateInput('cargo_received_date') : (s.cargo_received_date ?? '—')}</Cell>
              <Cell label="ETD POL">{editing ? dateInput('etd_pol') : (s.etd_pol ?? '—')}</Cell>
              <Cell label="ETA POD">{editing ? dateInput('eta_pod') : (s.eta_pod ?? '—')}</Cell>
              <Cell label="E-DEL">{editing ? dateInput('e_del') : (s.e_del ?? '—')}</Cell>
              <Cell label="Expected ATA" hint="derived = E-DEL + 5">{s.expected_ata ?? '—'}</Cell>
              <Cell label="ATA" hint={s.ata_source === 'netsuite' ? 'from NetSuite Item Receipt' : 'actual — received in system'}>
                {s.ata_source === 'netsuite' ? (s.ata ?? '—') : (editing ? dateInput('ata') : (s.ata ?? '—'))}
              </Cell>
            </div>
          </div>
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
            <Cell label="Total Freight (USD)">
              {editing && !isEstimateBasis
                ? <Input type="number" min="0" step="0.01" className="h-8" placeholder="0.00" value={form.freight} onChange={(e) => setF('freight', e.target.value)} />
                : isEstimateBasis
                  ? <span className="text-muted-foreground">estimated</span>
                  : (s.freight != null ? `$${Number(s.freight).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—')}
            </Cell>
            <Cell label="Total Duty (USD)">
              {editing && !isEstimateBasis
                ? <Input type="number" min="0" step="0.01" className="h-8" placeholder="0.00" value={form.duty} onChange={(e) => setF('duty', e.target.value)} />
                : isEstimateBasis
                  ? <span className="text-muted-foreground">estimated</span>
                  : (s.duty != null ? `$${Number(s.duty).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—')}
            </Cell>
            <Cell label="Entry Number">
              {editing
                ? <Input className="h-8" placeholder="Customs entry #" value={form.customs_entry_number} onChange={(e) => setF('customs_entry_number', e.target.value)} />
                : (s.customs_entry_number ?? '—')}
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
                <TableRow key={l.leg_id} className="border-border hover:bg-muted/30">
                  <TableCell className="font-medium">
                    {l.po_number && l.trn_number
                      ? <Link href={`/mainline/purchase-orders/${encodeURIComponent(l.trn_number)}/${l.leg_id}`} className="text-primary hover:underline">{l.po_number}</Link>
                      : (l.po_number ?? `#${l.leg_id}`)}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">{l.netsuite_id ?? '—'}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {l.trn_number ? <Link href={`/mainline/purchase-orders/${l.trn_number}`} className="text-primary hover:underline">{l.trn_number}</Link> : '—'}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{l.allocation_channel ?? '—'}</TableCell>
                  <TableCell className="text-muted-foreground">{l.crd ?? '—'}</TableCell>
                  <TableCell className="text-right tabular-nums">{l.cartons != null ? l.cartons.toLocaleString() : '—'}</TableCell>
                  <TableCell className="text-right tabular-nums">{(l.expected_quantity ?? 0).toLocaleString()}</TableCell>
                  <TableCell className="text-right tabular-nums">{l.invoice_value != null ? `$${l.invoice_value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—'}</TableCell>
                </TableRow>
              ))}
              <TableRow className="bg-card/80 font-medium border-border">
                <TableCell colSpan={5}>Total ({s.legs.length} PO{s.legs.length === 1 ? '' : 's'})</TableCell>
                <TableCell className="text-right tabular-nums">{s.legs.reduce((a, l) => a + (l.cartons ?? 0), 0).toLocaleString()}</TableCell>
                <TableCell className="text-right tabular-nums">{s.total_expected_quantity.toLocaleString()}</TableCell>
                <TableCell className="text-right tabular-nums">{(() => { const t = s.legs.reduce((a, l) => a + (l.invoice_value ?? 0), 0); return t ? `$${t.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—'; })()}</TableCell>
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
                  {shipmentDocs.filter((d) => d.scope === scope).sort((a) => (a.doc_type === 'commercial_invoice' ? -1 : 1)).map((d) => (
                    <a key={d.id} href={docHref(d.file_url)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
                      <Download className="h-3.5 w-3.5" /> {d.doc_type === 'commercial_invoice' ? 'Commercial Invoice' : 'Packing Slip'}
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
