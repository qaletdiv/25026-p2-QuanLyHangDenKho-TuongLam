'use client';

import React, { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { updateShipment, createShipment, deleteShipment, getShipments } from '@/app/actions/shipments';
import { getPurchaseOrders } from '@/app/actions/purchase-orders';
import { trackFedexShipment } from '@/app/actions/fedex';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Package, MapPin, Calendar, Hash, Truck, Building2, Save, X, Edit3, RefreshCw, Send, DollarSign, Copy, Trash2, Layers, Paperclip, ExternalLink, Navigation2 } from 'lucide-react';
import { cn } from '@/lib/utils';

export default function SmsDetailDrawer({ open, onClose, onSuccess, onSendAsn, onNewShipment, user }: any) {
  const [isEditing, setIsEditing] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isTracking, setIsTracking] = useState(false);
  const [formData, setFormData] = useState<any>({});
  const [showLotDialog, setShowLotDialog] = useState(false);
  const [dialogStep, setDialogStep] = useState<'choose' | 'lot'>('choose');
  const [lotFormData, setLotFormData] = useState<any>({});
  const [lotQtyInfo, setLotQtyInfo] = useState<{ poTotal: number; totalReceived: number; totalExpected: number; unassigned: number; currentOpen: number; totalAvailable: number; sourceLotId: string | null } | null>(null);

  useEffect(() => {
    if (open) {
      setFormData(open);
      setIsEditing(true); // Always open in edit mode as requested
    }
  }, [open]);

  if (!open) return null;

  // PERMISSIONS
  const isAdminOrLogistics = ['Admin', 'Logistics Coordinator'].includes(user?.role);
  const isProduction = user?.role === 'Production';
  const isVendor = user?.role === 'Vendor';
  const isVirtual = String(formData.id).startsWith('po-');

  const canDelete = isAdminOrLogistics || isProduction;
  const canDuplicate = isAdminOrLogistics || isProduction;
  const canTrack = isAdminOrLogistics || isProduction;
  const canSendAsn = isAdminOrLogistics || isProduction;
  
  // Vendor can only edit if status is "Ready to Ship"
  const canEdit = isAdminOrLogistics || isProduction || (isVendor && formData.status === 'Ready to Ship');

  const getTrackingUrl = (courier: string, trk: string) => {
    if (!trk) return null;
    const c = courier?.toLowerCase();
    if (c === 'fedex') return `https://www.fedex.com/fedextrack/?trknbr=${trk}`;
    if (c === 'ups') return `https://www.ups.com/track?tracknum=${trk}`;
    if (c === 'dhl') return `https://www.dhl.com/en/express/tracking.html?AWB=${trk}`;
    return null;
  };

  const handleSave = async () => {
    setIsLoading(true);
    try {
      await updateShipment(formData.id, formData);
      toast.success(`Shipment ${formData.po_number} updated successfully.`);
      setIsEditing(false);
      if (onSuccess) onSuccess();
      onClose();
    } catch {
      toast.error('Failed to update shipment.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleTrackFedex = async () => {
    if (!formData.tracking_number) {
      toast.error('No tracking number available.');
      return;
    }
    
    setIsTracking(true);
    try {
      const result = await trackFedexShipment(formData.tracking_number);
      if (result.error) {
        toast.error(result.error);
      } else {
        toast.success(`Tracked: ${result.status}`);
        
        let updatedStatus = formData.status;
        const fedexStatus = result.status.toLowerCase();
        const fedexCode = result.code;
        
        if (fedexCode === 'DL' || fedexStatus.includes('delivered')) {
          updatedStatus = 'Delivered';
        } else if (
          fedexCode === 'PU' || 
          fedexCode === 'IT' ||
          fedexStatus.includes('transit') || 
          fedexStatus.includes('picked up') || 
          fedexStatus.includes('pick up') || 
          fedexStatus.includes('arrived') || 
          fedexStatus.includes('departed') ||
          fedexStatus.includes('pickup') ||
          fedexStatus.includes('on its way') ||
          fedexStatus.includes('in-transit')
        ) {
          updatedStatus = 'In-Transit';
        } else if (fedexStatus.includes('exception') || fedexStatus.includes('delay')) {
          updatedStatus = 'Customs Issue';
        }

        const updatedData = {
          ...formData,
          eta: result.eta || formData.eta,
          status: updatedStatus
        };

        await updateShipment(formData.id, updatedData);
        setFormData(updatedData);
        toast.success('Shipment updated automatically');
        if (onSuccess) onSuccess();
      }
    } catch {
      toast.error('Failed to track shipment.');
    } finally {
      setIsTracking(false);
    }
  };

  const openLotDialog = async () => {
    const isVirtualPoRow = String(formData.id).startsWith('po-');
    let poTotal = 0;
    let totalReceived = 0;
    let totalExpected = 0;
    let sourceLotId: string | null = null;

    try {
      const allPOs = await getPurchaseOrders();
      const poMaster = allPOs.find((p: any) => p.po_number?.trim() === formData.po_number?.trim());
      
      // Fallback: if PO not in master list, use the current record's original expected_qty
      poTotal = parseInt(poMaster?.expected_qty || formData.expected_qty || formData.expected_quantity || '0', 10);

      const allShipments = await getShipments();
      const lots = allShipments.filter((s: any) =>
        s.po_number === formData.po_number && !String(s.id).startsWith('po-')
      );
      
      totalReceived = lots.reduce((sum: number, s: any) => sum + parseInt(s.received_quantity || '0', 10), 0);
      totalExpected = lots.reduce((sum: number, s: any) => sum + parseInt(s.expected_quantity || '0', 10), 0);
      sourceLotId = isVirtualPoRow ? null : formData.id;
    } catch {
      // use defaults set above
    }

    const unassigned = Math.max(0, poTotal - totalExpected);
    const currentOpen = isVirtualPoRow ? 0 : Math.max(0, parseInt(formData.expected_quantity || '0', 10) - parseInt(formData.received_quantity || '0', 10));
    // NEW: Total available is everything not yet received in the PO
    const totalAvailable = Math.max(0, poTotal - totalReceived);

    setLotQtyInfo({ poTotal, totalReceived, totalExpected, unassigned, currentOpen, totalAvailable, sourceLotId });
    setLotFormData({
      expected_quantity: '',
      tracking_number: '',
      courier: formData.courier || '',
      eta: '',
    });
    setDialogStep('choose');
    setShowLotDialog(true);
  };

  const handleDuplicate = async () => {
    const newQty = parseInt(lotFormData.expected_quantity || '0', 10);
    const isVirtualPoRow = String(formData.id).startsWith('po-');

    if (lotQtyInfo) {
      if (newQty <= 0) {
        toast.error('Please enter a quantity.');
        return;
      }
      
      const unassignedTaken = Math.min(newQty, lotQtyInfo.unassigned);
      const sourceSplitTaken = newQty - unassignedTaken;

      // Safety check: if we are taking from a real source lot, it must keep at least 1 unit
      if (sourceSplitTaken > 0 && !isVirtualPoRow) {
        const sourceCurrent = parseInt(formData.expected_quantity || '0', 10);
        if (sourceSplitTaken >= sourceCurrent) {
          toast.error(`Cannot take ${sourceSplitTaken} from this lot. It only has ${sourceCurrent} units. At least 1 must remain.`);
          return;
        }
      }

      if (newQty > lotQtyInfo.totalAvailable) {
        toast.error(`Quantity ${newQty} exceeds total available (${lotQtyInfo.totalAvailable}).`);
        return;
      }
    }

    setIsLoading(true);
    setShowLotDialog(false);
    try {
      const { id, ...baseData } = formData;
      const newLotData = {
        ...baseData,
        expected_quantity: newQty,
        tracking_number: lotFormData.tracking_number || '',
        courier: lotFormData.courier || baseData.courier,
        eta: lotFormData.eta || baseData.eta,
        status: 'Ready to Ship',
        asn_sent: false,
        type: 'sms',
      };

      if (isVirtualPoRow) {
        // ... (existing virtual row logic is fine as it takes from poTotal)
        const lot1Qty = (lotQtyInfo?.poTotal || 0) - newQty;
        const { id: _, lot_number: __, ...lot1Base } = baseData;
        await createShipment({ ...lot1Base, expected_quantity: lot1Qty, lot_number: 1 });
        await createShipment(newLotData);
      } else {
        // GLOBAL PO SPLIT LOGIC
        let remainingToTake = newQty;

        // 1. Take from Unassigned Pool first
        const fromUnassigned = Math.min(remainingToTake, lotQtyInfo?.unassigned || 0);
        remainingToTake -= fromUnassigned;

        // 2. Take from Current Lot's OPEN pool next
        const fromCurrentOpen = Math.min(remainingToTake, lotQtyInfo?.currentOpen || 0);
        remainingToTake -= fromCurrentOpen;

        if (fromCurrentOpen > 0) {
          const updatedSourceQty = parseInt(formData.expected_quantity || '0', 10) - fromCurrentOpen;
          await updateShipment(formData.id, { ...formData, expected_quantity: updatedSourceQty });
        }

        // 3. Take from Other Open Lots if still needed
        if (remainingToTake > 0) {
          const all = await getShipments();
          // Find other open lots for this PO, sorted by lot_number descending (newest first)
          const otherLots = all
            .filter((s: any) => 
              s.po_number === formData.po_number && 
              s.id !== formData.id && 
              !String(s.id).startsWith('po-')
            )
            .sort((a: any, b: any) => (b.lot_number || 0) - (a.lot_number || 0));

          for (const other of otherLots) {
            if (remainingToTake <= 0) break;
            const otherOpen = Math.max(0, (parseInt(other.expected_quantity) || 0) - (parseInt(other.received_quantity) || 0));
            const take = Math.min(remainingToTake, otherOpen);
            
            if (take > 0) {
              await updateShipment(other.id, { ...other, expected_quantity: (parseInt(other.expected_quantity) || 0) - take });
              remainingToTake -= take;
            }
          }
        }
        
        const { id: _, lot_number: __, ...duplicateBase } = baseData;
        await createShipment({ ...duplicateBase, ...newLotData });
      }

      toast.success('New lot created successfully');
      if (onSuccess) onSuccess();
      onClose();
    } catch {
      toast.error('Failed to create new lot');
    } finally {
      setIsLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!window.confirm('Are you sure you want to delete this shipment? This action cannot be undone.')) return;
    
    setIsLoading(true);
    try {
      await deleteShipment(formData.id);
      toast.success('Shipment deleted successfully');
      if (onSuccess) onSuccess();
      onClose();
    } catch {
      toast.error('Failed to delete shipment');
    } finally {
      setIsLoading(false);
    }
  };

  const updateField = (key: string, value: any) => {
    setFormData((prev: any) => ({ ...prev, [key]: value }));
  };

  const handleCiUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      updateField('commercial_invoice_url', file.name);
      toast.success(`Commercial Invoice '${file.name}' attached.`);
    }
  };

  return (
    <>
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 sm:p-6" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="w-full max-w-lg bg-card rounded-xl shadow-2xl border border-border overflow-hidden flex flex-col max-h-[90vh] animate-in fade-in zoom-in-95 duration-200">
        
        {/* Header Section */}
        <div className="bg-muted/30 border-b border-border p-6 space-y-4 flex-shrink-0">
          <div className="flex items-center justify-between">
            <Badge variant="secondary" className="px-2.5 py-0.5 rounded-full font-medium tracking-wide">
              {formData.status}
            </Badge>
            {!isEditing ? (
              <div className="flex gap-1">
                {canDuplicate && (
                  <Button variant="ghost" size="sm" onClick={openLotDialog} disabled={isLoading} className="h-8 w-8 p-0 text-muted-foreground hover:text-primary">
                    <Copy className="w-4 h-4" />
                  </Button>
                )}
                {canDelete && (
                  <Button variant="ghost" size="sm" onClick={handleDelete} disabled={isLoading} className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive">
                    <Trash2 className="w-4 h-4" />
                  </Button>
                )}
                {canEdit && (
                  <Button variant="ghost" size="sm" onClick={() => setIsEditing(true)} className="h-8 gap-2 text-primary hover:text-primary hover:bg-primary/10">
                    <Edit3 className="w-4 h-4" /> Edit
                  </Button>
                )}
              </div>
            ) : (
              <div className="flex gap-2">
                <Button variant="ghost" size="sm" onClick={() => setIsEditing(false)} className="h-8 w-8 p-0">
                  <X className="w-4 h-4" />
                </Button>
                <Button size="sm" onClick={handleSave} disabled={isLoading} className="h-8 gap-1.5">
                  <Save className="w-4 h-4" />
                  {isLoading ? '...' : 'Save'}
                </Button>
              </div>
            )}
          </div>
          
          <div className="flex items-start justify-between">
            <div>
              <h2 className="text-2xl font-bold flex items-center gap-2">
                <Package className="w-6 h-6 text-muted-foreground" />
                {formData.po_number}
                {formData.lot_number && (
                  <span className="text-sm font-medium bg-primary/10 text-primary px-2 py-0.5 rounded-md border border-primary/20">
                    Lot {formData.lot_number}
                  </span>
                )}
              </h2>
              <div className="flex flex-col gap-1 mt-1.5">
                <p className="text-base flex items-center gap-2 text-muted-foreground">
                  <Building2 className="w-4 h-4" /> {formData.supplier}
                </p>
                <p className="text-xs flex items-center gap-2 text-muted-foreground font-medium">
                  <Layers className="w-3.5 h-3.5" /> {formData.season || 'No Season'}
                </p>
              </div>
            </div>
            {!isEditing && (
              <Button variant="ghost" size="icon" onClick={onClose} className="text-muted-foreground hover:bg-muted">
                <X className="w-5 h-5" />
              </Button>
            )}
          </div>
        </div>

        {/* Content Section */}
        <div className="p-6 space-y-8 overflow-y-auto">
          
          {/* Logistics Group */}
          <div className="space-y-4">
            <h4 className="text-xs font-bold text-muted-foreground uppercase tracking-wider flex items-center gap-2">
              <Truck className="w-4 h-4" /> Logistics
            </h4>
            
            <div className="grid grid-cols-2 gap-4 bg-muted/20 p-4 rounded-xl border border-border/50">
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Mode</Label>
                <div className="font-medium text-sm">{formData.mode || '—'}</div>
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Incoterm</Label>
                {isEditing ? (
                  <Select value={formData.incoterm || ''} onValueChange={(val) => updateField('incoterm', val)}>
                    <SelectTrigger className="h-9 bg-background"><SelectValue placeholder="Incoterm" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="FOB">FOB</SelectItem>
                      <SelectItem value="DDP">DDP</SelectItem>
                      <SelectItem value="EXW">EXW</SelectItem>
                    </SelectContent>
                  </Select>
                ) : (
                  <div className="font-medium text-sm text-amber-700">{formData.incoterm || '—'}</div>
                )}
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Status</Label>
                {isEditing ? (
                  <Select value={formData.status || ''} onValueChange={(val) => updateField('status', val)}>
                    <SelectTrigger className="h-9 bg-background"><SelectValue placeholder="Select status" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="Ready to Ship">Ready to Ship</SelectItem>
                      <SelectItem value="Pending">Pending</SelectItem>
                      <SelectItem value="In-Transit">In-Transit</SelectItem>
                      <SelectItem value="Customs Issue">Customs Issue</SelectItem>
                      <SelectItem value="Delivered">Delivered</SelectItem>
                    </SelectContent>
                  </Select>
                ) : (
                  <div className="font-medium text-sm">{formData.status}</div>
                )}
              </div>
              
              <div className="space-y-1.5 col-span-2">
                <Label className="text-xs text-muted-foreground flex items-center gap-1"><MapPin className="w-3 h-3" /> Destination</Label>
                {isEditing ? (
                  <Select value={formData.destination_warehouse || ''} onValueChange={(val) => updateField('destination_warehouse', val)}>
                    <SelectTrigger className="h-9 bg-background"><SelectValue placeholder="Select warehouse" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="GoBolt">GoBolt</SelectItem>
                      <SelectItem value="NRI Canada">NRI Canada</SelectItem>
                      <SelectItem value="NRI US">NRI US</SelectItem>
                    </SelectContent>
                  </Select>
                ) : (
                  <div className="font-medium text-sm">{formData.destination_warehouse || '—'}</div>
                )}
              </div>
            </div>
          </div>

          {/* Timelines Group */}
          <div className="space-y-4">
            <h4 className="text-xs font-bold text-muted-foreground uppercase tracking-wider flex items-center gap-2">
              <Calendar className="w-4 h-4" /> Timelines
            </h4>
            
            <div className="grid grid-cols-2 gap-4 bg-muted/20 p-4 rounded-xl border border-border/50">
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Estimated Departure (ETD)</Label>
                {isEditing ? (
                  <Input type="date" value={formData.etd || ''} onChange={(e) => updateField('etd', e.target.value)} className="h-9 bg-background" />
                ) : (
                  <div className="font-medium text-sm">{formData.etd || '—'}</div>
                )}
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Estimated Arrival (ETA)</Label>
                {isEditing ? (
                  <Input type="date" value={formData.eta || ''} onChange={(e) => updateField('eta', e.target.value)} className="h-9 bg-background" />
                ) : (
                  <div className="font-medium text-sm">{formData.eta || '—'}</div>
                )}
              </div>
              <div className="space-y-1.5 col-span-2 pt-2 border-t border-border/30">
                <Label className="text-xs text-muted-foreground flex items-center gap-1.5">
                  <Calendar className="w-3 h-3 text-emerald-500" /> Actual Receive Date
                </Label>
                {isEditing ? (
                  <Input type="date" value={formData.actual_receive_date || ''} onChange={(e) => updateField('actual_receive_date', e.target.value)} className="h-9 bg-background border-emerald-500/20 focus:border-emerald-500" />
                ) : (
                  <div className="text-sm font-bold text-emerald-600">{formData.actual_receive_date || '—'}</div>
                )}
              </div>
            </div>
          </div>

          {/* ASN Data Group (Only for Courier) */}
          <div className="space-y-4">
            <h4 className="text-xs font-bold text-muted-foreground uppercase tracking-wider flex items-center gap-2">
              <DollarSign className="w-4 h-4" /> Financials & ASN
            </h4>
            
            <div className="grid grid-cols-2 gap-4 bg-muted/20 p-4 rounded-xl border border-border/50">
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Expected Qty</Label>
                {isEditing ? (
                  <Input type="number" value={formData.expected_quantity || ''} onChange={(e) => updateField('expected_quantity', e.target.value)} className="h-9 bg-background" />
                ) : (
                  <div className="font-medium text-sm text-blue-600">{formData.expected_quantity || '—'}</div>
                )}
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Received Qty</Label>
                {isEditing ? (
                  <Input type="number" value={formData.received_quantity || ''} onChange={(e) => updateField('received_quantity', e.target.value)} className="h-9 bg-background" />
                ) : (
                  <div className="font-medium text-sm text-green-600">{formData.received_quantity || '—'}</div>
                )}
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Invoice Value</Label>
                {isEditing ? (
                  <Input type="number" value={formData.invoice_value || ''} onChange={(e) => updateField('invoice_value', e.target.value)} className="h-9 bg-background" />
                ) : (
                  <div className="font-medium text-sm">${formData.invoice_value || '0.00'}</div>
                )}
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Variance</Label>
                <div className={cn(
                  "font-medium text-sm",
                  (parseInt(formData.received_quantity) - parseInt(formData.expected_quantity)) < 0 ? "text-destructive" : "text-muted-foreground"
                )}>
                  {formData.received_quantity && formData.expected_quantity 
                    ? parseInt(formData.received_quantity) - parseInt(formData.expected_quantity)
                    : '—'}
                </div>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Freight</Label>
                {isEditing ? (
                  <Input type="number" value={formData.freight || ''} onChange={(e) => updateField('freight', e.target.value)} className="h-9 bg-background" />
                ) : (
                  <div className="font-medium text-sm text-primary">${formData.freight || '0.00'}</div>
                )}
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Duty</Label>
                {isEditing ? (
                  <Input type="number" value={formData.duty || ''} onChange={(e) => updateField('duty', e.target.value)} className="h-9 bg-background" />
                ) : (
                  <div className="font-medium text-sm text-primary">${formData.duty || '0.00'}</div>
                )}
              </div>
            </div>
          </div>

          {/* Commercial Invoice Section */}
          <div className="space-y-4">
            <h4 className="text-xs font-bold text-muted-foreground uppercase tracking-wider flex items-center gap-2">
              <Paperclip className="w-4 h-4" /> Documents
            </h4>
            
            <div className="bg-muted/20 p-4 rounded-xl border border-border/50">
              <Label className="text-xs text-muted-foreground block mb-2">Commercial Invoice</Label>
              {formData.commercial_invoice_url ? (
                <div className="flex items-center justify-between bg-background p-2 rounded border border-border/50">
                  <div className="flex items-center gap-2">
                    <div className="bg-primary/10 p-1.5 rounded">
                      <Paperclip className="w-4 h-4 text-primary" />
                    </div>
                    <span className="text-sm font-medium truncate max-w-[200px]">{formData.commercial_invoice_url}</span>
                  </div>
                  {formData.commercial_invoice_url.startsWith('http') || formData.commercial_invoice_url.startsWith('/') ? (
                    <Button variant="ghost" size="sm" className="h-7 text-xs text-primary hover:text-primary hover:bg-primary/5" onClick={() => window.open(formData.commercial_invoice_url, '_blank')}>
                      View
                    </Button>
                  ) : null}
                </div>
              ) : (
                <div className="text-center py-4 border-2 border-dashed border-border/50 rounded-lg">
                  <p className="text-xs text-muted-foreground mb-2">No invoice uploaded yet.</p>
                  <label className="cursor-pointer">
                    <span className="text-xs font-bold text-primary hover:underline">Upload CI</span>
                    <input type="file" className="hidden" onChange={handleCiUpload} accept=".pdf,.png,.jpg,.jpeg" />
                  </label>
                </div>
              )}
            </div>
          </div>

          {/* Identifiers Group */}
          <div className="space-y-4">
            <h4 className="text-xs font-bold text-muted-foreground uppercase tracking-wider flex items-center gap-2">
              <Hash className="w-4 h-4" /> Identifiers
            </h4>
            
            <div className="grid grid-cols-1 gap-4 bg-muted/20 p-4 rounded-xl border border-border/50">
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground font-bold">TRN Number</Label>
                {isEditing ? (
                  <Input value={formData.trn_number || ''} onChange={(e) => updateField('trn_number', e.target.value)} className="h-9 bg-background" placeholder="TRN-XXXXXX" />
                ) : (
                  <div className="font-medium text-sm font-mono">{formData.trn_number || '—'}</div>
                )}
              </div>
              <div className="space-y-1.5 col-span-2 pt-2 border-t border-border/30">
                <Label className="text-xs text-muted-foreground">Tracking Number</Label>
                {isEditing ? (
                  <Input value={formData.tracking_number || ''} onChange={(e) => updateField('tracking_number', e.target.value)} className="h-9 bg-background font-mono" />
                ) : (
                  <div className="flex flex-col gap-1">
                    <div className="font-mono text-sm font-bold">{formData.tracking_number || '—'}</div>
                    {getTrackingUrl(formData.courier, formData.tracking_number) && (
                      <a 
                        href={getTrackingUrl(formData.courier, formData.tracking_number)!} 
                        target="_blank" 
                        rel="noopener noreferrer"
                        className="text-[10px] text-primary hover:underline flex items-center gap-1 font-bold"
                      >
                        Track on {formData.courier} Website <ExternalLink className="w-2.5 h-2.5" />
                      </a>
                    )}
                  </div>
                )}
              </div>
              <div className="space-y-1.5 pt-2 border-t border-border/30">
                <Label className="text-xs text-muted-foreground">Courier</Label>
                {isEditing ? (
                  <div className="flex gap-2">
                    <Select value={formData.courier || ''} onValueChange={(val) => updateField('courier', val)}>
                      <SelectTrigger className="w-[120px] h-9 bg-background"><SelectValue placeholder="Courier" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="FedEx">FedEx</SelectItem>
                        <SelectItem value="DHL">DHL</SelectItem>
                        <SelectItem value="UPS">UPS</SelectItem>
                      </SelectContent>
                    </Select>
                    <Input value={formData.tracking_number || ''} onChange={(e) => updateField('tracking_number', e.target.value)} className="flex-1 h-9 bg-background" placeholder="Tracking #" />
                  </div>
                ) : (
                  <div className="flex items-center justify-between">
                    <div className={cn("font-medium text-sm font-mono", !formData.tracking_number && "text-muted-foreground font-sans")}>
                      {formData.courier ? `${formData.courier} - ` : ''}
                      {formData.tracking_number || 'No tracking available'}
                    </div>
                    {canTrack && formData.courier?.toLowerCase() === 'fedex' && formData.tracking_number && (
                      <Button 
                        variant="outline" 
                        size="sm" 
                        className="h-7 text-xs gap-1.5" 
                        onClick={handleTrackFedex}
                        disabled={isTracking}
                      >
                        <RefreshCw className={cn("w-3 h-3", isTracking && "animate-spin")} />
                        {isTracking ? 'Tracking...' : 'Track'}
                      </Button>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>

          </div>


        {/* Footer Section */}
        {canSendAsn && onSendAsn && !isEditing && (
          <div className="bg-muted/30 border-t border-border p-4 flex justify-end shrink-0">
            <Button onClick={() => { onClose(); onSendAsn(formData); }} className="gap-2">
              <Send className="w-4 h-4" /> Send ASN
            </Button>
          </div>
        )}
      </div>
    </div>

    {/* Duplicate Choice + Lot Dialog */}
    {showLotDialog && (
      <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
        <div className="bg-card w-full max-w-sm rounded-xl shadow-2xl border border-border overflow-hidden animate-in fade-in zoom-in-95 duration-200">

          {dialogStep === 'choose' ? (
            /* Step 1: Choose action */
            <>
              <div className="flex items-center justify-between p-4 border-b border-border bg-muted/30">
                <h3 className="font-semibold flex items-center gap-2 text-sm">
                  <Copy className="w-4 h-4 text-primary" />
                  What would you like to create?
                </h3>
                <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setShowLotDialog(false)}>
                  <X className="w-4 h-4" />
                </Button>
              </div>
              <div className="p-4 space-y-3">
                <p className="text-xs text-muted-foreground pb-1">Choose how to proceed for <span className="font-mono font-bold text-foreground">{formData.po_number}</span>:</p>
                <button
                  className="w-full text-left flex items-start gap-3 p-3 rounded-lg border border-border hover:border-primary hover:bg-primary/5 transition-all group"
                  onClick={() => setDialogStep('lot')}
                >
                  <div className="mt-0.5 w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0 group-hover:bg-primary/20 transition-colors">
                    <Layers className="w-4 h-4 text-primary" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold">Create New Lot</p>
                    <p className="text-xs text-muted-foreground mt-0.5">Split this shipment into an additional lot under the same PO number.</p>
                  </div>
                </button>
                <button
                  className="w-full text-left flex items-start gap-3 p-3 rounded-lg border border-border hover:border-primary hover:bg-primary/5 transition-all group"
                  onClick={() => {
                    setShowLotDialog(false);
                    onClose();
                    if (onNewShipment) onNewShipment();
                  }}
                >
                  <div className="mt-0.5 w-8 h-8 rounded-lg bg-muted flex items-center justify-center flex-shrink-0 group-hover:bg-muted/80 transition-colors">
                    <Package className="w-4 h-4 text-muted-foreground" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold">Create New Shipment</p>
                    <p className="text-xs text-muted-foreground mt-0.5">Open a fresh form for a completely separate SMS shipment.</p>
                  </div>
                </button>
              </div>
              <div className="p-3 border-t border-border bg-muted/30 flex justify-end">
                <Button variant="outline" size="sm" onClick={() => setShowLotDialog(false)}>Cancel</Button>
              </div>
            </>
          ) : (
            /* Step 2: Configure lot details */
            <>
              <div className="flex items-center justify-between p-4 border-b border-border bg-muted/30">
                <div className="flex items-center gap-2">
                  <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setDialogStep('choose')}>
                    <X className="w-3.5 h-3.5 rotate-180" />
                  </Button>
                  <h3 className="font-semibold flex items-center gap-2 text-sm">
                    <Layers className="w-4 h-4 text-primary" />
                    Configure New Lot
                  </h3>
                </div>
                <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setShowLotDialog(false)}>
                  <X className="w-4 h-4" />
                </Button>
              </div>

              <div className="p-4 space-y-4">
                <div className="bg-muted/30 rounded-lg px-3 py-2 text-xs space-y-1 border border-border/50">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">PO</span>
                    <span className="font-mono font-bold">{formData.po_number}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Supplier</span>
                    <span className="font-medium">{formData.supplier}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Warehouse</span>
                    <span className="font-medium">{formData.destination_warehouse}</span>
                  </div>
                </div>

                {/* Qty Budget */}
                {lotQtyInfo && lotQtyInfo.poTotal > 0 && (() => {
                  const isVirtual = String(formData.id).startsWith('po-');
                  const cap = lotQtyInfo.totalAvailable;
                  const entered = parseInt(lotFormData.expected_quantity || '0', 10);
                  const isOverCap = entered > cap;
                  
                  const unassignedTaken = Math.min(entered, lotQtyInfo.unassigned);
                  const sourceSplitTaken = entered - unassignedTaken;
                  const sourceAfter = !isVirtual ? parseInt(formData.expected_quantity || '0', 10) - sourceSplitTaken : null;

                  return (
                    <div className={cn(
                      "rounded-lg px-3 py-2 text-xs space-y-1 border",
                      isOverCap ? "bg-destructive/10 border-destructive/30" : "bg-blue-500/5 border-blue-500/20"
                    )}>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">PO Total Qty</span>
                        <div className="font-bold">{lotQtyInfo?.poTotal} units</div>
                      </div>
                      <div className="flex justify-between border-t border-border/50 pt-1">
                        <span className="text-muted-foreground">Unassigned Pool</span>
                        <div className="font-bold text-emerald-600">{lotQtyInfo?.totalAvailable} units</div>
                      </div>
                      {!isVirtual && (
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Current Lot Open Pool</span>
                          <span className="font-medium">{lotQtyInfo?.currentOpen} units</span>
                        </div>
                      )}
                      {(() => {
                        const unassignedTaken = Math.min(entered, lotQtyInfo.unassigned);
                        const remaining = entered - unassignedTaken;
                        const currentTaken = Math.min(remaining, lotQtyInfo.currentOpen);
                        const othersTaken = remaining - currentTaken;
                        const sourceAfter = !isVirtual ? parseInt(formData.expected_quantity || '0', 10) - currentTaken : null;

                        return (
                          <>
                            <div className="flex justify-between border-t border-border/10 pt-1">
                              <span className="font-semibold">Total Available in PO</span>
                              <span className={cn("font-bold", parseInt(lotFormData.expected_quantity || '0') > (lotQtyInfo?.totalAvailable || 0) ? "text-destructive" : "text-primary")}>
                                {Math.max(0, cap - (entered || 0))} / {cap}
                              </span>
                            </div>
                            
                            {!isVirtual && sourceAfter !== null && currentTaken > 0 && (
                              <div className="flex justify-between text-muted-foreground border-t border-border/10 mt-1 pt-1 italic">
                                <span>This lot will shrink to</span>
                                <span className="font-medium">{sourceAfter}</span>
                              </div>
                            )}
                            
                            {othersTaken > 0 && !isVirtual && (
                              <p className="text-amber-600 text-[10px] italic pt-1">
                                Note: Pulling {othersTaken} units from other open lots.
                              </p>
                            )}
                          </>
                        );
                      })()}

                      {isOverCap && (
                        <p className="text-destructive text-[10px] font-semibold pt-0.5">⚠ Exceeds total available — please reduce.</p>
                      )}
                    </div>
                  );
                })()}

                <div className="space-y-3">
                  <div className="space-y-1.5">
                    <Label className="text-xs font-bold uppercase text-muted-foreground">New Lot Qty <span className="text-destructive">*</span></Label>
                    <Input
                      type="number"
                      min={1}
                      max={lotQtyInfo?.totalAvailable}
                      placeholder={lotQtyInfo ? `Max: ${Math.max(0, (lotQtyInfo?.totalAvailable || 0) - (parseInt(lotFormData.expected_quantity || '0') || 0))} / ${lotQtyInfo?.totalAvailable}` : 'Enter qty'}
                      value={lotFormData.expected_quantity}
                      onChange={(e) => setLotFormData((p: any) => ({ ...p, expected_quantity: e.target.value }))}
                      className={cn("h-9", (() => {
                        const val = parseInt(lotFormData.expected_quantity || '0', 10);
                        return val > 0 && lotQtyInfo && val > lotQtyInfo.totalAvailable ? "border-destructive ring-1 ring-destructive" : "";
                      })())}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs font-bold uppercase text-muted-foreground">Courier</Label>
                    <Select value={lotFormData.courier} onValueChange={(v) => setLotFormData((p: any) => ({ ...p, courier: v }))}>
                      <SelectTrigger className="h-9"><SelectValue placeholder="Same as original" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="FedEx">FedEx</SelectItem>
                        <SelectItem value="DHL">DHL</SelectItem>
                        <SelectItem value="UPS">UPS</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs font-bold uppercase text-muted-foreground">Tracking Number</Label>
                    <Input
                      placeholder="New tracking # (optional)"
                      value={lotFormData.tracking_number}
                      onChange={(e) => setLotFormData((p: any) => ({ ...p, tracking_number: e.target.value }))}
                      className="h-9 font-mono"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs font-bold uppercase text-muted-foreground">ETA</Label>
                    <Input
                      type="date"
                      value={lotFormData.eta}
                      onChange={(e) => setLotFormData((p: any) => ({ ...p, eta: e.target.value }))}
                      className="h-9"
                    />
                  </div>
                </div>
              </div>

              <div className="p-4 border-t border-border bg-muted/30 flex justify-end gap-2">
                <Button variant="outline" size="sm" onClick={() => setDialogStep('choose')}>Back</Button>
                <Button size="sm" onClick={handleDuplicate} disabled={isLoading} className="gap-1.5">
                  <Layers className="w-3.5 h-3.5" />
                  {isLoading ? 'Creating...' : 'Create Lot'}
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    )}
    </>
  );
}
