'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { FULFILLMENT_LABELS, FULFILLMENT_STYLES, SMS_STATUS_STYLES, facilityLabel } from './smsStatus';
import type { SmsPoDetail as SmsPoDetailT } from '@/modules/sms/types';

const DASH = '—';

// Variance is RECEIVED − SHIPPED in BOTH modules as of 2026-09-28 — SMS used to
// compute it the other way round, so these predicates agree with the identical
// control in mainline's PoLegDetail and the two pages can be read as one. `over`
// is the warehouse booking in more than the packing list said, `short` is less.
// 'any' is the common case — "just show me what doesn't tie out" — and is offered
// first for that reason.
type VarianceFilter = 'all' | 'any' | 'over' | 'short';
const VARIANCE_LABEL: Record<VarianceFilter, string> = {
  all: 'All',
  any: 'Discrepancies',
  over: 'Over-received',
  short: 'Short',
};
const VARIANCE_MATCH: Record<VarianceFilter, (v: number) => boolean> = {
  all: () => true,
  any: (v) => v !== 0,
  over: (v) => v > 0,
  short: (v) => v < 0,
};

function Meta({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="space-y-0.5">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-sm font-medium">{value ?? DASH}</div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: 'red' }) {
  return (
    <Card className="p-4">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={cn('text-2xl font-semibold tabular-nums mt-1', tone === 'red' && value !== 0 && 'text-red-600')}>{value.toLocaleString()}</div>
    </Card>
  );
}

export default function SmsPoDetail({ po }: { po: SmsPoDetailT }) {
  const [showAll, setShowAll] = useState(false);
  const rec = po.reconciliation;
  // one line-item view: reconciliation (ordered/shipped/received/variance) already
  // carries item name + unit price (server-enriched — populated even for SKUs that
  // were shipped but never ordered on this PO). Fall back to the order line if the
  // server value is somehow absent. Variance rows first — that's what logistics needs.
  // Memoised so it keeps its identity across keystrokes in the SKU filter below —
  // otherwise this map+sort re-runs on every character AND hands `filteredSkus` a
  // fresh array each time, making that memo a no-op.
  const skuRows = useMemo(() => {
    const lineBySku = new Map(po.lines.map((l) => [l.skuCode, l]));
    return [...rec.by_sku]
      .map((s) => ({
        ...s,
        itemName: s.itemName ?? lineBySku.get(s.skuCode)?.itemName ?? null,
        unitPrice: s.unitPrice ?? lineBySku.get(s.skuCode)?.unitPrice ?? null,
      }))
      .sort((a, b) => Math.abs(b.variance) - Math.abs(a.variance) || a.skuCode.localeCompare(b.skuCode));
  }, [po.lines, rec.by_sku]);

  // Filters live IN the table header, same as the mainline leg detail: this table
  // runs to hundreds of SKUs and the question asked of it is almost always "which
  // ones are off?", which otherwise means reading every row.
  const [skuQuery, setSkuQuery] = useState('');
  const [varianceFilter, setVarianceFilter] = useState<VarianceFilter>('all');
  const filtering = skuQuery.trim() !== '' || varianceFilter !== 'all';

  const filteredSkus = useMemo(() => {
    const q = skuQuery.trim().toLowerCase();
    return skuRows.filter((s) => {
      // match the item name too — staff search by style as often as by SKU
      if (q && !`${s.skuCode} ${s.itemName ?? ''}`.toLowerCase().includes(q)) return false;
      return VARIANCE_MATCH[varianceFilter](s.variance);
    });
  }, [skuRows, skuQuery, varianceFilter]);

  // A filter IS a request to see the matches — all of them. Capping a filtered
  // result at 15 would hide the very rows the user just narrowed down to.
  const shownSkus = filtering || showAll ? filteredSkus : filteredSkus.slice(0, 15);

  return (
    <div className="p-4 md:p-6 space-y-6 max-w-5xl mx-auto">
      <div>
        <Link href="/sms/purchase-orders" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground mb-3">
          <ArrowLeft className="w-4 h-4" /> SMS Purchase Orders
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{po.poNumber}</h1>
          <Badge variant="outline" className={cn(FULFILLMENT_STYLES[po.fulfillment])}>{FULFILLMENT_LABELS[po.fulfillment]}</Badge>
          {po.approvalStatus && <Badge variant="outline" className="text-muted-foreground">{po.approvalStatus}</Badge>}
        </div>
        <p className="text-sm text-muted-foreground mt-1">{po.supplier ?? DASH}</p>
      </div>

      <Card className="p-4">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Meta label="tentree PO" value={po.trnNumber} />
          <Meta label="Season" value={po.season} />
          <Meta label="HOD (handover date)" value={po.hod} />
          <Meta label="Expected Receive Date" value={po.expectedReceivedDate} />
          <Meta label="Ship Method" value={po.shipMethod} />
          <Meta label="Destination" value={facilityLabel(po.facility)} />
          <Meta label="Channel" value={po.allocationChannel} />
          <Meta label="NetSuite ID" value={po.netsuiteId} />
        </div>
      </Card>

      {/* ── rollups (derived) ── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Stat label="Ordered" value={rec.ordered_total} />
        <Stat label="Shipped" value={rec.shipped_total} />
        <Stat label="Received" value={rec.received_total} />
        <Stat label="Remaining to Ship" value={rec.remaining_to_ship} tone="red" />
      </div>

      {/* ── consignments (lots) ── */}
      <section className="space-y-2">
        <h2 className="text-sm font-medium text-muted-foreground">Shipments ({po.consignments.length} lot{po.consignments.length === 1 ? '' : 's'})</h2>
        <Card className="overflow-x-auto">
          <Table className="bg-card">
            <TableHeader>
              <TableRow className="bg-card/80 hover:bg-card/80">
                <TableHead>Lot</TableHead>
                <TableHead>Tracking #</TableHead>
                <TableHead>Ship Date</TableHead>
                <TableHead className="text-right">Units</TableHead>
                <TableHead className="text-right">Cartons</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {po.consignments.length === 0 ? (
                <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground py-8">Not shipped yet — the vendor enters shipments under SMS Shipments.</TableCell></TableRow>
              ) : po.consignments.map((c) => (
                <TableRow key={`${c.shipmentId}-${c.lotNumber}`} className="border-border hover:bg-muted/30">
                  <TableCell className="font-medium">Lot {c.lotNumber}</TableCell>
                  <TableCell>
                    <Link href={`/sms/shipments/${c.shipmentId}`} className="text-primary hover:underline">{c.trackingNumber || `Shipment ${c.shipmentId}`}</Link>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{c.shipDate ?? DASH}</TableCell>
                  <TableCell className="text-right tabular-nums">{c.units.toLocaleString()}</TableCell>
                  <TableCell className="text-right tabular-nums">{c.cartons ?? DASH}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className={cn(SMS_STATUS_STYLES[c.status || ''])}>{c.status ?? DASH}</Badge>
                    {c.statusSource === 'manual' && <span className="ml-1.5 text-[10px] uppercase tracking-wider text-muted-foreground/70">manual</span>}
                    {/* Received = an Item Receipt exists in NetSuite for this lot */}
                    {c.statusSource === 'netsuite' && c.receivedDate && (
                      <span className="ml-1.5 text-[10px] uppercase tracking-wider text-muted-foreground/70">{c.receivedDate}</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      </section>

      {/* ── line items + reconciliation (one table) ── */}
      <section className="space-y-2">
        <h2 className="text-sm font-medium text-muted-foreground">
          {/* "N of M" whenever the body is a subset — from a filter OR the top-15
              cap — so the count can never be read as the PO's SKU total. There is
              deliberately no totals row on this table; the whole-PO figures are the
              Stat cards above, which are NOT filtered. */}
          Line items — ordered vs shipped vs received ({shownSkus.length === skuRows.length ? `${skuRows.length} SKUs` : `${shownSkus.length} of ${skuRows.length} SKUs`})
          {!rec.hasShippingData && <span className="ml-2 text-xs text-muted-foreground/70">(shipped-per-SKU appears once shipping data is uploaded on the consignment)</span>}
          {rec.received_vs_shipped_variance !== 0 && rec.received_total > 0 && (
            <span className="ml-2 text-red-600 font-semibold">received vs shipped variance: {rec.received_vs_shipped_variance.toLocaleString()}</span>
          )}
        </h2>
        <Card className="overflow-x-auto">
          <Table className="bg-card">
            <TableHeader>
              {/* The SKU and Variance headers ARE their filters — one row, no
                  separate filter strip. Each control shows the column name while it
                  is unset and the active filter once it is, so the header always
                  reads as both the label and the current state. */}
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
                <TableHead className="text-right">Unit Price</TableHead>
                <TableHead className="text-right">Ordered</TableHead>
                <TableHead className="text-right">Shipped</TableHead>
                <TableHead className="text-right">Received</TableHead>
                <TableHead className="py-1.5">
                  <Select value={varianceFilter} onValueChange={(v) => setVarianceFilter((v as VarianceFilter) ?? 'all')}>
                    {/* Label rendered directly — <SelectValue> can't derive one when
                        the value is set programmatically (see CLAUDE.md). Unset
                        reads "Variance", the column name. */}
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
              {shownSkus.map((s) => (
                <TableRow key={s.skuCode} className={cn('border-border hover:bg-muted/30', s.variance !== 0 && s.receivedQty > 0 && 'bg-amber-500/10')}>
                  <TableCell className="font-mono text-xs">{s.skuCode}</TableCell>
                  <TableCell>{s.itemName ?? DASH}</TableCell>
                  <TableCell className="text-right tabular-nums">{s.unitPrice != null ? `$${s.unitPrice.toFixed(2)}` : DASH}</TableCell>
                  <TableCell className="text-right tabular-nums">{s.orderedQty.toLocaleString()}</TableCell>
                  <TableCell className="text-right tabular-nums">{s.shippedQty ? s.shippedQty.toLocaleString() : '—'}</TableCell>
                  <TableCell className="text-right tabular-nums">{s.receivedQty.toLocaleString()}</TableCell>
                  <TableCell className={cn('text-right tabular-nums', s.variance !== 0 && s.receivedQty > 0 && 'text-red-600 font-semibold')}>
                    {s.variance === 0 ? '—' : s.variance.toLocaleString()}
                  </TableCell>
                </TableRow>
              ))}
              {filteredSkus.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="py-6 text-center text-sm text-muted-foreground">
                    No SKU matches this filter.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </Card>
        {/* Hidden while filtering: the filter already shows every match, so the
            toggle would offer to expand a list that is not truncated. */}
        {!filtering && skuRows.length > 15 && (
          <button onClick={() => setShowAll((v) => !v)} className="text-xs font-semibold text-primary hover:underline">
            {showAll ? 'Show top 15' : `Show all ${skuRows.length} SKUs`}
          </button>
        )}
      </section>
    </div>
  );
}
