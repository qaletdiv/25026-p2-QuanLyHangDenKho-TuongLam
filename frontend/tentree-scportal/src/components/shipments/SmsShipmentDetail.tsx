'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { updateShipment, createShipment, deleteShipment, getShipments } from '@/app/actions/shipments';
import { getPurchaseOrders } from '@/app/actions/purchase-orders';
import { trackFedexShipment } from '@/app/actions/fedex';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import {
  Package, MapPin, Calendar, Hash, Truck, Building2, Save, ArrowLeft,
  Edit3, RefreshCw, Copy, Trash2, Layers, DollarSign, Send, Paperclip,
  X, ExternalLink,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';

export default function SmsShipmentDetail({ shipment, user }: { shipment: any; user: any }) {
  const router = useRouter();
  const [isEditing, setIsEditing] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isTracking, setIsTracking] = useState(false);
  const [formData, setFormData] = useState<any>(shipment);
  const [showLotDialog, setShowLotDialog] = useState(false);
  const [dialogStep, setDialogStep] = useState<'choose' | 'lot'>('choose');
  const [lotFormData, setLotFormData] = useState<any>({});
  const [lotQtyInfo, setLotQtyInfo] = useState<any>(null);

  const isAdminOrLogistics = ['Admin', 'Logistics Coordinator'].includes(user?.role);
  const isProduction = user?.role === 'Production';
  const isVendor = user?.role === 'Vendor';

  const canDelete = isAdminOrLogistics || isProduction;
  const canDuplicate = isAdminOrLogistics || isProduction;
  const canTrack = isAdminOrLogistics || isProduction;
  const canEdit = isAdminOrLogistics || isProduction || (isVendor && formData.status === 'Ready to Ship');

  const updateField = (key: string, value: any) => {
    setFormData((prev: any) => ({ ...prev, [key]: value }));
  };

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
    } catch {
      toast.error('Failed to update shipment.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleTrackFedex = async () => {
    if (!formData.tracking_number) { toast.error('No tracking number available.'); return; }
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
        if (fedexCode === 'DL' || fedexStatus.includes('delivered')) updatedStatus = 'Delivered';
        else if (fedexStatus.includes('transit') || fedexStatus.includes('picked up') || fedexStatus.includes('arrived') || fedexStatus.includes('departed') || fedexStatus.includes('in-transit')) updatedStatus = 'In-Transit';
        else if (fedexStatus.includes('exception') || fedexStatus.includes('delay')) updatedStatus = 'Customs Issue';
        const updatedData = { ...formData, eta: result.eta || formData.eta, status: updatedStatus };
        await updateShipment(formData.id, updatedData);
        setFormData(updatedData);
        toast.success('Shipment updated automatically');
      }
    } catch {
      toast.error('Failed to track shipment.');
    } finally {
      setIsTracking(false);
    }
  };

  const openLotDialog = async () => {
    let poTotal = 0, totalReceived = 0, totalExpected = 0;
    try {
      const allPOs = await getPurchaseOrders();
      const poMaster = allPOs.find((p: any) => p.po_number?.trim() === formData.po_number?.trim());
      poTotal = parseInt(poMaster?.expected_qty || formData.expected_quantity || '0', 10);
      const allShipments = await getShipments();
      const lots = allShipments.filter((s: any) => s.po_number === formData.po_number && !String(s.id).startsWith('po-'));
      totalReceived = lots.reduce((sum: number, s: any) => sum + parseInt(s.received_quantity || '0', 10), 0);
      totalExpected = lots.reduce((sum: number, s: any) => sum + parseInt(s.expected_quantity || '0', 10), 0);
    } catch { /* use defaults */ }
    const unassigned = Math.max(0, poTotal - totalExpected);
    const currentOpen = Math.max(0, parseInt(formData.expected_quantity || '0', 10) - parseInt(formData.received_quantity || '0', 10));
    const totalAvailable = Math.max(0, poTotal - totalReceived);
    setLotQtyInfo({ poTotal, totalReceived, totalExpected, unassigned, currentOpen, totalAvailable });
    setLotFormData({ expected_quantity: '', tracking_number: '', courier: formData.courier || '', eta: '' });
    setDialogStep('choose');
    setShowLotDialog(true);
  };

  const handleDuplicate = async () => {
    const newQty = parseInt(lotFormData.expected_quantity || '0', 10);
    if (lotQtyInfo) {
      if (newQty <= 0) { toast.error('Please enter a quantity.'); return; }
      if (newQty > lotQtyInfo.totalAvailable) {
        toast.error(`Quantity ${newQty} exceeds total available (${lotQtyInfo.totalAvailable}).`); return;
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
      let remainingToTake = newQty;
      const fromUnassigned = Math.min(remainingToTake, lotQtyInfo?.unassigned || 0);
      remainingToTake -= fromUnassigned;
      const fromCurrentOpen = Math.min(remainingToTake, lotQtyInfo?.currentOpen || 0);
      remainingToTake -= fromCurrentOpen;
      if (fromCurrentOpen > 0) {
        await updateShipment(formData.id, { ...formData, expected_quantity: parseInt(formData.expected_quantity || '0', 10) - fromCurrentOpen });
      }
      if (remainingToTake > 0) {
        const all = await getShipments();
        const otherLots = all.filter((s: any) => s.po_number === formData.po_number && s.id !== formData.id && !String(s.id).startsWith('po-'))
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
      const { lot_number: _, ...duplicateBase } = baseData;
      await createShipment({ ...duplicateBase, ...newLotData });
      toast.success('New lot created successfully');
      router.push('/shipments/sms');
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
      router.push('/shipments/sms');
    } catch {
      toast.error('Failed to delete shipment');
    } finally {
      setIsLoading(false);
    }
  };

  const trackingUrl = getTrackingUrl(formData.courier, formData.tracking_number);

  return (
    <div className="min-h-screen flex flex-col">
      {/* Header */}
      <div className="border-b border-border bg-muted/30 px-6 py-4 flex-shrink-0">
        <div className="max-w-3xl mx-auto">
          <div className="flex items-center justify-between">
            <Button variant="ghost" size="sm" onClick={() => router.push('/shipments/sms')} className="gap-2 text-muted-foreground hover:text-foreground">
              <ArrowLeft className="w-4 h-4" /> Back to SMS
            </Button>
            <div className="flex gap-2">
              {!isEditing ? (
                <>
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
                    <Button size="sm" variant="outline" onClick={() => setIsEditing(true)} className="h-8 gap-2">
                      <Edit3 className="w-4 h-4" /> Edit
                    </Button>
                  )}
                </>
              ) : (
                <>
                  <Button variant="ghost" size="sm" onClick={() => { setIsEditing(false); setFormData(shipment); }} className="h-8 w-8 p-0">
                    <X className="w-4 h-4" />
                  </Button>
                  <Button size="sm" onClick={handleSave} disabled={isLoading} className="h-8 gap-1.5">
                    <Save className="w-4 h-4" />
                    {isLoading ? 'Saving...' : 'Save'}
                  </Button>
                </>
              )}
            </div>
          </div>

          <div className="flex items-start gap-4 mt-4">
            <div className="w-11 h-11 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center flex-shrink-0">
              <Package className="w-5 h-5 text-primary" />
            </div>
            <div className="flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="text-2xl font-bold">{formData.po_number}</h1>
                {formData.lot_number != null && (
                  <span className="text-sm font-medium bg-primary/10 text-primary px-2 py-0.5 rounded-md border border-primary/20">
                    Lot {formData.lot_number}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-3 mt-1">
                <span className="text-sm text-muted-foreground flex items-center gap-1.5">
                  <Building2 className="w-3.5 h-3.5" /> {formData.supplier}
                </span>
                <Badge variant="secondary" className="text-[11px] px-2 py-0.5">{formData.status}</Badge>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 py-6 px-6">
        <div className="max-w-3xl mx-auto space-y-6">

          {/* Logistics */}
          <div className="space-y-3">
            <h4 className="text-xs font-bold text-muted-foreground uppercase tracking-wider flex items-center gap-2">
              <Truck className="w-4 h-4" /> Logistics
            </h4>
            <div className="bg-card p-4 rounded-xl border border-border shadow-sm grid grid-cols-2 gap-4">
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
                ) : <div className="font-medium text-sm text-amber-700">{formData.incoterm || '—'}</div>}
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Status</Label>
                {isEditing ? (
                  <Select value={formData.status || ''} onValueChange={(val) => updateField('status', val)}>
                    <SelectTrigger className="h-9 bg-background"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {['Ready to Ship','Pending','In-Transit','Customs Issue','Delivered'].map(s => (
                        <SelectItem key={s} value={s}>{s}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : <div className="font-medium text-sm">{formData.status || '—'}</div>}
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
                ) : <div className="font-medium text-sm">{formData.destination_warehouse || '—'}</div>}
              </div>
            </div>
          </div>

          {/* Timelines */}
          <div className="space-y-3">
            <h4 className="text-xs font-bold text-muted-foreground uppercase tracking-wider flex items-center gap-2">
              <Calendar className="w-4 h-4" /> Timelines
            </h4>
            <div className="bg-card p-4 rounded-xl border border-border shadow-sm grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">ETD</Label>
                {isEditing ? <Input type="date" value={formData.etd || ''} onChange={(e) => updateField('etd', e.target.value)} className="h-9 bg-background" /> : <div className="font-medium text-sm">{formData.etd || '—'}</div>}
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">ETA</Label>
                {isEditing ? <Input type="date" value={formData.eta || ''} onChange={(e) => updateField('eta', e.target.value)} className="h-9 bg-background" /> : <div className="font-medium text-sm">{formData.eta || '—'}</div>}
              </div>
              <div className="space-y-1.5 col-span-2 pt-2 border-t border-border">
                <Label className="text-xs text-muted-foreground flex items-center gap-1.5"><Calendar className="w-3 h-3 text-emerald-500" /> Actual Receive Date</Label>
                {isEditing ? <Input type="date" value={formData.actual_receive_date || ''} onChange={(e) => updateField('actual_receive_date', e.target.value)} className="h-9 bg-background" /> : <div className="text-sm font-bold text-emerald-600">{formData.actual_receive_date || '—'}</div>}
              </div>
            </div>
          </div>

          {/* Financials & ASN */}
          <div className="space-y-3">
            <h4 className="text-xs font-bold text-muted-foreground uppercase tracking-wider flex items-center gap-2">
              <DollarSign className="w-4 h-4" /> Financials & ASN
            </h4>
            <div className="bg-card p-4 rounded-xl border border-border shadow-sm grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Expected Qty</Label>
                {isEditing ? <Input type="number" value={formData.expected_quantity || ''} onChange={(e) => updateField('expected_quantity', e.target.value)} className="h-9 bg-background" /> : <div className="font-medium text-sm text-blue-600">{formData.expected_quantity || '—'}</div>}
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Received Qty</Label>
                {isEditing ? <Input type="number" value={formData.received_quantity || ''} onChange={(e) => updateField('received_quantity', e.target.value)} className="h-9 bg-background" /> : <div className="font-medium text-sm text-green-600">{formData.received_quantity || '—'}</div>}
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Invoice Value</Label>
                {isEditing ? <Input type="number" value={formData.invoice_value || ''} onChange={(e) => updateField('invoice_value', e.target.value)} className="h-9 bg-background" /> : <div className="font-medium text-sm">${formData.invoice_value || '0.00'}</div>}
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Variance</Label>
                <div className={cn('font-medium text-sm', (parseInt(formData.received_quantity) - parseInt(formData.expected_quantity)) < 0 ? 'text-destructive' : 'text-muted-foreground')}>
                  {formData.received_quantity && formData.expected_quantity ? parseInt(formData.received_quantity) - parseInt(formData.expected_quantity) : '—'}
                </div>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Freight</Label>
                {isEditing ? <Input type="number" value={formData.freight || ''} onChange={(e) => updateField('freight', e.target.value)} className="h-9 bg-background" /> : <div className="font-medium text-sm text-primary">${formData.freight || '0.00'}</div>}
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Duty</Label>
                {isEditing ? <Input type="number" value={formData.duty || ''} onChange={(e) => updateField('duty', e.target.value)} className="h-9 bg-background" /> : <div className="font-medium text-sm text-primary">${formData.duty || '0.00'}</div>}
              </div>
            </div>
          </div>

          {/* Documents */}
          <div className="space-y-3">
            <h4 className="text-xs font-bold text-muted-foreground uppercase tracking-wider flex items-center gap-2">
              <Paperclip className="w-4 h-4" /> Documents
            </h4>
            <div className="bg-card p-4 rounded-xl border border-border shadow-sm">
              <Label className="text-xs text-muted-foreground block mb-2">Commercial Invoice</Label>
              {formData.commercial_invoice_url ? (
                <div className="flex items-center justify-between bg-muted/30 p-2 rounded border border-border">
                  <div className="flex items-center gap-2">
                    <div className="bg-primary/10 p-1.5 rounded"><Paperclip className="w-4 h-4 text-primary" /></div>
                    <span className="text-sm font-medium truncate max-w-[200px]">{formData.commercial_invoice_url}</span>
                  </div>
                  {(formData.commercial_invoice_url.startsWith('http') || formData.commercial_invoice_url.startsWith('/')) && (
                    <Button variant="ghost" size="sm" className="h-7 text-xs text-primary" onClick={() => window.open(formData.commercial_invoice_url, '_blank')}>View</Button>
                  )}
                </div>
              ) : (
                <div className="text-center py-4 border-2 border-dashed border-border rounded-lg">
                  <p className="text-xs text-muted-foreground">No invoice uploaded yet.</p>
                </div>
              )}
            </div>
          </div>

          {/* Identifiers */}
          <div className="space-y-3">
            <h4 className="text-xs font-bold text-muted-foreground uppercase tracking-wider flex items-center gap-2">
              <Hash className="w-4 h-4" /> Identifiers
            </h4>
            <div className="bg-card p-4 rounded-xl border border-border shadow-sm space-y-4">
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground font-bold">TRN Number</Label>
                {isEditing ? <Input value={formData.trn_number || ''} onChange={(e) => updateField('trn_number', e.target.value)} className="h-9 bg-background" placeholder="TRN-XXXXXX" /> : <div className="font-medium text-sm font-mono">{formData.trn_number || '—'}</div>}
              </div>
              <div className="space-y-1.5 pt-2 border-t border-border">
                <Label className="text-xs text-muted-foreground">Tracking Number</Label>
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
                  <div className="space-y-1">
                    <div className="font-mono text-sm font-bold">{formData.tracking_number || '—'}</div>
                    {trackingUrl && (
                      <a href={trackingUrl} target="_blank" rel="noopener noreferrer" className="text-[10px] text-primary hover:underline flex items-center gap-1 font-bold">
                        Track on {formData.courier} Website <ExternalLink className="w-2.5 h-2.5" />
                      </a>
                    )}
                    {canTrack && formData.courier?.toLowerCase() === 'fedex' && formData.tracking_number && (
                      <Button variant="outline" size="sm" className="h-7 text-xs gap-1.5 mt-1" onClick={handleTrackFedex} disabled={isTracking}>
                        <RefreshCw className={cn('w-3 h-3', isTracking && 'animate-spin')} />
                        {isTracking ? 'Tracking...' : 'Auto-Track'}
                      </Button>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Send ASN */}
          {(isAdminOrLogistics || isProduction) && (
            <div className="flex justify-end">
              <Button className="gap-2" onClick={() => toast.info('ASN sending is available from the SMS Shipments table view.')}>
                <Send className="w-4 h-4" /> Send ASN
              </Button>
            </div>
          )}
        </div>
      </div>

      {/* Split Lot Dialog */}
      <Dialog open={showLotDialog} onOpenChange={setShowLotDialog}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Copy className="w-4 h-4 text-primary" />
              {dialogStep === 'choose' ? 'What would you like to create?' : 'Configure New Lot'}
            </DialogTitle>
          </DialogHeader>

          {dialogStep === 'choose' ? (
            <div className="space-y-3 pt-2">
              <p className="text-xs text-muted-foreground">Choose how to proceed for <span className="font-mono font-bold text-foreground">{formData.po_number}</span>:</p>
              <button className="w-full text-left flex items-start gap-3 p-3 rounded-lg border border-border hover:border-primary hover:bg-primary/5 transition-all group" onClick={() => setDialogStep('lot')}>
                <div className="mt-0.5 w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0"><Layers className="w-4 h-4 text-primary" /></div>
                <div><p className="text-sm font-semibold">Create New Lot</p><p className="text-xs text-muted-foreground mt-0.5">Split into an additional lot under the same PO number.</p></div>
              </button>
              <button className="w-full text-left flex items-start gap-3 p-3 rounded-lg border border-border hover:border-primary hover:bg-primary/5 transition-all group" onClick={() => { setShowLotDialog(false); router.push('/shipments/sms'); }}>
                <div className="mt-0.5 w-8 h-8 rounded-lg bg-muted flex items-center justify-center flex-shrink-0"><Package className="w-4 h-4 text-muted-foreground" /></div>
                <div><p className="text-sm font-semibold">Create New Shipment</p><p className="text-xs text-muted-foreground mt-0.5">Go back to SMS list to create a separate shipment.</p></div>
              </button>
              <div className="flex justify-end"><Button variant="outline" size="sm" onClick={() => setShowLotDialog(false)}>Cancel</Button></div>
            </div>
          ) : (
            <div className="space-y-4 pt-2">
              {lotQtyInfo && lotQtyInfo.poTotal > 0 && (
                <div className={cn('rounded-lg px-3 py-2 text-xs space-y-1 border', parseInt(lotFormData.expected_quantity || '0') > lotQtyInfo.totalAvailable ? 'bg-destructive/10 border-destructive/30' : 'bg-blue-500/5 border-blue-500/20')}>
                  <div className="flex justify-between"><span className="text-muted-foreground">PO Total</span><span className="font-bold">{lotQtyInfo.poTotal} units</span></div>
                  <div className="flex justify-between border-t border-border/50 pt-1"><span className="text-muted-foreground">Total Available</span><span className="font-bold text-primary">{Math.max(0, lotQtyInfo.totalAvailable - (parseInt(lotFormData.expected_quantity || '0') || 0))} / {lotQtyInfo.totalAvailable}</span></div>
                </div>
              )}
              <div className="space-y-1.5">
                <Label className="text-xs font-bold uppercase text-muted-foreground">New Lot Qty <span className="text-destructive">*</span></Label>
                <Input type="number" min={1} value={lotFormData.expected_quantity} onChange={(e) => setLotFormData((p: any) => ({ ...p, expected_quantity: e.target.value }))} placeholder="Enter units..." className="h-9" />
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
                <Input placeholder="New tracking # (optional)" value={lotFormData.tracking_number} onChange={(e) => setLotFormData((p: any) => ({ ...p, tracking_number: e.target.value }))} className="h-9 font-mono" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-bold uppercase text-muted-foreground">ETA</Label>
                <Input type="date" value={lotFormData.eta} onChange={(e) => setLotFormData((p: any) => ({ ...p, eta: e.target.value }))} className="h-9" />
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="outline" size="sm" onClick={() => setDialogStep('choose')}>Back</Button>
                <Button size="sm" onClick={handleDuplicate} disabled={isLoading} className="gap-1.5">
                  <Layers className="w-3.5 h-3.5" />
                  {isLoading ? 'Creating...' : 'Create Lot'}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
