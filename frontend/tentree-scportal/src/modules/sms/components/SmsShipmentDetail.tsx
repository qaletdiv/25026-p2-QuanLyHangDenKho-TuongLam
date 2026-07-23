'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { ArrowLeft, Trash2, Upload, FileText, Download } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { BACKEND_URL } from '@/lib/api';
// Generic UI primitive shared across modules (no mainline data coupling)
import ConfirmDialog from '@/modules/mainline/components/ConfirmDialog';
import { updateSmsShipment, deleteSmsShipment, uploadSmsShippingData } from '@/modules/sms/actions';
import { SMS_STATUSES, SMS_STATUS_STYLES, facilityLabel } from './smsStatus';
import type { SmsShipment, SmsDocument } from '@/modules/sms/types';

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

export default function SmsShipmentDetail({ shipment, documents = [] }: { shipment: SmsShipment; documents?: SmsDocument[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [tracking, setTracking] = useState(shipment.tracking_number ?? '');
  const trackingDirty = tracking.trim() !== (shipment.tracking_number ?? '');
  const fileRef = useRef<HTMLInputElement>(null);

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

  const courierControlled = shipment.status_source === 'courier';

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
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground/70">
            {courierControlled ? 'from courier tracking' : 'manual'}
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
          <Meta label="Courier" value={shipment.courier} />
          <Meta label="Supplier" value={shipment.supplier} />
          <Meta label="Ship Date" value={shipment.ship_date} />
          <Meta label="Destination" value={facilityLabel(shipment.facility)} />
          <div className="space-y-0.5">
            <div className="text-xs text-muted-foreground">Manual Status {courierControlled && <span className="text-muted-foreground/60">(fallback — courier wins)</span>}</div>
            <Select value={!courierControlled ? (shipment.status ?? '') : ''} onValueChange={(v) => v && setManualStatus(v)} disabled={busy}>
              <SelectTrigger className="h-8 w-full sm:w-44"><SelectValue placeholder={courierControlled ? 'Courier-controlled' : 'Set status'} /></SelectTrigger>
              <SelectContent>{SMS_STATUSES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent>
            </Select>
          </div>
        </div>
      </Card>

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
                <TableHead className="text-right">Units</TableHead>
                <TableHead className="text-right">Cartons</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shipment.pos.map((p) => (
                <TableRow key={p.po_number} className="border-border hover:bg-muted/30">
                  <TableCell>
                    <Link href={`/sms/purchase-orders/${encodeURIComponent(p.po_number)}`} className="text-primary hover:underline font-medium">{p.po_number}</Link>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{p.supplier ?? DASH}</TableCell>
                  <TableCell className="text-muted-foreground">Lot {p.lot_number}</TableCell>
                  <TableCell className="text-right tabular-nums">{p.units.toLocaleString()}</TableCell>
                  <TableCell className="text-right tabular-nums">{p.cartons ?? DASH}</TableCell>
                </TableRow>
              ))}
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
                        <a key={d.id} href={`${BACKEND_URL}${d.file_url}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
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
