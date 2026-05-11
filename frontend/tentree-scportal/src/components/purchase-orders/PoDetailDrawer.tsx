'use client';

import React, { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { X, Save, Edit3, Trash2, Copy, Package, Building2, Layers, Truck, MapPin, Calendar, Info, Briefcase, Tag, ChevronDown, ChevronRight, BarChart3, Ship } from 'lucide-react';
import { toast } from 'sonner';
import LineItemsTable from './LineItemsTable';
import { getFulfillment, getShipmentLots } from '@/app/actions/purchase-orders';
import { cn } from '@/lib/utils';

export default function PoDetailDrawer({
  open,
  onClose,
  onSave,
  onDelete,
  onDuplicate,
  suppliers = [],
  incoterms = [],
  warehouses = [],
  modes = [],
  isLoading: isGlobalLoading = false,
  user
}: any) {
  const [isEditing, setIsEditing] = useState(false);
  const [formData, setFormData] = useState<any>({});
  const [isSaving, setIsSaving] = useState(false);
  const [isLineItemsOpen, setIsLineItemsOpen] = useState(true);
  const [isFulfillmentOpen, setIsFulfillmentOpen] = useState(false);
  const [fulfillmentData, setFulfillmentData] = useState<any[]>([]);
  const [fulfillmentLoading, setFulfillmentLoading] = useState(false);
  const [isLotsOpen, setIsLotsOpen] = useState(false);
  const [lotsData, setLotsData] = useState<any>(null);
  const [lotsLoading, setLotsLoading] = useState(false);
  const [expandedLots, setExpandedLots] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (open) {
      setFormData(open === true ? { type: 'mainline', incoterm: 'FOB' } : { ...open });
      setIsEditing(open === true);
      // Fetch fulfillment and shipment lots for existing POs
      if (open !== true && open.id) {
        setFulfillmentLoading(true);
        getFulfillment(open.id)
          .then(data => setFulfillmentData(Array.isArray(data) ? data : data?.line_items || []))
          .catch(() => setFulfillmentData([]))
          .finally(() => setFulfillmentLoading(false));
        setLotsLoading(true);
        getShipmentLots(open.id)
          .then(data => setLotsData(data))
          .catch(() => setLotsData(null))
          .finally(() => setLotsLoading(false));
      } else {
        setFulfillmentData([]);
        setLotsData(null);
      }
      setExpandedLots(new Set());
    }
  }, [open]);

  if (!open) return null;

  const handleSave = async () => {
    if (!formData.po_number) {
      toast.error('PO# is required');
      return;
    }
    setIsSaving(true);
    try {
      const dataToSave = { ...formData };
      // Auto-compute expected_qty from line_items if they exist
      if (Array.isArray(dataToSave.line_items) && dataToSave.line_items.length > 0) {
        const sum = dataToSave.line_items.reduce((s: number, item: any) => s + (Number(item.expected_qty) || 0), 0);
        if (sum > 0) dataToSave.expected_qty = sum;
      }
      await onSave(dataToSave);
      setIsEditing(false);
      onClose();
    } catch {
      // error displayed by parent via toast
    } finally {
      setIsSaving(false);
    }
  };

  const updateField = (key: string, value: any) => {
    setFormData((prev: any) => ({ ...prev, [key]: value }));
  };

  const isNew = open === true || !open.id;
  const isAdminOrLogistics = ['Admin', 'Logistics Coordinator'].includes(user?.role);
  const canEdit = isAdminOrLogistics;
  const canDelete = isAdminOrLogistics;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 sm:p-6 animate-in fade-in duration-200" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="w-full max-w-lg bg-card rounded-xl shadow-2xl border border-border overflow-hidden flex flex-col max-h-[90vh] animate-in zoom-in-95 duration-200">
        
        {/* Header Section - CONSISTENT WITH SHIPMENTS/BOOKINGS */}
        <div className="bg-muted/30 border-b border-border p-6 space-y-4 flex-shrink-0">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Badge variant="secondary" className="px-3 py-1 text-xs font-bold uppercase tracking-widest bg-primary/10 text-primary border-none">
                {formData.booking_status || 'No Booking'}
              </Badge>
              {formData.booking_number && (
                <span className="text-xs font-mono font-semibold text-muted-foreground">{formData.booking_number}</span>
              )}
            </div>
            
            <div className="flex items-center gap-1">
              {!isEditing ? (
                <>
                  <Button variant="ghost" size="sm" onClick={() => onDuplicate(formData)} className="h-8 w-8 p-0 text-muted-foreground hover:text-primary">
                    <Copy className="w-4 h-4" />
                  </Button>
                  {canDelete && (
                    <Button variant="ghost" size="sm" onClick={() => onDelete(formData)} className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive">
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  )}
                  {canEdit && (
                    <Button variant="ghost" size="sm" onClick={() => setIsEditing(true)} className="h-8 gap-2 text-primary hover:text-primary hover:bg-primary/10 px-2 ml-1">
                      <Edit3 className="w-4 h-4" /> Edit
                    </Button>
                  )}
                </>
              ) : (
                <div className="flex gap-2">
                  <Button variant="ghost" size="sm" onClick={() => setIsEditing(false)} className="h-8 w-8 p-0">
                    <X className="w-4 h-4" />
                  </Button>
                  <Button size="sm" onClick={handleSave} disabled={isSaving || isGlobalLoading} className="h-8 gap-1.5 px-3">
                    <Save className="w-4 h-4" /> Save
                  </Button>
                </div>
              )}
              <Button variant="ghost" size="icon" onClick={onClose} className="rounded-full ml-2">
                <X className="w-5 h-5" />
              </Button>
            </div>
          </div>
          
          <div className="flex items-start justify-between">
            <div>
              <h2 className="text-2xl font-bold flex items-center gap-2">
                <Package className="w-6 h-6 text-muted-foreground" />
                {isEditing ? (
                  <Input 
                    value={formData.po_number || ''} 
                    onChange={e => updateField('po_number', e.target.value)}
                    className="h-8 bg-background border-primary/20 focus:border-primary w-40"
                    placeholder="PO#"
                  />
                ) : (
                  formData.po_number || 'New PO'
                )}
              </h2>
              <div className="flex flex-col gap-1 mt-1.5">
                <p className="text-base flex items-center gap-2 text-muted-foreground font-medium">
                  <Building2 className="w-4 h-4" /> {formData.supplier || 'Unassigned'}
                </p>
                <div className="flex items-center gap-3 text-xs text-muted-foreground font-medium">
                  <span className="flex items-center gap-1.5 uppercase tracking-wider">
                    <Layers className="w-3.5 h-3.5" /> {formData.season || 'TBD'}
                  </span>
                  <span className="w-1 h-1 rounded-full bg-border" />
                  <span className="font-bold text-primary uppercase">{formData.type || 'Mainline'}</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Content Section */}
        <div className="flex-1 overflow-y-auto p-6 space-y-8">
          
          {/* Order Details */}
          <div className="space-y-4">
            <h4 className="text-xs font-bold text-muted-foreground uppercase tracking-widest flex items-center gap-2">
              <Info className="w-4 h-4" /> Order Details
            </h4>
            <div className="bg-muted/20 p-4 rounded-xl border border-border/50 space-y-4">
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
                      <SelectTrigger className="h-9 bg-background"><SelectValue placeholder="Select" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="mainline">Mainline</SelectItem>
                        <SelectItem value="sms">SMS</SelectItem>
                      </SelectContent>
                    </Select>
                  ) : (
                    <Badge variant="outline" className="capitalize text-[10px] font-bold bg-muted/50 border-primary/20 text-primary px-1 h-5">
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
                      <SelectTrigger className="h-9 bg-background"><SelectValue placeholder="Select" /></SelectTrigger>
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
                      <SelectTrigger className="h-9 bg-background"><SelectValue placeholder="Select" /></SelectTrigger>
                      <SelectContent>
                        {incoterms.map((i: any) => <SelectItem key={i.id} value={i.name}>{i.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  ) : (
                    <div className="text-sm font-medium">{formData.incoterm || '—'}</div>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Logistics */}
          <div className="space-y-4">
            <h4 className="text-xs font-bold text-muted-foreground uppercase tracking-widest flex items-center gap-2">
              <Truck className="w-4 h-4" /> Logistics Details
            </h4>
            <div className="bg-muted/20 p-4 rounded-xl border border-border/50 space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Transport Mode</Label>
                  {isEditing ? (
                    <Select value={formData.mode || ''} onValueChange={v => updateField('mode', v)}>
                      <SelectTrigger className="h-9 bg-background"><SelectValue placeholder="Select" /></SelectTrigger>
                      <SelectContent>
                        {modes.map((m: any) => <SelectItem key={m.id} value={m.name}>{m.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  ) : (
                    <div className="text-sm font-medium">{formData.mode || '—'}</div>
                  )}
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Warehouse</Label>
                  {isEditing ? (
                    <Select value={formData.receiving_warehouse || ''} onValueChange={v => updateField('receiving_warehouse', v)}>
                      <SelectTrigger className="h-9 bg-background"><SelectValue placeholder="Select" /></SelectTrigger>
                      <SelectContent>
                        {warehouses.map((w: any) => <SelectItem key={w.id} value={w.name}>{w.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  ) : (
                    <div className="text-sm font-medium">{formData.receiving_warehouse || '—'}</div>
                  )}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground flex items-center gap-1.5">
                    <Calendar className="w-3 h-3" /> CRD
                  </Label>
                  {isEditing ? (
                    <Input value={formData.etd || ''} onChange={e => updateField('etd', e.target.value)} className="h-9 bg-background" placeholder="mm/dd/yyyy" />
                  ) : (
                    <div className="text-sm">{formData.etd || '—'}</div>
                  )}
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground flex items-center gap-1.5">
                    <Calendar className="w-3 h-3" /> Exp. Recv Date
                  </Label>
                  {isEditing ? (
                    <Input value={formData.eta || ''} onChange={e => updateField('eta', e.target.value)} className="h-9 bg-background" placeholder="mm/dd/yyyy" />
                  ) : (
                    <div className="text-sm">{formData.eta || '—'}</div>
                  )}
                </div>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground flex items-center gap-1.5">
                  <Calendar className="w-3 h-3 text-emerald-500" /> Actual Receive Date
                </Label>
                {isEditing ? (
                  <Input value={formData.actual_receive_date || ''} onChange={e => updateField('actual_receive_date', e.target.value)} className="h-9 bg-background border-emerald-500/20 focus:border-emerald-500" placeholder="mm/dd/yyyy" />
                ) : (
                  <div className="text-sm font-bold text-emerald-600">{formData.actual_receive_date || '—'}</div>
                )}
              </div>
            </div>
          </div>

          {/* Quantities */}
          <div className="space-y-4">
            <h4 className="text-xs font-bold text-muted-foreground uppercase tracking-widest flex items-center gap-2">
              <Package className="w-4 h-4" /> Quantities
            </h4>
            <div className="bg-muted/20 p-4 rounded-xl border border-border/50 grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">
                  Expected Qty
                  {Array.isArray(formData.line_items) && formData.line_items.length > 0 && (
                    <span className="ml-1.5 text-[10px] text-primary/70 font-normal normal-case">(sum of SKUs)</span>
                  )}
                </Label>
                {isEditing && !(Array.isArray(formData.line_items) && formData.line_items.length > 0) ? (
                  <Input type="number" value={formData.expected_qty || ''} onChange={e => updateField('expected_qty', e.target.value)} className="h-9 bg-background font-semibold" />
                ) : (
                  <div className="text-lg font-bold text-primary">{Number(formData.expected_qty || 0).toLocaleString()}</div>
                )}
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Receiving Qty</Label>
                {isEditing ? (
                  <Input type="number" value={formData.received_qty || ''} onChange={e => updateField('received_qty', e.target.value)} className="h-9 bg-background font-semibold" />
                ) : (
                  <div className="text-lg font-bold">{formData.received_qty || '0'}</div>
                )}
              </div>
            </div>
          </div>

          {/* Line Items (SKUs) */}
          <div className="space-y-4">
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
              <ChevronDown className={`w-4 h-4 transition-transform duration-200 ${isLineItemsOpen ? '' : '-rotate-90'}`} />
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
          {/* Shipment Lots */}
          {!isNew && (
          <div className="space-y-4">
            <button
              type="button"
              onClick={() => setIsLotsOpen(prev => !prev)}
              className="w-full text-xs font-bold text-muted-foreground uppercase tracking-widest flex items-center justify-between gap-2 hover:text-foreground transition-colors"
            >
              <span className="flex items-center gap-2">
                <Ship className="w-4 h-4" /> Shipment Lots
                {lotsData?.lots?.length > 0 && (
                  <Badge variant="secondary" className="text-[10px] font-bold px-1.5 py-0 h-4 bg-primary/10 text-primary border-none">
                    {lotsData.lots.length}
                  </Badge>
                )}
              </span>
              <ChevronDown className={`w-4 h-4 transition-transform duration-200 ${isLotsOpen ? '' : '-rotate-90'}`} />
            </button>

            {isLotsOpen && (
              <div className="space-y-3">
                {lotsLoading ? (
                  <p className="text-sm text-muted-foreground italic py-2 px-1">Loading shipment lots...</p>
                ) : !lotsData || !lotsData.lots || lotsData.lots.length === 0 ? (
                  <p className="text-sm text-muted-foreground italic py-2 px-1">No shipment lots found.</p>
                ) : (
                  <>
                    {/* Summary bar */}
                    <div className="grid grid-cols-3 gap-3">
                      <div className="bg-muted/30 rounded-lg px-3 py-2 text-center border border-border/50">
                        <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">Total PO Qty</p>
                        <p className="text-sm font-bold text-primary tabular-nums">{Number(lotsData.expected_qty || 0).toLocaleString()}</p>
                      </div>
                      <div className="bg-muted/30 rounded-lg px-3 py-2 text-center border border-border/50">
                        <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">Booked</p>
                        <p className="text-sm font-bold tabular-nums">
                          {lotsData.lots.reduce((s: number, l: any) => s + (Number(l.booked_qty) || 0), 0).toLocaleString()}
                        </p>
                      </div>
                      <div className="bg-muted/30 rounded-lg px-3 py-2 text-center border border-border/50">
                        <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">Remaining</p>
                        <p className={cn("text-sm font-bold tabular-nums", Number(lotsData.remaining_qty || 0) <= 0 ? "text-emerald-600" : "text-amber-600")}>
                          {Number(lotsData.remaining_qty || 0).toLocaleString()}
                        </p>
                      </div>
                    </div>

                    {/* Lot table */}
                    <div className="overflow-x-auto rounded-lg border border-border/50">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="border-b border-border/50 bg-muted/30">
                            <th className="w-6 px-1 py-2" />
                            <th className="text-left font-semibold text-muted-foreground px-3 py-2 uppercase tracking-wider">Lot #</th>
                            <th className="text-left font-semibold text-muted-foreground px-3 py-2 uppercase tracking-wider">Booking #</th>
                            <th className="text-right font-semibold text-muted-foreground px-3 py-2 uppercase tracking-wider">Qty</th>
                            <th className="text-left font-semibold text-muted-foreground px-3 py-2 uppercase tracking-wider">Status</th>
                            <th className="text-left font-semibold text-muted-foreground px-3 py-2 uppercase tracking-wider">CI</th>
                          </tr>
                        </thead>
                        <tbody>
                          {lotsData.lots.map((lot: any) => {
                            const lotKey = lot.shipment_id || lot.booking_number;
                            const isLotExpanded = expandedLots.has(lotKey);
                            const hasLineItems = Array.isArray(lot.line_items) && lot.line_items.length > 0;
                            return (
                              <React.Fragment key={lotKey}>
                                <tr className="border-b border-border/30 last:border-0 hover:bg-muted/10 transition-colors">
                                  <td className="px-1 py-2">
                                    {hasLineItems && (
                                      <button
                                        type="button"
                                        onClick={() => setExpandedLots(prev => {
                                          const next = new Set(prev);
                                          if (next.has(lotKey)) next.delete(lotKey);
                                          else next.add(lotKey);
                                          return next;
                                        })}
                                        className="w-5 h-5 flex items-center justify-center rounded text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors"
                                      >
                                        {isLotExpanded
                                          ? <ChevronDown className="w-3 h-3" />
                                          : <ChevronRight className="w-3 h-3" />
                                        }
                                      </button>
                                    )}
                                  </td>
                                  <td className="px-3 py-2 font-semibold">
                                    {lot.lot_number != null ? (
                                      <Badge variant="outline" className="text-[9px] font-bold px-1.5 py-0 bg-amber-500/10 border-amber-500/30 text-amber-700">
                                        Lot {lot.lot_number}
                                      </Badge>
                                    ) : (
                                      <Badge variant="outline" className="text-[9px] font-bold px-1.5 py-0 bg-emerald-500/10 border-emerald-500/30 text-emerald-700">
                                        Full
                                      </Badge>
                                    )}
                                  </td>
                                  <td className="px-3 py-2 font-mono font-semibold text-primary">{lot.booking_number || '—'}</td>
                                  <td className="px-3 py-2 text-right font-semibold tabular-nums">{Number(lot.booked_qty || 0).toLocaleString()}</td>
                                  <td className="px-3 py-2">
                                    <Badge variant="outline" className="text-[9px] font-bold px-1.5 py-0">{lot.status || '—'}</Badge>
                                  </td>
                                  <td className="px-3 py-2">
                                    {lot.ci_status === 'confirmed' ? (
                                      <Badge variant="outline" className="text-[9px] font-bold px-1.5 py-0 bg-emerald-500/10 border-emerald-500/30 text-emerald-700">Confirmed</Badge>
                                    ) : lot.ci_status ? (
                                      <Badge variant="outline" className="text-[9px] font-bold px-1.5 py-0 bg-amber-500/10 border-amber-500/30 text-amber-700">{lot.ci_status}</Badge>
                                    ) : (
                                      <span className="text-muted-foreground">—</span>
                                    )}
                                  </td>
                                </tr>
                                {isLotExpanded && hasLineItems && (
                                  <tr className="bg-muted/5">
                                    <td colSpan={6} className="px-6 py-2">
                                      <table className="w-full text-[11px]">
                                        <thead>
                                          <tr className="text-muted-foreground border-b border-border/30">
                                            <th className="text-left font-semibold px-2 py-1 uppercase tracking-wider">SKU</th>
                                            <th className="text-right font-semibold px-2 py-1 uppercase tracking-wider">Expected</th>
                                            <th className="text-right font-semibold px-2 py-1 uppercase tracking-wider">Shipped</th>
                                          </tr>
                                        </thead>
                                        <tbody>
                                          {lot.line_items.map((item: any, idx: number) => (
                                            <tr key={item.sku_code || idx} className="border-b border-border/20 last:border-0">
                                              <td className="px-2 py-1 font-mono font-semibold text-primary">{item.sku_code}</td>
                                              <td className="px-2 py-1 text-right tabular-nums">{Number(item.expected_qty || 0).toLocaleString()}</td>
                                              <td className="px-2 py-1 text-right tabular-nums">{Number(item.shipped_qty || 0).toLocaleString()}</td>
                                            </tr>
                                          ))}
                                        </tbody>
                                      </table>
                                    </td>
                                  </tr>
                                )}
                              </React.Fragment>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
          )}

          {/* Fulfillment */}
          {!isNew && (
          <div className="space-y-4">
            <button
              type="button"
              onClick={() => setIsFulfillmentOpen(prev => !prev)}
              className="w-full text-xs font-bold text-muted-foreground uppercase tracking-widest flex items-center justify-between gap-2 hover:text-foreground transition-colors"
            >
              <span className="flex items-center gap-2">
                <BarChart3 className="w-4 h-4" /> Fulfillment
              </span>
              <ChevronDown className={`w-4 h-4 transition-transform duration-200 ${isFulfillmentOpen ? '' : '-rotate-90'}`} />
            </button>

            {isFulfillmentOpen && (
              <div className="space-y-3">
                {fulfillmentLoading ? (
                  <p className="text-sm text-muted-foreground italic py-2 px-1">Loading fulfillment data...</p>
                ) : fulfillmentData.length === 0 ? (
                  <p className="text-sm text-muted-foreground italic py-2 px-1">No fulfillment data available.</p>
                ) : (
                  <div className="overflow-x-auto rounded-lg border border-border/50">
                    <table className="w-full text-xs min-w-[500px]">
                      <thead>
                        <tr className="border-b border-border/50 bg-muted/30">
                          <th className="text-left font-semibold text-muted-foreground px-3 py-2 uppercase tracking-wider">SKU</th>
                          <th className="text-left font-semibold text-muted-foreground px-3 py-2 uppercase tracking-wider">Description</th>
                          <th className="text-right font-semibold text-muted-foreground px-3 py-2 uppercase tracking-wider">Expected</th>
                          <th className="text-right font-semibold text-muted-foreground px-3 py-2 uppercase tracking-wider">Shipped</th>
                          <th className="text-right font-semibold text-muted-foreground px-3 py-2 uppercase tracking-wider">Remaining</th>
                        </tr>
                      </thead>
                      <tbody>
                        {fulfillmentData.map((item: any, idx: number) => (
                            <tr key={item.sku_code || idx} className="border-b border-border/30 last:border-0 hover:bg-muted/10 transition-colors">
                              <td className="px-3 py-2 font-mono font-semibold text-primary">{item.sku_code || '—'}</td>
                              <td className="px-3 py-2 text-foreground">{item.description || '—'}</td>
                              <td className="px-3 py-2 text-right font-semibold tabular-nums">{Number(item.expected_qty || 0).toLocaleString()}</td>
                              <td className="px-3 py-2 text-right tabular-nums">{Number(item.shipped_qty || 0).toLocaleString()}</td>
                              <td className="px-3 py-2 text-right font-semibold tabular-nums">
                                <span className={item.remaining_qty <= 0 ? 'text-emerald-600' : 'text-amber-600'}>
                                  {Number(item.remaining_qty || 0).toLocaleString()}
                                </span>
                              </td>
                            </tr>
                        ))}
                      </tbody>
                      <tfoot>
                        <tr className="border-t border-border/50 bg-muted/20">
                          <td colSpan={2} className="px-3 py-2 text-xs font-bold text-muted-foreground uppercase tracking-wider">
                            Total ({fulfillmentData.length} SKU{fulfillmentData.length !== 1 ? 's' : ''})
                          </td>
                          <td className="px-3 py-2 text-right text-sm font-bold text-primary tabular-nums">
                            {fulfillmentData.reduce((s: number, i: any) => s + (Number(i.expected_qty) || 0), 0).toLocaleString()}
                          </td>
                          <td className="px-3 py-2 text-right text-sm font-bold tabular-nums">
                            {fulfillmentData.reduce((s: number, i: any) => s + (Number(i.shipped_qty) || 0), 0).toLocaleString()}
                          </td>
                          <td className="px-3 py-2 text-right text-sm font-bold tabular-nums">
                            {fulfillmentData.reduce((s: number, i: any) => s + (Number(i.remaining_qty) || 0), 0).toLocaleString()}
                          </td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                )}
              </div>
            )}
          </div>
          )}

        </div>

      </div>
    </div>
  );
}
