'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, CalendarPlus } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';
import ApprovalBadge from './ApprovalBadge';
import type { PoLegDetail as PoLegDetailT, PoReconcile, LegShipment } from '@/modules/mainline/types';

const DASH = '—';
// Same palette as ShipmentsTable / ShipmentDetail so one status reads identically
// wherever it appears.
const STATUS_STYLES: Record<string, string> = {
  'Ready to Ship': 'bg-blue-500/10 text-blue-600 border-blue-500/20',
  'In Transit': 'bg-violet-500/10 text-violet-600 border-violet-500/20',
  'At Port': 'bg-cyan-500/10 text-cyan-600 border-cyan-500/20',
  'Delivered': 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20',
  'Received': 'bg-emerald-600/10 text-emerald-700 border-emerald-600/20',
  'Cancelled': 'bg-red-500/10 text-red-600 border-red-500/20',
};

function Meta({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="space-y-0.5">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-sm font-medium">{value ?? '—'}</div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <Card className="p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold tabular-nums">{value.toLocaleString()}</div>
    </Card>
  );
}

// Variance is RECEIVED − SHIPPED, so `over` is the warehouse booking in more than
// the packing list said and `short` is less. 'any' is the common case — "just show
// me what doesn't tie out" — and is offered first for that reason.
type VarianceFilter = 'all' | 'any' | 'over' | 'short';
const VARIANCE_LABEL: Record<VarianceFilter, string> = {
  all: 'All',
  any: 'Discrepancies',
  over: 'Over-received',
  short: 'Short',
};

