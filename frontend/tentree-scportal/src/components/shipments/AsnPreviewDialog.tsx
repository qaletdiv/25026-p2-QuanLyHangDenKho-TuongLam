'use client';

import React, { useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Send, RefreshCw, Package, MapPin, Calendar, Truck, User, FileText, Hash, AlertTriangle, Info } from 'lucide-react';
import { cn } from '@/lib/utils';
import { getWarehouses } from '@/app/actions/master-data';

interface AsnPreviewDialogProps {
  open: boolean;
  onClose: () => void;
  /** Primary shipment row — contains commercial_invoice, supplier, destination, ETD, etc. */
  shipmentRow: any;
  /** Full group for multi-PO bookings (to list all PO numbers) */
  group?: any[];
  /** Called when user confirms and clicks Send */
  onConfirm: (e: React.MouseEvent) => void;
  isSending?: boolean;
}

export default function AsnPreviewDialog({
  open,
  onClose,
  shipmentRow,
  group,
  onConfirm,
  isSending = false,
}: AsnPreviewDialogProps) {
  const [warehouseEmail, setWarehouseEmail] = useState('');
  const [warehousesLoading, setWarehousesLoading] = useState(false);

  // Load warehouse email on open
  useEffect(() => {
    if (!open) return;
    setWarehouseEmail('');
    setWarehousesLoading(true);

    const warehouseName =
      shipmentRow?.receiving_warehouse || shipmentRow?.destination_warehouse || '';

    getWarehouses()
      .then((data: any) => {
        const list = Array.isArray(data) ? data : [];
        const match = list.find(
          (w: any) => w.name && w.name.toLowerCase() === warehouseName.toLowerCase()
        );
        setWarehouseEmail(match?.email ?? '');
      })
      .catch(() => setWarehouseEmail(''))
      .finally(() => setWarehousesLoading(false));
  }, [open, shipmentRow?.receiving_warehouse, shipmentRow?.destination_warehouse]);

  const row = shipmentRow || {};

  // Collect all PO numbers — from group rows or fall back to single row
  const poNumbers: string[] = group
    ? [...new Set(group.map((r: any) => r.po_number).filter(Boolean))]
    : row.po_number
    ? [row.po_number]
    : [];

  // CI data comes directly from the shipment row — no async fetch needed
  const ci = row.commercial_invoice;

  // Packing list: matched items only, financial fields (unit_price, total) are intentionally excluded
  const matchedItems: any[] = Array.isArray(ci?.line_items)
    ? ci.line_items.filter((i: any) => i.match_status === 'matched')
    : [];

  const totalQty    = matchedItems.reduce((s, i) => s + (Number(i.qty)       || 0), 0);
  const totalWeight = matchedItems.reduce((s, i) => s + (Number(i.weight_kg) || 0), 0);
  const totalCbm    = matchedItems.reduce((s, i) => s + (Number(i.cbm)       || 0), 0);

  // Send is enabled whenever there are matched items — not blocked by warehouse loading
  const canSend = matchedItems.length > 0 && !isSending;

  return (
    <Dialog open={open} onOpenChange={v => !v && onClose()}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <Send className="w-4 h-4 text-emerald-600" />
            ASN Preview — {row.booking_number || '—'}
          </DialogTitle>
          <p className="text-xs text-muted-foreground mt-0.5">
            Review shipment details and packing list before sending to warehouse
          </p>
        </DialogHeader>

        {/* ── Section 1: Shipment Details ── */}
        <div className="space-y-1.5">
          <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
            Shipment Details
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-4 py-3 px-4 rounded-lg border border-border bg-muted/10">
            <InfoField
              icon={<Package className="w-3.5 h-3.5" />}
              label="Booking #"
              value={row.booking_number || '—'}
            />
            <InfoField
              icon={<User className="w-3.5 h-3.5" />}
              label="Supplier"
              value={row.vendor_name || row.supplier || '—'}
            />
            <InfoField
              icon={<FileText className="w-3.5 h-3.5" />}
              label="PO Number(s)"
              value={poNumbers.length ? poNumbers.join(', ') : '—'}
            />
            <InfoField
              icon={<MapPin className="w-3.5 h-3.5" />}
              label="Destination"
              value={row.receiving_warehouse || row.destination_warehouse || '—'}
            />
            <InfoField
              icon={<Truck className="w-3.5 h-3.5" />}
              label="Mode"
              value={row.mode || '—'}
            />
            <InfoField
              icon={<Calendar className="w-3.5 h-3.5" />}
              label="ETD"
              value={row.etd || '—'}
            />
            <InfoField
              icon={<Calendar className="w-3.5 h-3.5" />}
              label="ETA"
              value={row.eta || '—'}
            />
            <InfoField
              icon={<Hash className="w-3.5 h-3.5" />}
              label="Tracking #"
              value={row.tracking_number || '—'}
            />
            <InfoField
              icon={<Package className="w-3.5 h-3.5" />}
              label="No. of Cartons"
              value={row.number_of_cartons != null ? String(row.number_of_cartons) : '—'}
            />
            <InfoField
              icon={<Package className="w-3.5 h-3.5" />}
              label="Total Units"
              value={
                row.expected_qty != null
                  ? Number(row.expected_qty).toLocaleString()
                  : totalQty > 0
                  ? totalQty.toLocaleString()
                  : '—'
              }
            />
          </div>
        </div>

        {/* ── Section 2: To — Warehouse Email ── */}
        <div className="space-y-2">
          <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
            To: Warehouse
          </p>
          <div className="space-y-1.5">
            <Label htmlFor="warehouse-email" className="text-xs text-muted-foreground">
              Recipient Email
            </Label>
            {warehousesLoading ? (
              <div className="h-9 w-full rounded-md bg-muted/40 animate-pulse" />
            ) : (
              <Input
                id="warehouse-email"
                type="email"
                placeholder="warehouse@example.com"
                value={warehouseEmail}
                onChange={e => setWarehouseEmail(e.target.value)}
                className="text-sm"
              />
            )}
            <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <Info className="w-3 h-3 shrink-0" />
              Email delivery will be enabled in a future release
            </p>
          </div>
        </div>

        {/* ── Section 3: Packing List ── */}
        <div className="space-y-2">
          <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
            Packing List — Matched SKUs only
          </p>

          {matchedItems.length === 0 ? (
            <div className="flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/20 px-3 py-3 text-sm text-amber-700 dark:text-amber-400">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              No matched CI line items found
            </div>
          ) : (
            <>
              {/* Summary line */}
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <Badge variant="secondary" className="text-xs font-normal">
                  {matchedItems.length} SKU{matchedItems.length !== 1 ? 's' : ''}
                </Badge>
                <span>{totalQty.toLocaleString()} units</span>
                <span className="text-border">·</span>
                <span>{totalWeight.toLocaleString()} kg</span>
                <span className="text-border">·</span>
                <span>{totalCbm.toFixed(1)} CBM</span>
              </div>

              {/* Table */}
              <div className="rounded-lg border border-border overflow-hidden">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-muted/40 border-b border-border">
                      <th className="text-left font-semibold text-muted-foreground px-3 py-2 uppercase tracking-wider">
                        SKU Code
                      </th>
                      <th className="text-left font-semibold text-muted-foreground px-3 py-2 uppercase tracking-wider">
                        Description
                      </th>
                      <th className="text-right font-semibold text-muted-foreground px-3 py-2 uppercase tracking-wider">
                        Qty
                      </th>
                      <th className="text-right font-semibold text-muted-foreground px-3 py-2 uppercase tracking-wider">
                        Weight (kg)
                      </th>
                      <th className="text-right font-semibold text-muted-foreground px-3 py-2 uppercase tracking-wider">
                        CBM
                      </th>
                      <th className="text-left font-semibold text-muted-foreground px-3 py-2 uppercase tracking-wider">
                        PO Number
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {matchedItems.map((item: any, idx: number) => (
                      <tr
                        key={item.sku_code || idx}
                        className="border-b border-border/40 last:border-0 hover:bg-muted/20 transition-colors"
                      >
                        <td className="px-3 py-2 font-mono font-semibold text-primary">
                          {item.sku_code || '—'}
                        </td>
                        <td className="px-3 py-2 text-foreground max-w-[200px] truncate">
                          {item.description || '—'}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums font-semibold">
                          {Number(item.qty || 0).toLocaleString()}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {Number(item.weight_kg || 0).toLocaleString()}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {Number(item.cbm || 0).toFixed(3)}
                        </td>
                        <td className="px-3 py-2 font-mono text-muted-foreground">
                          {item.matched_po || '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className={cn('border-t border-border font-semibold', 'bg-muted/30')}>
                      <td
                        className="px-3 py-2 text-muted-foreground uppercase text-[10px] tracking-wider"
                        colSpan={2}
                      >
                        Total
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {totalQty.toLocaleString()}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {totalWeight.toLocaleString()}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {totalCbm.toFixed(3)}
                      </td>
                      <td />
                    </tr>
                  </tfoot>
                </table>
              </div>
            </>
          )}
        </div>

        {/* ── Footer note ── */}
        <div className="flex items-start gap-2 rounded-md bg-muted/40 border border-border/60 px-3 py-2.5 text-xs text-muted-foreground">
          <Send className="w-3.5 h-3.5 mt-0.5 shrink-0 text-emerald-600" />
          <span>
            Clicking <strong>Send ASN</strong> will generate the packing list Excel and mark this
            shipment as sent.
          </span>
        </div>

        <DialogFooter className="gap-2 mt-1">
          <Button variant="ghost" onClick={onClose} disabled={isSending}>
            Cancel
          </Button>
          <Button
            onClick={onConfirm}
            disabled={!canSend}
            className="gap-2 bg-emerald-600 hover:bg-emerald-700 text-white"
          >
            {isSending ? (
              <>
                <RefreshCw className="w-3.5 h-3.5 animate-spin" /> Sending…
              </>
            ) : (
              <>
                <Send className="w-3.5 h-3.5" /> Send ASN
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function InfoField({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="flex items-center gap-1 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
        {icon}
        {label}
      </span>
      <span className={cn('text-sm font-medium', value === '—' ? 'text-muted-foreground/60' : 'text-foreground')}>
        {value}
      </span>
    </div>
  );
}
