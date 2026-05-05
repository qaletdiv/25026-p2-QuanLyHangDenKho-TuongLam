'use client';

import React, { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { X, CheckCircle, XCircle, FileText, Calendar, Package, Truck, Building2, MapPin, Edit3, Trash2, Copy, Save, Layers, RefreshCw } from 'lucide-react';
import { format } from 'date-fns';
import { updateBooking, deleteBooking, createBooking, getBookings } from '@/app/actions/bookings';
import { getPurchaseOrders } from '@/app/actions/purchase-orders';
import { getShipments, bulkUpdateShipmentStatus } from '@/app/actions/shipments';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

export default function BookingDetailDrawer({ booking, open, onClose, onApprove, onDecline, user, onSuccess }: any) {
  const [isEditing, setIsEditing] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [formData, setFormData] = useState<any>({});
  const [linkedShipments, setLinkedShipments] = useState<any[]>([]);
  const [isBulkUpdating, setIsBulkUpdating] = useState(false);
  const [showLotDialog, setShowLotDialog] = useState(false);
  const [dialogStep, setDialogStep] = useState<'choose' | 'lot'>('choose');
  const [lotFormData, setLotFormData] = useState<any>({});
  const [lotQtyInfo, setLotQtyInfo] = useState<any>(null);

  useEffect(() => {
    if (booking && open) {
      const data = { ...booking };
      if (!data.po_details || data.po_details.length === 0) {
        data.po_details = Array(5).fill(null).map(() => ({ po_number: '', cartons: '', units: '', cbm: '', weight: '' }));
      } else if (data.po_details.length < 5) {
        const extra = Array(5 - data.po_details.length).fill(null).map(() => ({ po_number: '', cartons: '', units: '', cbm: '', weight: '' }));
        data.po_details = [...data.po_details, ...extra];
      }
      setFormData(data);
      setIsEditing(false);
      // Fetch live per-PO status from Shipments
      if (booking.booking_number) {
        getShipments()
          .then(all => setLinkedShipments(all.filter((s: any) => s.booking_number === booking.booking_number)))
          .catch(() => setLinkedShipments([]));
      }
    }
  }, [booking, open]);

  if (!booking || !open) return null;

  const isAdminOrLogistics = ['Admin', 'Logistics Coordinator'].includes(user?.role);
  const isVendor = user?.role === 'Vendor';
  const isPending = booking.booking_status === 'Booking' || booking.booking_status === 'Booking Pending';
  const isDraft = booking.booking_status === 'Draft' || !booking.booking_status;

  // Vendors can only edit if it's not approved yet
  const canEdit = isAdminOrLogistics || (isVendor && (isPending || isDraft));
  const canDelete = isAdminOrLogistics || (isVendor && (isPending || isDraft));
  const canDuplicate = isAdminOrLogistics || isVendor;

  const handleSave = async () => {
    setIsLoading(true);
    try {
      await updateBooking(formData.id, formData);
      toast.success(`Booking ${formData.booking_number} updated successfully.`);
      setIsEditing(false);
      if (onSuccess) onSuccess();
      onClose();
    } catch (error) {
      console.error(error);
      toast.error('Failed to update booking.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!window.confirm('Are you sure you want to delete this booking? This will also delete the linked shipment.')) return;

    setIsLoading(true);
    try {
      await deleteBooking(booking.id);
      toast.success('Booking deleted successfully');
      if (onSuccess) onSuccess();
      onClose();
    } catch (error) {
      console.error(error);
      toast.error('Failed to delete booking');
    } finally {
      setIsLoading(false);
    }
  };

  const openLotDialog = async () => {
    // For simplicity in bookings, we split based on the FIRST PO in the booking
    const mainPoNum = formData.po_details?.[0]?.po_number || formData.tentree_po_number?.split(',')[0]?.trim();
    if (!mainPoNum) {
      toast.error("No PO number found to split.");
      return;
    }

    let poTotal = 0;
    let totalReceived = 0;
    let totalBooked = 0;

    try {
      const allPOs = await getPurchaseOrders();
      const poMaster = allPOs.find((p: any) => p.po_number?.trim() === mainPoNum.trim());

      poTotal = parseInt(poMaster?.expected_qty || '0', 10);
      totalReceived = parseInt(poMaster?.received_qty || '0', 10);
      totalBooked = parseInt(poMaster?.booked_qty || '0', 10);
    } catch (e) {
      console.error('Failed to fetch PO data', e);
    }

    const unassigned = Math.max(0, poTotal - totalBooked);
    const currentOpen = parseInt(formData.po_details?.[0]?.units || '0', 10);
    const totalAvailable = Math.max(0, poTotal - totalReceived);

    setLotQtyInfo({
      poTotal,
      totalReceived,
      totalBooked,
      unassigned,
      currentOpen,
      totalAvailable,
      po_number: mainPoNum
    });

    setLotFormData({
      units: '',
      cargo_ready_date: formData.cargo_ready_date || '',
      mode: formData.mode || '',
    });
    setDialogStep('choose');
    setShowLotDialog(true);
  };

  const handleSplit = async () => {
    const newQty = parseInt(lotFormData.units || '0', 10);
    if (!lotQtyInfo || newQty <= 0) {
      toast.error('Please enter a valid quantity.');
      return;
    }

    if (newQty > lotQtyInfo.totalAvailable) {
      toast.error(`Quantity ${newQty} exceeds total available (${lotQtyInfo.totalAvailable}).`);
      return;
    }

    setIsLoading(true);
    setShowLotDialog(false);
    try {
      const { id, booking_number, submitted_at, approved_at, ...baseData } = formData;
      const randomId = Math.floor(1000 + Math.random() * 9000);
      const newBkgNum = `BKG-${randomId}`;

      // 1. Prepare new booking data
      const newBookingData = {
        ...baseData,
        booking_number: newBkgNum,
        booking_status: 'Booking',
        submitted_at: new Date().toISOString(),
        po_details: baseData.po_details.map((p: any, idx: number) =>
          idx === 0 ? { ...p, units: newQty } : p
        )
      };

      // 2. APPLY SPLIT LOGIC (Subtracting from pools)
      let remainingToTake = newQty;

      // Pool 1: Unassigned
      const fromUnassigned = Math.min(remainingToTake, lotQtyInfo.unassigned);
      remainingToTake -= fromUnassigned;

      // Pool 2: Current Booking's open units
      const fromCurrent = Math.min(remainingToTake, lotQtyInfo.currentOpen);
      remainingToTake -= fromCurrent;

      if (fromCurrent > 0) {
        const updatedPoDetails = formData.po_details.map((p: any, idx: number) =>
          idx === 0 ? { ...p, units: (parseInt(p.units) || 0) - fromCurrent } : p
        );
        await updateBooking(formData.id, { ...formData, po_details: updatedPoDetails });
      }

      // Pool 3: Other Open Bookings/Shipments
      if (remainingToTake > 0) {
        const all = await getBookings();
        const otherBookings = all.filter((b: any) =>
          b.id !== formData.id &&
          b.po_details?.some((p: any) => p.po_number === lotQtyInfo.po_number)
        );

        for (const other of otherBookings) {
          if (remainingToTake <= 0) break;
          const poIdx = other.po_details.findIndex((p: any) => p.po_number === lotQtyInfo.po_number);
          if (poIdx === -1) continue;

          const otherQty = parseInt(other.po_details[poIdx].units) || 0;
          const take = Math.min(remainingToTake, otherQty);

          if (take > 0) {
            const updatedDetails = [...other.po_details];
            updatedDetails[poIdx] = { ...updatedDetails[poIdx], units: otherQty - take };
            await updateBooking(other.id, { ...other, po_details: updatedDetails });
            remainingToTake -= take;
          }
        }
      }

      // 3. Create the new split booking
      await createBooking(newBookingData);

      toast.success(`Booking split successfully. New booking: ${newBkgNum}`);
      if (onSuccess) onSuccess();
      onClose();
    } catch (error) {
      console.error(error);
      toast.error('Failed to split booking');
    } finally {
      setIsLoading(false);
    }
  };

  const handleDuplicate = async () => {
    setIsLoading(true);
    try {
      const randomId = Math.floor(1000 + Math.random() * 9000);
      const newBookingNumber = `BKG-${randomId}`;
      const { id, booking_number, submitted_at, approved_at, ...rest } = booking;
      const newBooking = {
        ...rest,
        booking_number: newBookingNumber,
        booking_status: 'Booking',
        submitted_at: new Date().toISOString()
      };
      await createBooking(newBooking);
      toast.success(`Booking duplicated as ${newBookingNumber}`);
      if (onSuccess) onSuccess();
      onClose();
    } catch (error) {
      console.error(error);
      toast.error('Failed to duplicate booking');
    } finally {
      setIsLoading(false);
    }
  };

  const handleBulkStatusUpdate = async (newStatus: any) => {
    if (!booking?.booking_number) return;
    setIsBulkUpdating(true);
    try {
      await bulkUpdateShipmentStatus(booking.booking_number, newStatus);
      toast.success(`Updated PO row(s) in ${booking.booking_number} to "${newStatus}".`);
      // Refresh the live PO status table in the drawer
      const all = await getShipments();
      setLinkedShipments(all.filter((s: any) => s.booking_number === booking.booking_number));
      if (onSuccess) onSuccess();
    } catch (e) {
      console.error(e);
      toast.error('Failed to update PO statuses.');
    } finally {
      setIsBulkUpdating(false);
    }
  };

  const updateField = (key: string, value: any) => {
    setFormData((prev: any) => ({ ...prev, [key]: value }));
  };

  const updatePODetail = (index: number, key: string, value: string) => {
    const newDetails = [...formData.po_details];
    newDetails[index] = { ...newDetails[index], [key]: value };
    setFormData((prev: any) => ({ ...prev, po_details: newDetails }));
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 sm:p-6" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="w-full max-w-lg bg-card rounded-xl shadow-2xl border border-border overflow-hidden flex flex-col max-h-[90vh] animate-in fade-in zoom-in-95 duration-200">

        {/* Header */}
        <div className="p-6 border-b border-border bg-muted/30">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Badge variant="secondary" className="px-3 py-1 text-xs font-bold uppercase tracking-widest">
                Booking: {formData.booking_status}
              </Badge>
              {formData.shipment_status && formData.shipment_status !== formData.booking_status && (
                <Badge variant="outline" className="px-3 py-1 text-xs font-bold uppercase tracking-widest border-primary text-primary">
                  Shipment: {formData.shipment_status}
                </Badge>
              )}
            </div>
            <div className="flex items-center gap-1">
              {!isEditing ? (
                <>
                  {canDuplicate && (
                    <Button variant="ghost" size="sm" onClick={openLotDialog} className="h-8 w-8 p-0 text-muted-foreground hover:text-primary">
                      <Copy className="w-4 h-4" />
                    </Button>
                  )}
                  {canDelete && (
                    <Button variant="ghost" size="sm" onClick={handleDelete} className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive">
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
                  <Button size="sm" onClick={handleSave} disabled={isLoading} className="h-8 gap-1.5 px-3">
                    <Save className="w-4 h-4" /> Save
                  </Button>
                </div>
              )}
              <Button variant="ghost" size="icon" onClick={onClose} className="rounded-full ml-2">
                <X className="w-5 h-5" />
              </Button>
            </div>
          </div>
          <h2 className="text-2xl font-bold flex items-center gap-2">
            <FileText className="w-6 h-6 text-primary" />
            {formData.booking_number}
          </h2>
          <p className="text-sm text-muted-foreground mt-1">Submitted on {(() => {
            try {
              return formData.submitted_at ? format(new Date(formData.submitted_at), 'MMM d, yyyy HH:mm') : '—';
            } catch (e) {
              return formData.submitted_at || '—';
            }
          })()}</p>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-8">

          {/* Vendor & PO */}
          <div className="space-y-4">
            <h4 className="text-xs font-bold text-muted-foreground uppercase tracking-widest flex items-center gap-2">
              <Building2 className="w-4 h-4" /> Vendor & Order
            </h4>
            <div className="bg-muted/20 p-4 rounded-xl border border-border/50 space-y-4">
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Vendor Name</Label>
                {isEditing ? (
                  <Input value={formData.vendor_name || ''} onChange={(e) => updateField('vendor_name', e.target.value)} className="h-9 bg-background" />
                ) : (
                  <div className="text-sm font-semibold">{formData.vendor_name}</div>
                )}
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">PO Number</Label>
                {isEditing ? (
                  <Input value={formData.tentree_po_number || ''} onChange={(e) => updateField('tentree_po_number', e.target.value)} className="h-9 bg-background" />
                ) : (
                  <div className="text-sm font-bold text-primary">{formData.tentree_po_number}</div>
                )}
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Season</Label>
                {isEditing ? (
                  <Input value={formData.season || ''} onChange={(e) => updateField('season', e.target.value)} className="h-9 bg-background" placeholder="e.g. FW26" />
                ) : (
                  <div className="text-sm font-medium">{formData.season || '—'}</div>
                )}
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">TRN Number</Label>
                {isEditing ? (
                  <Input value={formData.trn_number || ''} onChange={(e) => updateField('trn_number', e.target.value)} className="h-9 bg-background" placeholder="TRN-XXXXXX" />
                ) : (
                  <div className="text-sm font-mono">{formData.trn_number || '—'}</div>
                )}
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Type</Label>
                {isEditing ? (
                  <Select value={formData.type || ''} onValueChange={(val) => updateField('type', val)}>
                    <SelectTrigger className="h-9 bg-background"><SelectValue placeholder="Type" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="mainline">Mainline</SelectItem>
                      <SelectItem value="sms">SMS</SelectItem>
                    </SelectContent>
                  </Select>
                ) : (
                  <div className="text-sm font-medium capitalize">{formData.type || '—'}</div>
                )}
              </div>
            </div>
          </div>

          {/* Logistics */}
          <div className="space-y-4">
            <h4 className="text-xs font-bold text-muted-foreground uppercase tracking-widest flex items-center gap-2">
              <Truck className="w-4 h-4" /> Logistics Details
            </h4>
            <div className="bg-muted/20 p-4 rounded-xl border border-border/50 space-y-4">
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Transport Mode</Label>
                {isEditing ? (
                  <Select value={formData.mode || ''} onValueChange={(val) => updateField('mode', val)}>
                    <SelectTrigger className="h-9 bg-background"><SelectValue placeholder="Mode" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="Ocean">Ocean</SelectItem>
                      <SelectItem value="Air">Air</SelectItem>
                      <SelectItem value="Courier">Courier</SelectItem>
                      <SelectItem value="Truck">Truck</SelectItem>
                    </SelectContent>
                  </Select>
                ) : (
                  <Badge variant="outline" className="font-mono">{formData.mode}</Badge>
                )}
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Incoterm</Label>
                {isEditing ? (
                  <Input value={formData.incoterm || ''} onChange={(e) => updateField('incoterm', e.target.value)} className="h-9 bg-background" placeholder="e.g. FOB, DDP" />
                ) : (
                  <div className="text-sm font-semibold">{formData.incoterm || '—'}</div>
                )}
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Warehouse</Label>
                {isEditing ? (
                  <Select value={formData.receiving_warehouse || ''} onValueChange={(val) => updateField('receiving_warehouse', val)}>
                    <SelectTrigger className="h-9 bg-background"><SelectValue placeholder="Warehouse" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="GoBolt">GoBolt</SelectItem>
                      <SelectItem value="NRI Canada">NRI Canada</SelectItem>
                      <SelectItem value="NRI US">NRI US</SelectItem>
                    </SelectContent>
                  </Select>
                ) : (
                  <div className="flex items-center gap-1.5 font-medium text-sm">
                    <MapPin className="w-3.5 h-3.5 text-muted-foreground" />
                    {formData.receiving_warehouse}
                  </div>
                )}
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Freight Forwarder / Courier</Label>
                {isEditing ? (
                  <Input value={formData.courier || formData.freight_forwarder || ''} onChange={(e) => updateField('courier', e.target.value)} className="h-9 bg-background" />
                ) : (
                  <div className="text-sm font-medium">{formData.courier || formData.freight_forwarder || '—'}</div>
                )}
              </div>
            </div>
          </div>

          {/* Cargo */}
          <div className="space-y-4">
            <h4 className="text-xs font-bold text-muted-foreground uppercase tracking-widest flex items-center gap-2">
              <Package className="w-4 h-4" /> Cargo Ready Info
            </h4>
            <div className="bg-muted/20 p-4 rounded-xl border border-border/50 grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Total Cartons</Label>
                {isEditing ? (
                  <Input
                    type="number"
                    value={formData.number_of_cartons || ''}
                    onChange={(e) => updateField('number_of_cartons', e.target.value)}
                    className="h-9 bg-background"
                  />
                ) : (
                  <div className="text-sm font-semibold">{formData.number_of_cartons || '—'}</div>
                )}
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Cargo Ready Date</Label>
                {isEditing ? (
                  <Input
                    type="date"
                    value={formData.cargo_ready_date || ''}
                    onChange={(e) => updateField('cargo_ready_date', e.target.value)}
                    className="h-9 bg-background"
                  />
                ) : (
                  <div className="text-sm font-semibold">{formData.cargo_ready_date || '—'}</div>
                )}
              </div>
            </div>
          </div>

          {/* Multi-PO Details */}
          <div className="space-y-4">
            <h4 className="text-xs font-bold text-muted-foreground uppercase tracking-widest flex items-center gap-2">
              <Layers className="w-4 h-4" /> Multi-PO Details
            </h4>
            <div className="bg-muted/20 p-4 rounded-xl border border-border/50 space-y-4">
              {isEditing ? (
                <div className="space-y-3">
                  <div className="grid grid-cols-5 gap-2 text-[8px] font-bold uppercase text-muted-foreground px-1">
                    <div>PO#</div>
                    <div>Ctns</div>
                    <div>Units</div>
                    <div>CBM</div>
                    <div>Wgt</div>
                  </div>
                  {formData.po_details?.map((po: any, idx: number) => (
                    <div key={idx} className="grid grid-cols-5 gap-1.5">
                      <Input value={po.po_number} onChange={(e) => updatePODetail(idx, 'po_number', e.target.value)} className="h-7 text-[10px] px-1.5 bg-background" placeholder="PO#" />
                      <Input type="number" value={po.cartons} onChange={(e) => updatePODetail(idx, 'cartons', e.target.value)} className="h-7 text-[10px] px-1.5 bg-background" placeholder="Qty" />
                      <Input type="number" value={po.units} onChange={(e) => updatePODetail(idx, 'units', e.target.value)} className="h-7 text-[10px] px-1.5 bg-background" placeholder="Unit" />
                      <Input value={po.cbm} onChange={(e) => updatePODetail(idx, 'cbm', e.target.value)} className="h-7 text-[10px] px-1.5 bg-background" placeholder="CBM" />
                      <Input value={po.weight} onChange={(e) => updatePODetail(idx, 'weight', e.target.value)} className="h-7 text-[10px] px-1.5 bg-background" placeholder="Wgt" />
                    </div>
                  ))}
                </div>
              ) : (
                <div className="space-y-2">
                  {formData.po_details && formData.po_details.filter((p: any) => p.po_number).length > 0 ? (
                    <div className="overflow-x-auto">
                      <table className="w-full text-left border-collapse">
                        <thead>
                          <tr className="text-[10px] font-bold text-muted-foreground border-b border-border/50">
                            <th className="pb-2">PO#</th>
                            <th className="pb-2 text-right">Ctns</th>
                            <th className="pb-2 text-right">Units</th>
                            <th className="pb-2 text-right">CBM</th>
                            <th className="pb-2 text-right">Wgt</th>
                          </tr>
                        </thead>
                        <tbody className="text-xs">
                          {formData.po_details.filter((p: any) => p.po_number).map((po: any, idx: number) => (
                            <tr key={idx} className="border-b border-border/20 last:border-0">
                              <td className="py-2 font-mono">{po.po_number}</td>
                              <td className="py-2 text-right">{po.cartons}</td>
                              <td className="py-2 text-right">{po.units}</td>
                              <td className="py-2 text-right">{po.cbm}</td>
                              <td className="py-2 text-right">{po.weight}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <div className="text-xs text-muted-foreground italic text-center py-2">No additional PO details</div>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Live PO Status Summary (Shipments Mainline) */}
          {linkedShipments.length > 0 && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h4 className="text-xs font-bold text-muted-foreground uppercase tracking-widest flex items-center gap-2">
                  <RefreshCw className="w-4 h-4" /> Live Shipment Status
                </h4>
                <Select onValueChange={handleBulkStatusUpdate} disabled={isBulkUpdating}>
                  <SelectTrigger className="h-7 w-auto text-[10px] font-bold px-2 border-primary/30 text-primary hover:bg-primary/5">
                    {isBulkUpdating ? 'Updating...' : 'Update All POs →'}
                  </SelectTrigger>
                  <SelectContent>
                    {['Booking Approved', 'Customs Clearance', 'In-Transit', 'ASN Sent', 'Delivered'].map(s => (
                      <SelectItem key={s} value={s} className="text-xs font-medium">{s}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="bg-muted/20 rounded-xl border border-border/50 overflow-hidden">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="text-[10px] font-bold text-muted-foreground border-b border-border/50 bg-muted/30">
                      <th className="px-3 py-2">PO#</th>
                      <th className="px-3 py-2 text-right">Cartons</th>
                      <th className="px-3 py-2 text-right">Status</th>
                    </tr>
                  </thead>
                  <tbody className="text-xs">
                    {linkedShipments.map((s: any) => (
                      <tr key={s.id} className="border-b border-border/20 last:border-0">
                        <td className="px-3 py-2 font-mono font-semibold">{s.po_number}</td>
                        <td className="px-3 py-2 text-right">{s.expected_quantity || '—'}</td>
                        <td className="px-3 py-2 text-right">
                          <Badge variant="outline" className="text-[9px] font-bold px-2 py-0.5">{s.status}</Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

        </div>

        {/* Actions */}
        {isAdminOrLogistics && isPending && !isEditing && (
          <div className="p-6 border-t border-border bg-muted/20 flex gap-3">
            <Button
              variant="outline"
              className="flex-1 gap-2 border-red-200 text-red-600 hover:bg-red-50 hover:text-red-700"
              onClick={() => onDecline(formData, 'Booking details do not meet requirements.')}
            >
              <XCircle className="w-4 h-4" />
              Decline
            </Button>
            <Button
              className="flex-1 gap-2"
              onClick={() => onApprove(formData)}
            >
              <CheckCircle className="w-4 h-4" />
              Approve
            </Button>
          </div>
        )}
      </div>

      {/* Split/Duplicate Dialog */}
      {showLotDialog && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
          <div className="bg-card w-full max-w-sm rounded-xl shadow-2xl border border-border overflow-hidden animate-in fade-in zoom-in-95 duration-200">

            {dialogStep === 'choose' ? (
              <>
                <div className="flex items-center justify-between p-4 border-b border-border bg-muted/30">
                  <h3 className="font-semibold flex items-center gap-2 text-sm">
                    <Copy className="w-4 h-4 text-primary" />
                    Duplicate or Split?
                  </h3>
                  <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setShowLotDialog(false)}>
                    <X className="w-4 h-4" />
                  </Button>
                </div>
                <div className="p-4 space-y-3">
                  <p className="text-xs text-muted-foreground pb-1">Choose how to proceed for <span className="font-mono font-bold text-foreground">{formData.booking_number}</span>:</p>
                  <button
                    className="w-full text-left flex items-start gap-3 p-3 rounded-lg border border-border hover:border-primary hover:bg-primary/5 transition-all group"
                    onClick={() => setDialogStep('lot')}
                  >
                    <div className="mt-0.5 w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0 group-hover:bg-primary/20 transition-colors">
                      <Layers className="w-4 h-4 text-primary" />
                    </div>
                    <div>
                      <p className="text-sm font-semibold">Split into New Booking</p>
                      <p className="text-xs text-muted-foreground mt-0.5">Take a specific quantity from this booking to create a separate one.</p>
                    </div>
                  </button>
                  <button
                    className="w-full text-left flex items-start gap-3 p-3 rounded-lg border border-border hover:border-primary hover:bg-primary/5 transition-all group"
                    onClick={handleDuplicate}
                  >
                    <div className="mt-0.5 w-8 h-8 rounded-lg bg-muted flex items-center justify-center flex-shrink-0 group-hover:bg-muted/80 transition-colors">
                      <Copy className="w-4 h-4 text-muted-foreground" />
                    </div>
                    <div>
                      <p className="text-sm font-semibold">Full Duplicate</p>
                      <p className="text-xs text-muted-foreground mt-0.5">Create an exact copy of this booking with a new number.</p>
                    </div>
                  </button>
                </div>
                <div className="p-3 border-t border-border bg-muted/30 flex justify-end">
                  <Button variant="outline" size="sm" onClick={() => setShowLotDialog(false)}>Cancel</Button>
                </div>
              </>
            ) : (
              <>
                <div className="flex items-center justify-between p-4 border-b border-border bg-muted/30">
                  <div className="flex items-center gap-2">
                    <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setDialogStep('choose')}>
                      <X className="w-3.5 h-3.5 rotate-180" />
                    </Button>
                    <h3 className="font-semibold flex items-center gap-2 text-sm">
                      <Layers className="w-4 h-4 text-primary" />
                      Configure Split
                    </h3>
                  </div>
                  <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setShowLotDialog(false)}>
                    <X className="w-4 h-4" />
                  </Button>
                </div>

                <div className="p-4 space-y-4">
                  <div className="bg-muted/30 rounded-lg px-3 py-2 text-xs space-y-1 border border-border/50">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">PO#</span>
                      <span className="font-mono font-bold">{lotQtyInfo.po_number}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Original Booking</span>
                      <span className="font-medium">{formData.booking_number}</span>
                    </div>
                  </div>

                  {/* Qty Budget */}
                  {lotQtyInfo && (
                    <div className={cn(
                      "rounded-lg px-3 py-2 text-xs space-y-1 border",
                      parseInt(lotFormData.units || '0') > lotQtyInfo.totalAvailable ? "bg-destructive/10 border-destructive/30" : "bg-blue-500/5 border-blue-500/20"
                    )}>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">PO Total Qty</span>
                        <span className="font-bold">{lotQtyInfo.poTotal}</span>
                      </div>
                      <div className="flex justify-between border-t border-border/50 pt-1">
                        <span className="text-muted-foreground">Unbooked Pool</span>
                        <span className="font-medium text-emerald-600">{lotQtyInfo.unassigned}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">This Booking's Pool</span>
                        <span className="font-medium text-amber-600">{lotQtyInfo.currentOpen}</span>
                      </div>

                      <div className="flex justify-between border-t border-border/10 pt-1">
                        <span className="font-semibold">Remaining Available</span>
                        <span className={cn("font-bold", parseInt(lotFormData.units || '0') > lotQtyInfo.totalAvailable ? "text-destructive" : "text-primary")}>
                          {Math.max(0, lotQtyInfo.totalAvailable - (parseInt(lotFormData.units || '0') || 0))} / {lotQtyInfo.totalAvailable}
                        </span>
                      </div>
                    </div>
                  )}

                  <div className="space-y-2">
                    <Label className="text-xs">Quantity to Split</Label>
                    <Input
                      type="number"
                      value={lotFormData.units}
                      onChange={(e) => setLotFormData({ ...lotFormData, units: e.target.value })}
                      placeholder="Enter units..."
                      className="h-9"
                    />
                  </div>

                  <Button className="w-full" onClick={handleSplit} disabled={isLoading}>
                    {isLoading ? 'Processing...' : 'Confirm Split'}
                  </Button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
