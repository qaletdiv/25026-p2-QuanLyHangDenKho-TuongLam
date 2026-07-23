'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, CalendarPlus } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';
import type { PoLegDetail as PoLegDetailT, PoReconcile } from '@/modules/mainline/types';

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

// One PO leg (air/sea split): the SKUs the vendor must produce + the component-PO
// reconcile (ordered vs shipped vs received, from NetSuite Item Receipts).
export default function PoLegDetail({ leg, reconcile }: { leg: PoLegDetailT; reconcile: PoReconcile | null }) {
  const router = useRouter();
  const [showAll, setShowAll] = useState(false);
  const itemBySku = new Map(leg.line_items.map((li) => [li.sku_code, li]));
  const recRows = reconcile?.fulfillment ?? [];
  const shownRec = showAll ? recRows : recRows.slice(0, 15);
  const shown = showAll ? leg.line_items : leg.line_items.slice(0, 15);
  return (
    <div className="p-4 md:p-6 space-y-6 max-w-5xl mx-auto">
      <div>
        <Link
          href={leg.trn_number ? `/mainline/purchase-orders/${encodeURIComponent(leg.trn_number)}` : '/mainline/purchase-orders'}
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground mb-3"
        >
          <ArrowLeft className="w-4 h-4" /> {leg.trn_number ?? 'Purchase Orders'}
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{leg.po_number}</h1>
          {leg.supplier_id && (
            <Button
              size="sm"
              className="ml-auto"
              title="Open a new booking for this supplier"
              onClick={() => router.push(`/mainline/bookings?new=${encodeURIComponent(leg.supplier_id!)}`)}
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
          <Meta label="NetSuite ID" value={leg.netsuite_id} />
          <Meta label="Season" value={leg.season} />
          <Meta label="Mode" value={leg.mode} />
          <Meta label="Destination" value={leg.destination_facility} />
          <Meta label="Allocation Channel" value={leg.allocation_channel} />
          <Meta label="COO" value={leg.coo} />
          <Meta label="Incoterm" value={leg.incoterm} />
          <Meta label="CRD" value={leg.crd} />
          <Meta label="E-DEL" value={leg.e_del} />
        </div>
      </Card>

      {recRows.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-medium text-muted-foreground">{leg.po_number} — ordered vs shipped vs received</h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Stat label="Ordered" value={reconcile!.totals.ordered_qty} />
            <Stat label="Shipped" value={reconcile!.totals.shipped_qty} />
            <Stat label="Received" value={reconcile!.totals.received_qty} />
            <Stat label="Remaining" value={reconcile!.totals.ordered_qty - reconcile!.totals.shipped_qty} />
          </div>
          <Card className="overflow-x-auto">
            <Table className="bg-card">
              <TableHeader>
                <TableRow className="bg-card/80 hover:bg-card/80">
                  <TableHead>SKU</TableHead>
                  <TableHead>Item</TableHead>
                  <TableHead className="text-right">Ordered</TableHead>
                  <TableHead className="text-right">Shipped</TableHead>
                  <TableHead className="text-right">Received</TableHead>
                  <TableHead className="text-right">Variance</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {shownRec.map((r) => (
                  <TableRow key={r.sku_code} className="border-border hover:bg-muted/30">
                    <TableCell className="font-mono text-xs">{r.sku_code}</TableCell>
                    <TableCell>{itemBySku.get(r.sku_code)?.item_name ?? '—'}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.ordered_qty.toLocaleString()}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.shipped_qty ? r.shipped_qty.toLocaleString() : '—'}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.received_qty.toLocaleString()}</TableCell>
                    <TableCell className={cn('text-right tabular-nums', r.variance !== 0 && r.received_qty > 0 && 'text-amber-600 font-medium')}>
                      {r.variance === 0 ? '—' : r.variance.toLocaleString()}
                    </TableCell>
                  </TableRow>
                ))}
                <TableRow className="bg-card/80 font-medium">
                  <TableCell colSpan={2}>Total ({recRows.length} SKUs)</TableCell>
                  <TableCell className="text-right tabular-nums">{reconcile!.totals.ordered_qty.toLocaleString()}</TableCell>
                  <TableCell className="text-right tabular-nums">{reconcile!.totals.shipped_qty.toLocaleString()}</TableCell>
                  <TableCell className="text-right tabular-nums">{reconcile!.totals.received_qty.toLocaleString()}</TableCell>
                  <TableCell />
                </TableRow>
              </TableBody>
            </Table>
          </Card>
          {recRows.length > 15 && (
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
                    <TableRow key={li.sku_code} className="border-border hover:bg-muted/30">
                      <TableCell className="font-mono text-xs">{li.sku_code}</TableCell>
                      <TableCell>{li.item_name ?? li.description ?? '—'}</TableCell>
                      <TableCell className="text-muted-foreground">{li.colorway ?? '—'}</TableCell>
                      <TableCell className="text-muted-foreground">{li.size ?? '—'}</TableCell>
                      <TableCell className="text-right tabular-nums">{li.allocated_qty.toLocaleString()}</TableCell>
                    </TableRow>
                  ))}
                  <TableRow className="bg-card/80 font-medium">
                    <TableCell colSpan={4}>Total ({leg.sku_count} SKUs)</TableCell>
                    <TableCell className="text-right tabular-nums">{leg.expected_qty.toLocaleString()}</TableCell>
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
