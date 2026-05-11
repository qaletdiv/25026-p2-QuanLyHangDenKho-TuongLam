'use client';

import React, { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { createShipment, updateShipment } from '@/app/actions/shipments';
import { toast } from 'sonner';
import { X, Save, Package, Building2, Calendar, Hash, Truck, Layers, DollarSign } from 'lucide-react';
import { getSuppliers, getCouriers, getIncoterms } from '@/app/actions/master-data';

export default function SmsShipmentForm({ open, onClose, onSuccess, initialData }: any) {
  const [isLoading, setIsLoading] = useState(false);
  const [formData, setFormData] = useState<any>({
    po_number: '',
    supplier: '',
    destination_warehouse: 'GoBolt',
    mode: 'Courier',
    status: 'Ready to Ship',
    season: '',
    trn_number: '',
    etd: '',
    eta: '',
    courier: 'FedEx',
    tracking_number: '',
    expected_quantity: '',
    type: 'sms',
    incoterm: 'DDP',
  });
  const [suppliers, setSuppliers] = useState<any[]>([]);
  const [couriers, setCouriers] = useState<any[]>([]);
  const [incoterms, setIncoterms] = useState<any[]>([]);

  useEffect(() => {
    async function loadMaster() {
      const [s, c, i] = await Promise.all([getSuppliers(), getCouriers(), getIncoterms()]);
      setSuppliers(s || []);
      setCouriers(c || []);
      setIncoterms(i || []);
    }
    loadMaster();

    if (initialData) {
      setFormData({
        ...initialData,
        type: initialData.type || 'sms',
        incoterm: initialData.incoterm || 'DDP'
      });
    } else {
      setFormData({
        po_number: '',
        supplier: '',
        destination_warehouse: 'NRI CAN',
        mode: 'Courier',
        status: 'Ready to Ship',
        season: '',
        trn_number: '',
        etd: '',
        eta: '',
        courier: 'FedEx',
        tracking_number: '',
        expected_quantity: '',
        type: 'sms',
        incoterm: 'DDP',
      });
    }
  }, [initialData, open]);

  if (!open) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    try {
      if (initialData?.id) {
        await updateShipment(initialData.id, formData);
        toast.success('SMS Shipment updated successfully');
      } else {
        await createShipment(formData);
        toast.success('SMS Shipment created successfully');
      }
      if (onSuccess) onSuccess();
      onClose();
    } catch {
      toast.error('Failed to save shipment');
    } finally {
      setIsLoading(false);
    }
  };

  const updateField = (key: string, value: any) => {
    setFormData((prev: any) => ({ ...prev, [key]: value }));
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-card w-full max-w-2xl rounded-xl shadow-2xl border border-border overflow-hidden animate-in fade-in zoom-in-95 duration-200">
        <form onSubmit={handleSubmit} className="flex flex-col max-h-[90vh]">
          
          <div className="flex items-center justify-between p-4 border-b border-border bg-muted/30">
            <h2 className="text-lg font-semibold flex items-center gap-2">
              <Truck className="w-5 h-5 text-primary" />
              {initialData ? 'Edit SMS Shipment' : 'Create New SMS Shipment'}
            </h2>
            <Button type="button" variant="ghost" size="icon" onClick={onClose}>
              <X className="w-4 h-4" />
            </Button>
          </div>

          <div className="p-6 overflow-y-auto space-y-6">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label className="text-xs font-bold uppercase text-muted-foreground flex justify-between">
                  <span>PO Number *</span>
                  <button 
                    type="button" 
                    className="text-[10px] text-primary hover:underline"
                    onClick={async () => {
                      const { getPurchaseOrders } = await import('@/app/actions/purchase-orders');
                      const pos = await getPurchaseOrders();
                      const match = pos.find((p: any) => p.po_number === formData.po_number);
                      if (match) {
                        setFormData((prev: any) => ({
                          ...prev,
                          supplier: match.supplier || prev.supplier,
                          season: match.season || prev.season,
                          expected_quantity: match.expected_qty || prev.expected_quantity,
                          destination_warehouse: match.receiving_warehouse || prev.destination_warehouse,
                          incoterm: match.incoterm || prev.incoterm
                        }));
                        toast.success(`Data linked from PO ${match.po_number}`);
                      } else {
                        toast.error('PO Number not found');
                      }
                    }}
                  >
                    Auto-fill from PO Master
                  </button>
                </Label>
                <Input required value={formData.po_number} onChange={(e) => updateField('po_number', e.target.value)} placeholder="PO-202X-XXX" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-bold uppercase text-muted-foreground">Supplier *</Label>
                <Select value={formData.supplier} onValueChange={(v) => updateField('supplier', v)}>
                  <SelectTrigger><SelectValue placeholder="Select Supplier" /></SelectTrigger>
                  <SelectContent>
                    {suppliers.map(s => <SelectItem key={s.id} value={s.name}>{s.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-4">
              <div className="space-y-1.5">
                <Label className="text-xs font-bold uppercase text-muted-foreground">Season</Label>
                <Input value={formData.season} onChange={(e) => updateField('season', e.target.value)} placeholder="Spring 2025" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-bold uppercase text-muted-foreground">TRN Number</Label>
                <Input value={formData.trn_number} onChange={(e) => updateField('trn_number', e.target.value)} placeholder="TRN-XXXXXX" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-bold uppercase text-muted-foreground">Expected Qty</Label>
                <Input type="number" value={formData.expected_quantity} onChange={(e) => updateField('expected_quantity', e.target.value)} placeholder="Total Units" />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label className="text-xs font-bold uppercase text-muted-foreground">Mode</Label>
                  <Select value={formData.mode} onValueChange={(v) => updateField('mode', v)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="Courier">Courier</SelectItem>
                      <SelectItem value="Air">Air</SelectItem>
                      <SelectItem value="Truck">Truck</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs font-bold uppercase text-muted-foreground">Incoterm</Label>
                  <Select value={formData.incoterm} onValueChange={(v) => updateField('incoterm', v)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {incoterms.map(i => <SelectItem key={i.id} value={i.name}>{i.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label className="text-xs font-bold uppercase text-muted-foreground">Warehouse</Label>
                  <Select value={formData.destination_warehouse} onValueChange={(v) => updateField('destination_warehouse', v)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="NRI US">NRI US</SelectItem>
                      <SelectItem value="NRI CAN">NRI CAN</SelectItem>
                      <SelectItem value="Direct US">Direct US</SelectItem>
                      <SelectItem value="Direct CAN">Direct CAN</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs font-bold uppercase text-muted-foreground">Status</Label>
                  <Select value={formData.status} onValueChange={(v) => updateField('status', v)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="Ready to Ship">Ready to Ship</SelectItem>
                      <SelectItem value="Pending">Pending</SelectItem>
                      <SelectItem value="In-Transit">In-Transit</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4 pt-4 border-t border-border/50">
              <div className="space-y-1.5">
                <Label className="text-xs font-bold uppercase text-muted-foreground">Estimated Departure (ETD)</Label>
                <Input type="date" value={formData.etd} onChange={(e) => updateField('etd', e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-bold uppercase text-muted-foreground">Estimated Arrival (ETA)</Label>
                <Input type="date" value={formData.eta} onChange={(e) => updateField('eta', e.target.value)} />
              </div>
            </div>

            <div className="grid grid-cols-3 gap-4">
                <div className="space-y-1.5">
                <Label className="text-xs font-bold uppercase text-muted-foreground">Courier</Label>
                <Select value={formData.courier} onValueChange={(v) => updateField('courier', v)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {couriers.map(c => <SelectItem key={c.id} value={c.name}>{c.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5 col-span-2">
                <Label className="text-xs font-bold uppercase text-muted-foreground">Tracking Number</Label>
                <Input value={formData.tracking_number} onChange={(e) => updateField('tracking_number', e.target.value)} placeholder="Tracking #" />
              </div>
            </div>
          </div>

          <div className="p-4 border-t border-border bg-muted/30 flex justify-end gap-3">
            <Button type="button" variant="outline" onClick={onClose} disabled={isLoading}>Cancel</Button>
            <Button type="submit" disabled={isLoading} className="min-w-[120px] gap-2">
              {isLoading ? 'Saving...' : <><Save className="w-4 h-4" /> Save SMS Shipment</>}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
