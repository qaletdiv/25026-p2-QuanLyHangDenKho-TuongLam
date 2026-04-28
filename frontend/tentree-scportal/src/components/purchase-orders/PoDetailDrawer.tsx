'use client';

import React, { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { X, Save, Edit3, Trash2, Copy, Package, Building2, Layers, Truck, MapPin, Calendar, Info, Briefcase } from 'lucide-react';
import { toast } from 'sonner';

export default function PoDetailDrawer({ 
  open, 
  onClose, 
  onSave, 
  onDelete, 
  onDuplicate,
  suppliers = [], 
  incoterms = [], 
  isLoading: isGlobalLoading = false,
  user
}: any) {
  const [isEditing, setIsEditing] = useState(false);
  const [formData, setFormData] = useState<any>({});
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setFormData(open === true ? { type: 'mainline', incoterm: 'FOB' } : { ...open });
      setIsEditing(open === true); 
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
      await onSave(formData);
      setIsEditing(false);
      onClose();
    } catch (e) {
      console.error(e);
    } finally {
      setIsSaving(false);
    }
  };

  const updateField = (key: string, value: any) => {
    setFormData((prev: any) => ({ ...prev, [key]: value }));
  };

  const isNew = open === true || !open.id;
  const isAdminOrLogistics = ['Admin', 'Logistics Coordinator'].includes(user?.role);
  const canEdit = isAdminOrLogistics || (user?.role === 'Vendor' && !formData.booking_status);
  const canDelete = isAdminOrLogistics;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 sm:p-6 animate-in fade-in duration-200" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="w-full max-w-lg bg-card rounded-xl shadow-2xl border border-border overflow-hidden flex flex-col max-h-[90vh] animate-in zoom-in-95 duration-200">
        
        {/* Header Section - CONSISTENT WITH SHIPMENTS/BOOKINGS */}
        <div className="bg-muted/30 border-b border-border p-6 space-y-4 flex-shrink-0">
          <div className="flex items-center justify-between">
            <Badge variant="secondary" className="px-3 py-1 text-xs font-bold uppercase tracking-widest bg-primary/10 text-primary border-none">
              {formData.booking_status || 'No Booking'}
            </Badge>
            
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
                        {['Air','Ocean','Courier'].map(m => <SelectItem key={m} value={m}>{m}</SelectItem>)}
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
                        {['NRI US','NRI CAN','Direct US','Direct CAN'].map(w => <SelectItem key={w} value={w}>{w}</SelectItem>)}
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
                <Label className="text-xs text-muted-foreground">Expected Qty</Label>
                {isEditing ? (
                  <Input type="number" value={formData.expected_qty || ''} onChange={e => updateField('expected_qty', e.target.value)} className="h-9 bg-background font-semibold" />
                ) : (
                  <div className="text-lg font-bold text-primary">{formData.expected_qty || '0'}</div>
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

        </div>

      </div>
    </div>
  );
}
