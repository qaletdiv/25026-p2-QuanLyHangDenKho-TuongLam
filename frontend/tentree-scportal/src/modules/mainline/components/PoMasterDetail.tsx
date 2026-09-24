'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';
import ApprovalBadge from './ApprovalBadge';
import type { PoMasterDetail as PoMasterDetailT, OrderIntent, Fulfillment, MainlineLifecycle } from '@/modules/mainline/types';

const DASH = '—';

const LIFECYCLE_STYLES: Record<MainlineLifecycle, string> = {
  forecast: 'bg-slate-500/10 text-slate-600 border-slate-500/20',
  partial: 'bg-amber-500/10 text-amber-600 border-amber-500/20',
  split: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20',
};

export default function PoMasterDetail({
  master, intent, fulfillment, modeMap,
}: { master: PoMasterDetailT; intent: OrderIntent | null; fulfillment: Fulfillment | null; modeMap: Record<string, string> }) {
  const router = useRouter();
  const [showAllFulfillment, setShowAllFulfillment] = useState(false);
  const fRows = fulfillment?.fulfillment ?? [];
  const visibleRows = showAllFulfillment ? fRows : fRows.slice(0, 10);
  return (
    <div className="p-4 md:p-6 space-y-6 max-w-5xl mx-auto">
      <div>
        <Link href="/mainline/purchase-orders" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground mb-3">
          <ArrowLeft className="w-4 h-4" /> Purchase Orders
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{master.trnNumber}</h1>
          {master.bookable && <Badge variant="outline" className="bg-emerald-500/10 text-emerald-600 border-emerald-500/20">bookable</Badge>}
        </div>
        <p className="text-sm text-muted-foreground mt-1">
          {master.supplier ?? master.supplierId ?? DASH}
        </p>
        <p className="text-sm text-muted-foreground mt-1">
          {master.season}
        </p>
      </div>

      {/* Three-way match */}
      <section className="space-y-2">
        <Card className="overflow-x-auto">
          <Table className="bg-card">
            <TableHeader>
              <TableRow className="bg-card/80 hover:bg-card/80">
                <TableHead>SKU</TableHead>
                <TableHead className="text-right">Ordered</TableHead>
                <TableHead className="text-right">Allocated</TableHead>
                <TableHead className="text-right">Shipped</TableHead>
                <TableHead className="text-right">Received</TableHead>
                <TableHead className="text-right">Remaining</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {!fulfillment || fRows.length === 0 ? (
                <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground py-6">No fulfillment data</TableCell></TableRow>
              ) : (
                <>
                  {visibleRows.map((r) => (
                    <TableRow key={r.skuCode} className="border-border hover:bg-muted/30">
                      <TableCell className="font-mono text-xs">{r.skuCode}</TableCell>
                      <TableCell className="text-right tabular-nums">{r.orderedQty.toLocaleString()}</TableCell>
                      <TableCell className="text-right tabular-nums">{r.allocatedQty.toLocaleString()}</TableCell>
                      <TableCell className="text-right tabular-nums">{r.shippedQty.toLocaleString()}</TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">{r.receivedQty.toLocaleString()}</TableCell>
                      <TableCell className={cn('text-right tabular-nums', r.remainingQty > 0 ? 'text-amber-600' : 'text-emerald-600')}>{r.remainingQty.toLocaleString()}</TableCell>
                    </TableRow>
                  ))}
                  <TableRow className="bg-card/80 font-medium">
                    <TableCell>Total ({fulfillment.skuCount} SKUs)</TableCell>
                    <TableCell className="text-right tabular-nums">{fulfillment.totals.orderedQty.toLocaleString()}</TableCell>
                    <TableCell className="text-right tabular-nums">{fulfillment.totals.allocatedQty.toLocaleString()}</TableCell>
                    <TableCell className="text-right tabular-nums">{fulfillment.totals.shippedQty.toLocaleString()}</TableCell>
                    <TableCell className="text-right tabular-nums">{fulfillment.totals.receivedQty.toLocaleString()}</TableCell>
                    <TableCell />
                  </TableRow>
                </>
              )}
            </TableBody>
          </Table>
        </Card>
        {fRows.length > 10 && (
          <button
            onClick={() => setShowAllFulfillment((v) => !v)}
            className="text-sm text-primary hover:underline"
          >
            {showAllFulfillment ? 'Collapse' : `View ${fRows.length - 10} more`}
          </button>
        )}
      </section>

      {/* Orders → legs */}
      <section className="space-y-2">
        <h2 className="text-sm font-medium text-muted-foreground">Air/Sea Split</h2>
        <Card className="overflow-x-auto">
          <Table className="bg-card">
            <TableHeader>
              <TableRow className="bg-card/80 hover:bg-card/80">
                <TableHead>PO</TableHead>
                <TableHead>NetSuite ID</TableHead>
                <TableHead>Destination</TableHead>
                <TableHead>Channel</TableHead>
                <TableHead>Mode</TableHead>
                <TableHead>CRD</TableHead>
                <TableHead className="text-right">SKUs</TableHead>
                <TableHead className="text-right">Units</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {master.orders.flatMap((o) =>
                o.legs.length > 0
                  ? o.legs.map((leg) => (
                      <TableRow
                        key={leg.id}
                        className="border-border hover:bg-muted/30 cursor-pointer"
                        onClick={() => router.push(`/mainline/purchase-orders/${encodeURIComponent(master.trnNumber)}/${leg.id}`)}
                      >
                        <TableCell className="font-medium">
                          {/* a TRN can mix approved and unapproved POs, so the badge
                              belongs per PO row, not on the TRN header */}
                          <span className="inline-flex items-center gap-2">
                            {o.poNumber}<ApprovalBadge status={o.approvalStatus} />
                          </span>
                        </TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground">{o.netsuiteId ?? DASH}</TableCell>
                        <TableCell className="text-muted-foreground">{o.destinationFacility ?? DASH}</TableCell>
                        <TableCell className="text-muted-foreground">{o.allocationChannel ?? DASH}</TableCell>
                        <TableCell>{leg.mode || modeMap[leg.modeId || ''] || leg.modeId || DASH}</TableCell>
                        <TableCell className="text-muted-foreground">{leg.crd ?? DASH}</TableCell>
                        <TableCell className="text-right tabular-nums">{leg.leg_lines?.length ?? 0}</TableCell>
                        <TableCell className="text-right tabular-nums">{(leg.expectedQty ?? 0).toLocaleString()}</TableCell>
                      </TableRow>
                    ))
                  : [
                      <TableRow key={o.poNumber} className="border-border hover:bg-muted/30">
                        <TableCell className="font-medium">
                          {/* a TRN can mix approved and unapproved POs, so the badge
                              belongs per PO row, not on the TRN header */}
                          <span className="inline-flex items-center gap-2">
                            {o.poNumber}<ApprovalBadge status={o.approvalStatus} />
                          </span>
                        </TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground">{o.netsuiteId ?? DASH}</TableCell>
                        <TableCell className="text-muted-foreground">{o.destinationFacility ?? DASH}</TableCell>
                        <TableCell className="text-muted-foreground">{o.allocationChannel ?? DASH}</TableCell>
                        <TableCell colSpan={4} className="italic text-muted-foreground">forecast — not split into air/sea yet ({o.order_lines.length} SKU line{o.order_lines.length === 1 ? '' : 's'})</TableCell>
                      </TableRow>,
                    ]
              )}
            </TableBody>
          </Table>
        </Card>
      </section>
    </div>
  );
}
