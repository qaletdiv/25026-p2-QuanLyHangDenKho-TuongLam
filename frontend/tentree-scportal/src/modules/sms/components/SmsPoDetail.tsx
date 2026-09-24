'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { FULFILLMENT_LABELS, FULFILLMENT_STYLES, SMS_STATUS_STYLES, facilityLabel } from './smsStatus';
import type { SmsPoDetail as SmsPoDetailT } from '@/modules/sms/types';

const DASH = '—';

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
  const lineBySku = new Map(po.lines.map((l) => [l.skuCode, l]));
  const skuRows = [...rec.by_sku]
    .map((s) => ({
      ...s,
      itemName: s.itemName ?? lineBySku.get(s.skuCode)?.itemName ?? null,
      unitPrice: s.unitPrice ?? lineBySku.get(s.skuCode)?.unitPrice ?? null,
    }))
    .sort((a, b) => Math.abs(b.variance) - Math.abs(a.variance) || a.skuCode.localeCompare(b.skuCode));
  const shownSkus = showAll ? skuRows : skuRows.slice(0, 15);

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
          Line items — ordered vs shipped vs received ({skuRows.length} SKUs)
          {!rec.hasShippingData && <span className="ml-2 text-xs text-muted-foreground/70">(shipped-per-SKU appears once shipping data is uploaded on the consignment)</span>}
          {rec.shipped_vs_received_variance !== 0 && rec.received_total > 0 && (
            <span className="ml-2 text-red-600 font-semibold">shipped vs received variance: {rec.shipped_vs_received_variance.toLocaleString()}</span>
          )}
        </h2>
        <Card className="overflow-x-auto">
          <Table className="bg-card">
            <TableHeader>
              <TableRow className="bg-card/80 hover:bg-card/80">
                <TableHead>SKU</TableHead>
                <TableHead>Item</TableHead>
                <TableHead className="text-right">Unit Price</TableHead>
                <TableHead className="text-right">Ordered</TableHead>
                <TableHead className="text-right">Shipped</TableHead>
                <TableHead className="text-right">Received</TableHead>
                <TableHead className="text-right">Variance</TableHead>
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
            </TableBody>
          </Table>
        </Card>
        {skuRows.length > 15 && (
          <button onClick={() => setShowAll((v) => !v)} className="text-xs font-semibold text-primary hover:underline">
            {showAll ? 'Show top 15' : `Show all ${skuRows.length} SKUs`}
          </button>
        )}
      </section>
    </div>
  );
}
