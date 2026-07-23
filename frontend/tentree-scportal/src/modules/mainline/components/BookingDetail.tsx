'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { ArrowLeft, Check, Download, Pencil, Save, Upload, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { BACKEND_URL } from '@/lib/api';
import { approveMainlineBooking, confirmMainlineCi, updateMainlineBooking, uploadShipmentData } from '@/modules/mainline/actions';
import { useSession } from '@/components/providers/SessionProvider';
import ConfirmDialog from './ConfirmDialog';
import type { MainlineBooking, CommercialInvoice, PackingSummary, PackingByPo, MainlineDocument } from '@/modules/mainline/types';

const STATUS_STYLES: Record<string, string> = {
  'Booking Pending': 'bg-amber-500/10 text-amber-600 border-amber-500/20',
  'Booking Approved': 'bg-blue-500/10 text-blue-600 border-blue-500/20',
  'Cancelled': 'bg-red-500/10 text-red-600 border-red-500/20',
  'Rejected': 'bg-red-500/10 text-red-600 border-red-500/20',
};

const DASH = '—';

// label + value cell (mirrors the shipment detail layout)
function Cell({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div className="space-y-1">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className="text-sm">{children ?? DASH}</div>
      {hint && <div className="text-[10px] text-muted-foreground/70">{hint}</div>}
    </div>
  );
}

// unique document scopes, "Combined" first then per-PO alphabetical
const scopeOrder = (docs: MainlineDocument[]) =>
  [...new Set(docs.map((d) => d.scope))].sort((a, b) =>
    a.startsWith('Combined') ? -1 : b.startsWith('Combined') ? 1 : a.localeCompare(b));