// One PO leg (air/sea split): the SKUs the vendor must produce + the component-PO
// reconcile (ordered vs shipped vs received, from NetSuite Item Receipts).
export default function PoLegDetail({ leg, reconcile, shipments = [] }: { leg: PoLegDetailT; reconcile: PoReconcile | null; shipments?: LegShipment[] }) {
  const router = useRouter();
  const [showAll, setShowAll] = useState(false);
  const itemBySku = new Map(leg.line_items.map((li) => [li.skuCode, li]));
  const recRows = reconcile?.fulfillment ?? [];

  // Reconcile-table filters, in the header itself. This table runs to hundreds of
  // SKUs (385 on TRN_1267) and the question asked of it is almost always "which
  // ones are off?" — which previously meant reading every row.
  const [skuQuery, setSkuQuery] = useState('');
  const [varianceFilter, setVarianceFilter] = useState<VarianceFilter>('all');
  const recFiltering = skuQuery.trim() !== '' || varianceFilter !== 'all';

  const filteredRec = useMemo(() => {
    const q = skuQuery.trim().toLowerCase();
    return recRows.filter((r) => {
      // match the item name too — staff search by style as often as by SKU
      if (q && !`${r.skuCode} ${itemBySku.get(r.skuCode)?.itemName ?? ''}`.toLowerCase().includes(q)) return false;
      if (varianceFilter === 'any' && r.variance === 0) return false;
      if (varianceFilter === 'over' && r.variance <= 0) return false;
      if (varianceFilter === 'short' && r.variance >= 0) return false;
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recRows, skuQuery, varianceFilter]);

  // A filter IS a request to see the matches — all of them. Capping a filtered
  // result at 15 would hide the very rows the user narrowed down to.
  const shownRec = recFiltering || showAll ? filteredRec : filteredRec.slice(0, 15);

  // Totals are of the rows ON SCREEN — `shownRec`, not `reconcile.totals` and not
  // the full filtered set. A footer summing 374 SKUs under a body showing 15 is
  // read as the total of those 15 and is wrong; that holds for the top-15 cap just
  // as much as for a filter. The whole-leg figures are still one glance away in
  // the Stat cards above, which are deliberately NOT filtered.
  const recTotals = useMemo(() => shownRec.reduce((t, r) => ({
    allocatedQty: t.allocatedQty + r.allocatedQty,
    shippedQty: t.shippedQty + r.shippedQty,
    receivedQty: t.receivedQty + r.receivedQty,
  }), { allocatedQty: 0, shippedQty: 0, receivedQty: 0 }), [shownRec]);

  const shown = showAll ? leg.line_items : leg.line_items.slice(0, 15);
  return (
    <div className="p-4 md:p-6 space-y-6 max-w-5xl mx-auto">
      <div>
        <Link
          href={leg.trnNumber ? `/mainline/purchase-orders/${encodeURIComponent(leg.trnNumber)}` : '/mainline/purchase-orders'}
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground mb-3"
        >
          <ArrowLeft className="w-4 h-4" /> {leg.trnNumber ?? 'Purchase Orders'}
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{leg.poNumber}</h1>
          {/* Next to the title, where "Book Now" is: this is the page you book
              from, so the fact that NetSuite hasn't approved the PO belongs in the
              same glance as the button. */}
          <ApprovalBadge status={leg.approvalStatus} />
          {leg.supplierId && (
            <Button
              size="sm"
              className="ml-auto"
              title="Open a new booking for this supplier"
              onClick={() => router.push(`/mainline/bookings?new=${encodeURIComponent(leg.supplierId!)}`)}
            >
              <CalendarPlus className="h-4 w-4 mr-1.5" /> Book Now
            </Button>
          )}
        </div>
        <p className="text-sm text-muted-foreground mt-1">
          {leg.supplier ?? '—'}
        </p>
      </div>

      <Card className="p-4">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Meta label="NetSuite ID" value={leg.netsuiteId} />
          <Meta label="Season" value={leg.season} />
          <Meta label="Mode" value={leg.mode} />
          <Meta label="Destination" value={leg.destinationFacility} />
          <Meta label="Allocation Channel" value={leg.allocationChannel} />
          <Meta label="COO" value={leg.coo} />
          <Meta label="Incoterm" value={leg.incoterm} />
          {/* CARGO READY — the supplier's date, from WIP, and a PLAN: it moves
              earlier and later. The Shipments table below shows "Received at Port",
              which is a different EVENT (the forwarder has the cargo), 0–32 days
              later on live rows. These were once labelled "CRD (target)" and
              "CRD (actual)", which read as two measurements of one date. */}
          <Meta label="Cargo Ready" value={leg.crd} />
          <Meta label="E-DEL" value={leg.eDel} />
        </div>
      </Card>

      {/* ── consignments carrying this leg (lots) ──
          Mirrors the SMS PO detail's lot table. Quantities are the SHIPPED actuals
          from the shipping-data upload, so this agrees with the commercial invoice
          rather than with the booked quantity. */}
      <section className="space-y-2">
        <h2 className="text-sm font-medium text-muted-foreground">
          Shipments ({shipments.length} lot{shipments.length === 1 ? '' : 's'})
        </h2>
        <Card className="overflow-x-auto">
          <Table className="bg-card">
            <TableHeader>
              <TableRow className="bg-card/80 hover:bg-card/80">
                <TableHead>Lot</TableHead>
                <TableHead>Carrier Shipment #</TableHead>
                <TableHead>Received at Port</TableHead>
                <TableHead className="text-right">Shipped Qty</TableHead>
                <TableHead className="text-right">Received Qty</TableHead>
                <TableHead className="text-right">Shipped Cartons</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shipments.length === 0 ? (
                <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground py-8">Not shipped yet — a shipment appears here once the booking for this leg is approved.</TableCell></TableRow>
              ) : shipments.map((s) => (
                <TableRow key={`${s.shipmentId}-${s.lotNumber}`} className="border-border hover:bg-muted/30">
                  {/* The lot carries the link, not the carrier ref — the ref is blank on
                      more than half the live rows and the row must stay navigable. */}
                  <TableCell className="font-medium">
                    <Link href={`/mainline/shipments/${s.shipmentId}`} className="text-primary hover:underline">
                      Lot {s.lotNumber ?? DASH}
                    </Link>
                    {s.shipmentNumber && <span className="ml-1.5 text-[10px] uppercase tracking-wider text-muted-foreground/70">{s.shipmentNumber}</span>}
                  </TableCell>
                  {/* Blank when the forwarder hasn't given a reference. No fallback to
                      BL or SHP-N: a substitute here would read as a carrier ref. */}
                  <TableCell className="font-mono text-xs">{s.carrier_shipment_number ?? DASH}</TableCell>
                  <TableCell className="text-muted-foreground">{s.crd_actual ?? DASH}</TableCell>
                  <TableCell className="text-right tabular-nums">{s.shippedQty != null ? s.shippedQty.toLocaleString() : DASH}</TableCell>
                  {/* Amber only when BOTH figures exist and disagree — this is the
                      cell that says which lot the leg-level discrepancy came from.
                      A missing receipt is not a discrepancy, it is "not yet". */}
                  <TableCell
                    className={cn('text-right tabular-nums',
                      s.receivedQty != null && s.shippedQty != null && s.receivedQty !== s.shippedQty && 'text-amber-600 font-medium')}
                    title={s.receivedQty == null ? 'No Item Receipt attributed to this lot yet'
                      : `${s.received_ir ?? 'Item Receipt'}${s.receivedDate ? ` · ${s.receivedDate}` : ''}${s.receivedConfirmed ? '' : ' · match not confirmed'}`}
                  >
                    {s.receivedQty != null ? s.receivedQty.toLocaleString() : DASH}
                    {/* An unconfirmed attribution is a suggestion, so the number is
                        marked rather than presented as settled. */}
                    {s.receivedQty != null && !s.receivedConfirmed && <span className="ml-0.5 text-muted-foreground">*</span>}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{s.shippedCartons != null ? s.shippedCartons.toLocaleString() : DASH}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className={cn(STATUS_STYLES[s.status || ''])}>{s.status ?? DASH}</Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      </section>

      {recRows.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-medium text-muted-foreground">{leg.poNumber}{leg.mode ? ` · ${leg.mode}` : ''} — allocated vs shipped vs received <span className="font-normal">(this leg)</span></h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Stat label="Allocated" value={reconcile!.totals.allocatedQty} />
            <Stat label="Shipped" value={reconcile!.totals.shippedQty} />
            <Stat label="Received" value={reconcile!.totals.receivedQty} />
            {/* Σ of the rows' own `remainingQty`, NOT allocated − shipped: the
                backend floors shipped at received per SKU, and recomputing it here
                from the totals would put a different number on the card than the
                table under it. */}
            <Stat label="Remaining" value={recRows.reduce((t, r) => t + r.remainingQty, 0)} />
          </div>
          <Card className="overflow-x-auto">
            <Table className="bg-card">
              <TableHeader>
                {/* The SKU and Variance headers ARE their filters — one row, no
                    separate filter strip. Each control shows the column name while
                    it is unset and the active filter once it is, so the header
                    always reads as both the label and the current state. */}
                <TableRow className="bg-card/80 hover:bg-card/80">
                  <TableHead className="py-1.5">
                    <Input
                      value={skuQuery}
                      onChange={(e) => setSkuQuery(e.target.value)}
                      placeholder="SKU"
                      title="Filter by SKU or item name"
                      aria-label="Filter by SKU or item name"
                      className="h-7 w-full text-xs font-medium placeholder:font-medium placeholder:text-foreground"
                    />
                  </TableHead>
                  <TableHead>Item</TableHead>
                  <TableHead className="text-right">Allocated</TableHead>
                  <TableHead className="text-right">Shipped</TableHead>
                  <TableHead className="text-right">Received</TableHead>
                  <TableHead className="py-1.5">
                    <Select value={varianceFilter} onValueChange={(v) => setVarianceFilter((v as VarianceFilter) ?? 'all')}>
                      {/* Label rendered directly — <SelectValue> can't derive one
                          when the value is set programmatically (see CLAUDE.md).
                          Unset reads "Variance", the column name. */}
                      <SelectTrigger
                        title="Filter by variance"
                        className={cn('h-7 w-full text-xs font-medium', varianceFilter !== 'all' && 'text-primary')}
                      >
                        {varianceFilter === 'all' ? 'Variance' : VARIANCE_LABEL[varianceFilter]}
                      </SelectTrigger>
                      <SelectContent>
                        {(Object.keys(VARIANCE_LABEL) as VarianceFilter[]).map((k) => (
                          <SelectItem key={k} value={k}>{VARIANCE_LABEL[k]}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {shownRec.map((r) => (
                  <TableRow key={r.skuCode} className="border-border hover:bg-muted/30">
                    <TableCell className="font-mono text-xs">{r.skuCode}</TableCell>
                    <TableCell>{itemBySku.get(r.skuCode)?.itemName ?? '—'}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.allocatedQty.toLocaleString()}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.shippedQty ? r.shippedQty.toLocaleString() : '—'}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.receivedQty.toLocaleString()}</TableCell>
                    <TableCell className={cn('text-right tabular-nums', r.variance !== 0 && r.receivedQty > 0 && 'text-amber-600 font-medium')}>
                      {r.variance === 0 ? '—' : r.variance.toLocaleString()}
                    </TableCell>
                  </TableRow>
                ))}
                {filteredRec.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={6} className="py-6 text-center text-sm text-muted-foreground">
                      No SKU matches this filter.
                    </TableCell>
                  </TableRow>
                )}
                <TableRow className="bg-card/80 font-medium">
                  <TableCell colSpan={2}>
                    {/* "of N" whenever the body is a subset — filtered OR capped at
                        the top 15 — so the number above can never be mistaken for
                        the leg total. */}
                    Total ({shownRec.length === recRows.length ? recRows.length : `${shownRec.length} of ${recRows.length}`} SKUs)
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{recTotals.allocatedQty.toLocaleString()}</TableCell>
                  <TableCell className="text-right tabular-nums">{recTotals.shippedQty.toLocaleString()}</TableCell>
                  <TableCell className="text-right tabular-nums">{recTotals.receivedQty.toLocaleString()}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {recTotals.receivedQty - recTotals.shippedQty === 0
                      ? DASH
                      : (recTotals.receivedQty - recTotals.shippedQty).toLocaleString()}
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </Card>
          {/* Hidden while filtering: the filter already shows every match, so the
              toggle would claim to expand a list that is not truncated. */}
          {!recFiltering && recRows.length > 15 && (
            <button onClick={() => setShowAll((v) => !v)} className="text-xs font-semibold text-primary hover:underline">
              {showAll ? 'Show top 15' : `Show all ${recRows.length} SKUs`}
            </button>
          )}
        </section>
      )}

      {recRows.length === 0 && (
      <section className="space-y-2">
        <h2 className="text-sm font-medium text-muted-foreground">Line items to produce</h2>
        <Card className="overflow-x-auto">
          <Table className="bg-card">
            <TableHeader>
              <TableRow className="bg-card/80 hover:bg-card/80">
                <TableHead>SKU</TableHead>
                <TableHead>Item</TableHead>
                <TableHead>Colorway</TableHead>
                <TableHead>Size</TableHead>
                <TableHead className="text-right">Qty</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {leg.line_items.length === 0 ? (
                <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground py-8">No line items on this leg.</TableCell></TableRow>
              ) : (
                <>
                  {shown.map((li) => (
                    <TableRow key={li.skuCode} className="border-border hover:bg-muted/30">
                      <TableCell className="font-mono text-xs">{li.skuCode}</TableCell>
                      <TableCell>{li.itemName ?? li.description ?? '—'}</TableCell>
                      <TableCell className="text-muted-foreground">{li.colorway ?? '—'}</TableCell>
                      <TableCell className="text-muted-foreground">{li.size ?? '—'}</TableCell>
                      <TableCell className="text-right tabular-nums">{li.allocatedQty.toLocaleString()}</TableCell>
                    </TableRow>
                  ))}
                  <TableRow className="bg-card/80 font-medium">
                    <TableCell colSpan={4}>Total ({leg.skuCount} SKUs)</TableCell>
                    <TableCell className="text-right tabular-nums">{leg.expectedQty.toLocaleString()}</TableCell>
                  </TableRow>
                </>
              )}
            </TableBody>
          </Table>
        </Card>
        {leg.line_items.length > 15 && (
          <button onClick={() => setShowAll((v) => !v)} className="text-xs font-semibold text-primary hover:underline">
            {showAll ? 'Show top 15' : `Show all ${leg.line_items.length} SKUs`}
          </button>
        )}
      </section>
      )}
    </div>
  );
}
