'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Package, Truck, Calendar, Info, Tag, ChevronDown, BarChart3, MapPin } from 'lucide-react';
import { toast } from 'sonner';
import LineItemsTable from './LineItemsTable';
import OrderHeader from './OrderHeader';
import {
  createPurchaseOrder, updatePurchaseOrder, deletePurchaseOrder,
  duplicatePurchaseOrder, getFulfillment, getShipmentLots,
} from '@/app/actions/purchase-orders';
import { cn } from '@/lib/utils';

export default function OrderDetail({
  po,
  suppliers = [],
  incoterms = [],
  warehouses = [],
  modes = [],
  user,
}: any) {
  const router = useRouter();
  const isNew = !po;

  const [isEditing, setIsEditing] = useState(isNew);
  const [formData, setFormData] = useState<any>(isNew ? { type: 'mainline', incoterm: 'FOB' } : { ...po });
  const [isSaving, setIsSaving] = useState(false);
  const [isLineItemsOpen, setIsLineItemsOpen] = useState(true);
  const [isFulfillmentOpen, setIsFulfillmentOpen] = useState(true);
  const [fulfillmentData, setFulfillmentData] = useState<any[]>([]);
  const [fulfillmentLoading, setFulfillmentLoading] = useState(false);
  const [lotsData, setLotsData] = useState<any>(null);
  const [lotsLoading, setLotsLoading] = useState(false);
  const [fulfillmentShowAll, setFulfillmentShowAll] = useState(false);

  const FULFILLMENT_LIMIT = 10;

  const isAdminOrLogistics = ['Admin', 'Logistics Coordinator'].includes(user?.role);
  const canEdit = isAdminOrLogistics;
  const canDelete = isAdminOrLogistics;

  useEffect(() => {
    if (po?.id) {
      setFulfillmentLoading(true);
      getFulfillment(po.id)
        .then(data => setFulfillmentData(Array.isArray(data) ? data : data?.line_items || []))
        .catch(() => setFulfillmentData([]))
        .finally(() => setFulfillmentLoading(false));

      setLotsLoading(true);
      getShipmentLots(po.id)
        .then(data => setLotsData(data))
        .catch(() => setLotsData(null))
        .finally(() => setLotsLoading(false));
    }
  }, [po?.id]);

  const handleSave = async () => {
    if (!formData.po_number) { toast.error('PO# is required'); return; }
    setIsSaving(true);
    try {
      const dataToSave = { ...formData };
      if (Array.isArray(dataToSave.line_items) && dataToSave.line_items.length > 0) {
        const sum = dataToSave.line_items.reduce((s: number, item: any) => s + (Number(item.expected_qty) || 0), 0);
        if (sum > 0) dataToSave.expected_qty = sum;
      }
      if (dataToSave.id) {
        await updatePurchaseOrder(dataToSave.id, dataToSave);
        toast.success(`PO ${dataToSave.po_number} updated.`);
        setIsEditing(false);
      } else {
        const created = await createPurchaseOrder(dataToSave);
        toast.success(`PO ${dataToSave.po_number} added.`);
        router.push(created?.id ? `/purchase-orders/${created.id}` : '/purchase-orders');
      }
    } catch {
      toast.error('Failed to save PO.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!window.confirm(`Delete PO ${formData.po_number}?`)) return;
    await deletePurchaseOrder(formData.id);
    toast.success(`PO ${formData.po_number} deleted.`);
    router.push('/purchase-orders');
  };

  const handleDuplicate = async () => {
    try {
      await duplicatePurchaseOrder(formData);
      toast.success(`PO ${formData.po_number} duplicated.`);
      router.push('/purchase-orders');
    } catch {
      toast.error('Failed to duplicate PO.');
    }
  };

  const updateField = (key: string, value: any) => {
    setFormData((prev: any) => ({ ...prev, [key]: value }));
  };

  return (
    <div className="min-h-screen flex flex-col">

      <OrderHeader
        formData={formData}
        isEditing={isEditing}
        isNew={isNew}
        isSaving={isSaving}
        canEdit={canEdit}
        canDelete={canDelete}
        onBack={() => router.push('/purchase-orders')}
        onStartEdit={() => setIsEditing(true)}
        onCancelEdit={() => setIsEditing(false)}
        onSave={handleSave}
        onDelete={handleDelete}
        onDuplicate={handleDuplicate}
        onPoNumberChange={v => updateField('po_number', v)}
      />

      {/* ── Scrollable content ───────────────────────────────────────── */}
      <div className="flex-1 py-6 px-6">
        <div className="max-w-3xl mx-auto space-y-6">

          {/* Order Details */}
          <div className="space-y-3">
            <h4 className="text-xs font-bold text-muted-foreground uppercase tracking-widest flex items-center gap-2">
              <Info className="w-4 h-4" /> Order Details
            </h4>
            <div className="bg-card p-4 rounded-xl border border-border shadow-sm space-y-4">
              <div className="grid grid-cols-3 gap-4">
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Season</Label>
                  {isEditing ? (
                    <Input value={formData.season || ''} onChange={e => updateField('season', e.target.value)} className="h-9 bg-background" />
                  ) : (
                    <div className="text-sm font-medium">{formData.season || '—'}</div>
                  )}
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">TRN No.</Label>
                  {isEditing ? (
                    <Input value={formData.trn_number || ''} onChange={e => updateField('trn_number', e.target.value)} className="h-9 bg-background font-mono" />
                  ) : (
                    <div className="text-sm font-mono">{formData.trn_number || '—'}</div>
                  )}
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Type</Label>
                  {isEditing ? (
                    <Select value={formData.type || 'mainline'} onValueChange={v => updateField('type', v)}>
                      <SelectTrigger className="h-9 bg-background"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="mainline">Mainline</SelectItem>
                        <SelectItem value="sms">SMS</SelectItem>
                      </SelectContent>
                    </Select>
                  ) : (
                    <Badge variant="outline" className="capitalize text-[10px] font-bold border-primary/20 text-primary px-1.5 h-5">
                      {formData.type || 'mainline'}
                    </Badge>
                  )}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Supplier</Label>
                  {isEditing ? (
                    <Select value={formData.supplier || ''} onValueChange={v => updateField('supplier', v)}>
                      <SelectTrigger className="h-9 bg-background"><SelectValue placeholder="Select supplier" /></SelectTrigger>
                      <SelectContent>
                        {suppliers.map((s: any) => <SelectItem key={s.id} value={s.name}>{s.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  ) : (
                    <div className="text-sm font-semibold">{formData.supplier || '—'}</div>
                  )}
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Incoterm</Label>
                  {isEditing ? (
                    <Select value={formData.incoterm || ''} onValueChange={v => updateField('incoterm', v)}>
                      <SelectTrigger className="h-9 bg-background"><SelectValue placeholder="Select incoterm" /></SelectTrigger>
                      <SelectContent>
                        {incoterms.map((i: any) => <SelectItem key={i.id} value={i.name}>{i.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  ) : (
                    <div className="text-sm font-semibold text-amber-600 dark:text-amber-400">{formData.incoterm || '—'}</div>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Logistics Details */}
          <div className="space-y-3">
            <h4 className="text-xs font-bold text-muted-foreground uppercase tracking-widest flex items-center gap-2">
              <Truck className="w-4 h-4" /> Logistics Details
            </h4>
            <div className="bg-card p-4 rounded-xl border border-border shadow-sm space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Transport Mode</Label>
                  {isEditing ? (
                    <Select value={formData.mode || ''} onValueChange={v => updateField('mode', v)}>
                      <SelectTrigger className="h-9 bg-background"><SelectValue placeholder="Select mode" /></SelectTrigger>
                      <SelectContent>
                        {modes.map((m: any) => <SelectItem key={m.id} value={m.name}>{m.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  ) : (
                    <div className="flex items-center gap-1.5 text-sm font-medium">
                      {formData.mode
                        ? <Badge variant="outline" className="font-mono">{formData.mode}</Badge>
                        : '—'}
                    </div>
                  )}
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Warehouse</Label>
                  {isEditing ? (
                    <Select value={formData.receiving_warehouse || ''} onValueChange={v => updateField('receiving_warehouse', v)}>
                      <SelectTrigger className="h-9 bg-background"><SelectValue placeholder="Select warehouse" /></SelectTrigger>
                      <SelectContent>
                        {warehouses.map((w: any) => <SelectItem key={w.id} value={w.name}>{w.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  ) : (
                    <div className="flex items-center gap-1.5 text-sm font-medium">
                      {formData.receiving_warehouse
                        ? <><MapPin className="w-3.5 h-3.5 text-muted-foreground" />{formData.receiving_warehouse}</>
                        : '—'}
                    </div>
                  )}
                </div>
              </div>
              <div className="grid grid-cols-3 gap-4">
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground flex items-center gap-1.5">
                    <Calendar className="w-3 h-3" /> CRD
                  </Label>
                  {isEditing ? (
                    <Input value={formData.etd || ''} onChange={e => updateField('etd', e.target.value)} className="h-9 bg-background" placeholder="mm/dd/yyyy" />
                  ) : (
                    <div className="text-sm font-medium">{formData.etd || '—'}</div>
                  )}
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground flex items-center gap-1.5">
                    <Calendar className="w-3 h-3" /> Exp. Recv Date
                  </Label>
                  {isEditing ? (
                    <Input value={formData.eta || ''} onChange={e => updateField('eta', e.target.value)} className="h-9 bg-background" placeholder="mm/dd/yyyy" />
                  ) : (
                    <div className="text-sm font-medium">{formData.eta || '—'}</div>
                  )}
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground flex items-center gap-1.5">
                    <Calendar className="w-3 h-3 text-emerald-500" /> Actual Recv Date
                  </Label>
                  {isEditing ? (
                    <Input
                      value={formData.actual_receive_date || ''}
                      onChange={e => updateField('actual_receive_date', e.target.value)}
                      className="h-9 bg-background border-emerald-500/30 focus:border-emerald-500"
                      placeholder="mm/dd/yyyy"
                    />
                  ) : (
                    <div className="text-sm font-bold text-emerald-600">{formData.actual_receive_date || '—'}</div>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Quantities */}
          <div className="space-y-3">
            <h4 className="text-xs font-bold text-muted-foreground uppercase tracking-widest flex items-center gap-2">
              <Package className="w-4 h-4" /> Quantities
            </h4>
            <div className="bg-card p-4 rounded-xl border border-border shadow-sm grid grid-cols-2 gap-6">
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">
                  Expected Qty
                  {Array.isArray(formData.line_items) && formData.line_items.length > 0 && (
                    <span className="ml-1.5 text-[10px] text-primary/70 font-normal normal-case">(sum of SKUs)</span>
                  )}
                </Label>
                {isEditing && !(Array.isArray(formData.line_items) && formData.line_items.length > 0) ? (
                  <Input
                    type="number"
                    value={formData.expected_qty || ''}
                    onChange={e => updateField('expected_qty', e.target.value)}
                    className="h-9 bg-background font-semibold"
                  />
                ) : (
                  <div className="text-2xl font-bold text-primary tabular-nums">
                    {Number(formData.expected_qty || 0).toLocaleString()}
                  </div>
                )}
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Receiving Qty</Label>
                {isEditing ? (
                  <Input
                    type="number"
                    value={formData.received_qty || ''}
                    onChange={e => updateField('received_qty', e.target.value)}
                    className="h-9 bg-background font-semibold"
                  />
                ) : (
                  <div className="text-2xl font-bold tabular-nums">{formData.received_qty || '0'}</div>
                )}
              </div>
            </div>
          </div>

          {/* Line Items (SKUs) */}
          <div className="space-y-3">
            <button
              type="button"
              onClick={() => setIsLineItemsOpen(prev => !prev)}
              className="w-full text-xs font-bold text-muted-foreground uppercase tracking-widest flex items-center justify-between gap-2 hover:text-foreground transition-colors"
            >
              <span className="flex items-center gap-2">
                <Tag className="w-4 h-4" /> Line Items
                {Array.isArray(formData.line_items) && formData.line_items.length > 0 && (
                  <Badge variant="secondary" className="text-[10px] font-bold px-1.5 py-0 h-4 bg-primary/10 text-primary border-none">
                    {formData.line_items.length} SKU{formData.line_items.length !== 1 ? 's' : ''}
                  </Badge>
                )}
              </span>
              <ChevronDown className={cn('w-4 h-4 transition-transform duration-200', !isLineItemsOpen && '-rotate-90')} />
            </button>

            {isLineItemsOpen && (
              <LineItemsTable
                items={formData.line_items || []}
                editable={isEditing && canEdit}
                onChange={(items) => {
                  const sum = items.reduce((s, item) => s + (Number(item.expected_qty) || 0), 0);
                  setFormData((prev: any) => ({
                    ...prev,
                    line_items: items,
                    expected_qty: sum > 0 ? sum : prev.expected_qty,
                  }));
                }}
              />
            )}
          </div>

          {/* Fulfillment */}
          {!isNew && (
            <div className="space-y-3">
              <button
                type="button"
                onClick={() => setIsFulfillmentOpen(prev => !prev)}
                className="w-full text-xs font-bold text-muted-foreground uppercase tracking-widest flex items-center justify-between gap-2 hover:text-foreground transition-colors"
              >
                <span className="flex items-center gap-2">
                  <BarChart3 className="w-4 h-4" /> Fulfillment
                  {fulfillmentData.length > 0 && (
                    <Badge variant="secondary" className="text-[10px] font-bold px-1.5 py-0 h-4 bg-primary/10 text-primary border-none">
                      {fulfillmentData.length} SKU{fulfillmentData.length !== 1 ? 's' : ''}
                    </Badge>
                  )}
                </span>
                <ChevronDown className={cn('w-4 h-4 transition-transform duration-200', !isFulfillmentOpen && '-rotate-90')} />
              </button>

              {isFulfillmentOpen && (() => {
                if (fulfillmentLoading || lotsLoading) {
                  return <p className="text-sm text-muted-foreground italic py-2 px-1">Loading…</p>;
                }
                if (fulfillmentData.length === 0) {
                  return <p className="text-sm text-muted-foreground italic py-2 px-1">No line items on this PO yet.</p>;
                }
                const lots = lotsData?.lots || [];
                const pivot = fulfillmentData.map((item: any) => ({
                  sku_code:     item.sku_code,
                  expected_qty: Number(item.expected_qty) || 0,
                  lot_shipped:  lots.map((lot: any) => {
                    const li = lot.line_items?.find((l: any) => l.sku_code === item.sku_code);
                    return li != null ? (Number(li.shipped_qty) || 0) : null;
                  }),
                  received_qty: Number(item.received_qty) || 0,
                }));
                const totalExpected = pivot.reduce((s: number, r: any) => s + r.expected_qty, 0);
                const totalReceived = pivot.reduce((s: number, r: any) => s + r.received_qty, 0);
                const visiblePivot = fulfillmentShowAll ? pivot : pivot.slice(0, FULFILLMENT_LIMIT);
                const hiddenCount = pivot.length - FULFILLMENT_LIMIT;

                return (
                  <>
                  <div className="overflow-x-auto rounded-lg border border-border">
                    <table className="text-xs bg-card" style={{ minWidth: `${260 + lots.length * 88}px` }}>
                      <thead>
                        <tr className="border-b border-border bg-card/80">
                          <th className="text-left font-semibold text-muted-foreground px-3 py-2 uppercase tracking-wider sticky left-0 bg-card/80 z-10 whitespace-nowrap">SKU</th>
                          <th className="text-right font-semibold text-muted-foreground px-3 py-2 uppercase tracking-wider whitespace-nowrap">Expected</th>
                          {lots.map((lot: any) => (
                            <th key={lot.booking_number || lot.lot_number} className="text-right font-semibold text-muted-foreground px-3 py-2 uppercase tracking-wider whitespace-nowrap">
                              {lot.lot_number != null ? `Lot ${lot.lot_number}` : 'Full'}<br />
                              <span className="text-[9px] font-mono font-normal normal-case text-primary/70">{lot.booking_number || '—'}</span>
                            </th>
                          ))}
                          <th className="text-right font-semibold text-muted-foreground px-3 py-2 uppercase tracking-wider whitespace-nowrap">
                            Received<br /><span className="text-[9px] font-normal normal-case opacity-60">NetSuite</span>
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {visiblePivot.map((row: any) => {
                          const totalShipped = row.lot_shipped.reduce((s: number, q: number | null) => s + (q ?? 0), 0);
                          const isOver = totalShipped > row.expected_qty;
                          return (
                            <tr key={row.sku_code} className={cn(
                              'border-b border-border last:border-0 transition-colors',
                              isOver ? 'bg-amber-500/10 hover:bg-amber-500/20' : 'hover:bg-muted/30'
                            )}>
                              <td className="px-3 py-2 font-mono font-semibold text-primary sticky left-0 bg-inherit z-10 whitespace-nowrap">{row.sku_code}</td>
                              <td className="px-3 py-2 text-right font-semibold tabular-nums">{row.expected_qty.toLocaleString()}</td>
                              {row.lot_shipped.map((qty: number | null, i: number) => (
                                <td key={i} className={cn('px-3 py-2 text-right tabular-nums',
                                  qty != null && qty > 0 ? 'text-foreground' : 'text-muted-foreground'
                                )}>
                                  {qty !== null ? qty.toLocaleString() : <span className="opacity-30">—</span>}
                                </td>
                              ))}
                              <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                                {row.received_qty > 0 ? row.received_qty.toLocaleString() : <span className="opacity-30">—</span>}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                      <tfoot>
                        <tr className="border-t border-border bg-card">
                          <td className="px-3 py-2 text-xs font-bold text-muted-foreground uppercase tracking-wider sticky left-0 bg-card">Total</td>
                          <td className="px-3 py-2 text-right text-sm font-bold text-primary tabular-nums">{totalExpected.toLocaleString()}</td>
                          {lots.map((lot: any, i: number) => {
                            const lotTotal = pivot.reduce((s: number, r: any) => s + (r.lot_shipped[i] ?? 0), 0);
                            return (
                              <td key={lot.booking_number || lot.lot_number} className="px-3 py-2 text-right font-bold tabular-nums">
                                {lotTotal > 0 ? lotTotal.toLocaleString() : <span className="opacity-30">—</span>}
                              </td>
                            );
                          })}
                          <td className="px-3 py-2 text-right text-sm font-bold tabular-nums text-muted-foreground">
                            {totalReceived > 0 ? totalReceived.toLocaleString() : <span className="opacity-30">—</span>}
                          </td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                  {hiddenCount > 0 && (
                    <div className="flex items-center gap-2 pt-1">
                      <button
                        type="button"
                        onClick={() => setFulfillmentShowAll(v => !v)}
                        className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                      >
                        {fulfillmentShowAll ? 'Collapse' : `View ${hiddenCount} more SKU${hiddenCount !== 1 ? 's' : ''}`}
                      </button>
                    </div>
                  )}
                  </>
                );
              })()}
            </div>
          )}

          {/* Bottom spacer */}
          <div className="h-8" />

        </div>
      </div>
    </div>
  );
}