export default function BookingDetail({
  booking, ci, packing, packingByPo, documents,
}: { booking: MainlineBooking; ci: CommercialInvoice | null; packing: PackingSummary | null; packingByPo: PackingByPo[]; documents: MainlineDocument[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [confirmApprove, setConfirmApprove] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  // Cargo Ready is seeded from the WIP leg CRD; the vendor can adjust it while the
  // booking is still pending (locked once approved — the shipment owns dates then).
  // Admin / Logistics may override it even after approval.
  const { user } = useSession();
  const isPending = booking.booking_status === 'Booking Pending';
  const isPrivileged = ['Admin', 'Logistics Coordinator'].includes(user?.role ?? '');
  const canEditCrd = isPending || isPrivileged;
  const [editingCrd, setEditingCrd] = useState(false);
  const [crd, setCrd] = useState(booking.cargo_ready_date ?? '');

  async function saveCrd() {
    setBusy(true);
    const res = await updateMainlineBooking(booking.id, { cargo_ready_date: crd || null });
    setBusy(false);
    if (res?.error) { toast.error(res.error); return; }
    setEditingCrd(false);
    toast.success('Cargo Ready updated');
    router.refresh();
  }

  async function run(fn: () => Promise<{ error?: string }>, ok: string) {
    setBusy(true);
    const res = await fn();
    setBusy(false);
    if (res?.error) { toast.error(res.error); return; }
    toast.success(ok);
    router.refresh();
  }

  async function onUpload(file: File) {
    setBusy(true);
    const res = await uploadShipmentData(booking.id, file);
    setBusy(false);
    if (res?.error) { toast.error(res.error); return; }
    toast.success(`Imported ${res.cartons} cartons → CI + packing slip generated${res.unmatched_qty ? ` · ⚠ ${res.unmatched_qty} unmatched` : ''}`);
    router.refresh();
  }

  const ciConfirmed = ci?.status === 'confirmed';

  // actual per-PO cargo, parsed from the uploaded shipment data (packing rollup)
  const hasActual = packingByPo.length > 0;
  const num = (n: number | null | undefined, dp = 0) => (n == null ? DASH : n.toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp }));
  const money = (n: number | null | undefined) => (n ? `$${num(n, 2)}` : DASH);

  return (
    <div className="p-4 md:p-6 space-y-6 max-w-4xl mx-auto">
      <ConfirmDialog
        open={confirmApprove}
        title={`Approve booking ${booking.booking_number}?`}
        description="Approving creates the shipment records for this booking (one per destination + mode) and hands them to logistics."
        confirmLabel="Approve"
        busy={busy}
        onCancel={() => setConfirmApprove(false)}
        onConfirm={async () => { await run(() => approveMainlineBooking(booking.id), 'Approved'); setConfirmApprove(false); }}
      />

      {/* ── Slim header: identity + actions ── */}
      <div>
        <Link href="/mainline/bookings" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground mb-3">
          <ArrowLeft className="w-4 h-4" /> Bookings
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{booking.booking_number}</h1>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {booking.booking_status === 'Booking Pending' && (
              <Button size="sm" disabled={busy} onClick={() => setConfirmApprove(true)}><Check className="h-4 w-4 mr-1" /> Approve</Button>
            )}
            <Button size="sm" variant="outline" disabled={busy} onClick={() => fileRef.current?.click()}>
              <Upload className="h-4 w-4 mr-1" /> {ci ? 'Re-upload Shipment Data' : 'Upload Shipment Data'}
            </Button>
            <input ref={fileRef} type="file" accept=".xlsx,.xls" className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) onUpload(f); e.target.value = ''; }} />
            {ci && !ciConfirmed && (
              <Button size="sm" variant="outline" disabled={busy} onClick={() => run(() => confirmMainlineCi(booking.id), 'CI confirmed')}><Check className="h-4 w-4 mr-1" /> Confirm CI</Button>
            )}
          </div>
        </div>
      </div>

      {/* ── Overview ── */}
      <section className="space-y-2">
        <h2 className="text-sm font-medium text-muted-foreground">Overview</h2>
        <Card className="p-4 space-y-4">
          {/* line 1 — state */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <Cell label="Status">
              <Badge variant="outline" className={cn(STATUS_STYLES[booking.booking_status || ''])}>{booking.booking_status ?? DASH}</Badge>
            </Cell>
            <Cell label="Commercial Invoice">
              {ci
                ? <Badge variant="outline" className={ciConfirmed ? 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20' : 'bg-amber-500/10 text-amber-600 border-amber-500/20'}>CI {ci.status}</Badge>
                : <span className="text-muted-foreground">No CI yet</span>}
            </Cell>
          </div>
          {/* line 2 — booking facts */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Cell label="Supplier">{booking.supplier_name ?? booking.supplier_id ?? DASH}</Cell>
            <Cell label="Mode">{booking.mode ?? DASH}</Cell>
            <Cell label="Cargo Ready" hint={isPending ? 'From WIP CRD — editable until approved' : undefined}>
              {editingCrd ? (
                <div className="flex items-center gap-1.5">
                  <Input type="date" value={crd} onChange={(e) => setCrd(e.target.value)} className="h-8 w-[9.5rem]" disabled={busy} />
                  <Button size="sm" variant="ghost" className="h-8 px-2" disabled={busy} onClick={saveCrd}><Save className="h-4 w-4" /></Button>
                  <Button size="sm" variant="ghost" className="h-8 px-2" disabled={busy} onClick={() => { setEditingCrd(false); setCrd(booking.cargo_ready_date ?? ''); }}><X className="h-4 w-4" /></Button>
                </div>
              ) : (
                <span className="inline-flex items-center gap-1.5">
                  {booking.cargo_ready_date ?? DASH}
                  {canEditCrd && (
                    <Button size="sm" variant="ghost" className="h-6 px-1.5 text-muted-foreground" title="Edit Cargo Ready" onClick={() => setEditingCrd(true)}><Pencil className="h-3.5 w-3.5" /></Button>
                  )}
                </span>
              )}
            </Cell>
            <Cell label="Booked">{booking.submitted_at ? booking.submitted_at.slice(0, 10) : DASH}</Cell>
          </div>
        </Card>
      </section>

      {/* ── Booked POs — per-PO booking estimates ── */}
      <section className="space-y-2">
        <h2 className="text-sm font-medium text-muted-foreground">Booked POs <span className="font-normal">(booking estimates)</span></h2>
        <Card className="overflow-x-auto">
          <Table className="bg-card">
            <TableHeader>
              <TableRow className="bg-card/80 hover:bg-card/80">
                <TableHead>PO</TableHead><TableHead>Mode</TableHead><TableHead className="text-right">Units</TableHead><TableHead className="text-right">Cartons</TableHead><TableHead className="text-right">Gross Wt (kg)</TableHead><TableHead className="text-right">CBM</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {booking.po_legs.map((l) => (
                <TableRow key={l.id} className="border-border hover:bg-muted/30">
                  <TableCell className="font-medium">{l.po_number ?? l.leg_id}</TableCell>
                  <TableCell>{l.mode ?? DASH}</TableCell>
                  <TableCell className="text-right tabular-nums">{(l.units ?? 0).toLocaleString()}</TableCell>
                  <TableCell className="text-right tabular-nums">{l.cartons ?? DASH}</TableCell>
                  <TableCell className="text-right tabular-nums">{l.weight_kg ?? DASH}</TableCell>
                  <TableCell className="text-right tabular-nums">{l.cbm ?? DASH}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      </section>

      {/* ── Actual booked — per-PO, parsed from the uploaded shipment data ── */}
      <section className="space-y-2">
        <h2 className="text-sm font-medium text-muted-foreground">Actual booked <span className="font-normal">(from uploaded shipment data)</span></h2>
        <Card className="overflow-x-auto">
          <Table className="bg-card">
            <TableHeader>
              <TableRow className="bg-card/80 hover:bg-card/80">
                <TableHead>PO</TableHead><TableHead className="text-right">Units</TableHead><TableHead className="text-right">Cartons</TableHead><TableHead className="text-right">Gross Wt (kg)</TableHead><TableHead className="text-right">CBM</TableHead><TableHead className="text-right">Value</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {!hasActual ? (
                <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground py-6">No shipment data uploaded yet.</TableCell></TableRow>
              ) : (
                <>
                  {packingByPo.map((r) => (
                    <TableRow key={r.leg_id ?? r.po_number} className="border-border hover:bg-muted/30">
                      <TableCell className="font-medium">{r.po_number ?? 'Unmatched'}</TableCell>
                      <TableCell className="text-right tabular-nums">{num(r.total_pcs)}</TableCell>
                      <TableCell className="text-right tabular-nums">{num(r.total_cartons)}</TableCell>
                      <TableCell className="text-right tabular-nums">{num(r.total_gross_weight, 2)}</TableCell>
                      <TableCell className="text-right tabular-nums">{num(r.total_cbm, 3)}</TableCell>
                      <TableCell className="text-right tabular-nums">{money(r.total_value)}</TableCell>
                    </TableRow>
                  ))}
                  <TableRow className="bg-card/80 font-medium border-border">
                    <TableCell>Total ({packingByPo.length} PO{packingByPo.length === 1 ? '' : 's'})</TableCell>
                    <TableCell className="text-right tabular-nums">{num(packing?.total_pcs)}</TableCell>
                    <TableCell className="text-right tabular-nums">{num(packing?.total_cartons)}</TableCell>
                    <TableCell className="text-right tabular-nums">{num(packing?.total_gross_weight, 2)}</TableCell>
                    <TableCell className="text-right tabular-nums">{num(packing?.total_cbm, 3)}</TableCell>
                    <TableCell className="text-right tabular-nums">{money(packing?.total_value)}</TableCell>
                  </TableRow>
                </>
              )}
            </TableBody>
          </Table>
        </Card>
      </section>

      {/* ── Documents ── */}
      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium text-muted-foreground">Documents</h2>
          {ci && ciConfirmed && <span className="text-xs text-muted-foreground">{ci.line_items.length} CI lines · matched {ci.total_matched_qty ?? 0} · unmatched {ci.total_unmatched_qty ?? 0}</span>}
        </div>
        <Card className="p-4">
          {documents.length === 0 ? (
            <p className="text-sm text-muted-foreground italic">No documents — upload shipment data to generate the CI &amp; packing slip.</p>
          ) : (
            <div className="space-y-1.5">
              {scopeOrder(documents).map((scope) => (
                <div key={scope} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                  <span className="w-full sm:w-44 shrink-0 text-muted-foreground">{scope}</span>
                  {documents.filter((d) => d.scope === scope).sort((a) => (a.doc_type === 'commercial_invoice' ? -1 : 1)).map((d) => (
                    <a key={d.id} href={`${BACKEND_URL}${d.file_url}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
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
