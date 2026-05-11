'use client';

import React, { useState } from 'react';
import { createBooking } from '@/app/actions/bookings';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { toast } from 'sonner';
import { Calendar, PackageOpen, Building2, Anchor, Hash, Navigation, Printer, Download, Search, Truck } from 'lucide-react';
import { getSession } from '@/app/actions/auth';
import { getPurchaseOrders } from '@/app/actions/purchase-orders';
import { cn } from '@/lib/utils';
import CiUploadSection from './CiUploadSection';
const INITIAL_FORM_STATE = {
  vendor_name: '',
  tentree_po_number: '',
  receiving_warehouse: '',
  number_of_cartons: '',
  cargo_ready_date: '',
  courier: '',
  tracking_number: '',
  mode: '',
  incoterm: 'FOB',
  season: '',
  trn_number: '',
  type: 'mainline',
  po_details: Array(5).fill(null).map(() => ({ po_number: '', cartons: '', units: '', cbm: '', weight: '' })),
};

export default function BookingForm({ onSuccess, prefilledPO, onSwitchToMultiPO }: any) {
  const [isLoading, setIsLoading] = useState(false);
  const [user, setUser] = useState<any>(null);
  const [vendorPOs, setVendorPOs] = useState<any[]>([]);
  const [formData, setFormData] = useState<any>(INITIAL_FORM_STATE);
  const [showSwitchConfirm, setShowSwitchConfirm] = useState(false);

  React.useEffect(() => {
    async function init() {
      const session = await getSession();
      setUser(session);
      const isVendor = session?.role === 'Vendor';
      const isAdmin = session?.role === 'Admin' || session?.role === 'Logistics';

      if (isVendor || isAdmin) {
        const allPOs = await getPurchaseOrders();
        const available = allPOs.filter((p: any) => {
          const isMatch = isAdmin || p.supplier === session.supplier;
          const remaining = (parseInt(p.expected_qty) || 0) - (parseInt(p.booked_qty) || 0);
          return isMatch && remaining > 0;
        });
        setVendorPOs(available);

        // Compute new form data directly from initial state + session + prefilledPO
        const baseVendorName = isVendor ? session.supplier : (prefilledPO?.supplier || '');
        
        let nextFormData = { 
          ...INITIAL_FORM_STATE, // Start from clean defaults
          vendor_name: baseVendorName 
        };

        if (prefilledPO && (isAdmin || prefilledPO.supplier === session.supplier)) {
          const initialUnits = (parseInt(prefilledPO.expected_qty) || 0) - (parseInt(prefilledPO.booked_qty) || 0);
          
          nextFormData = {
            ...nextFormData,
            receiving_warehouse: prefilledPO.receiving_warehouse || nextFormData.receiving_warehouse,
            tentree_po_number: prefilledPO.po_number,
            season: prefilledPO.season || nextFormData.season,
            mode: prefilledPO.mode || prefilledPO.transport_mode || nextFormData.mode,
            incoterm: prefilledPO.incoterm || nextFormData.incoterm,
            cargo_ready_date: prefilledPO.etd || nextFormData.cargo_ready_date,
            trn_number: prefilledPO.trn_number || nextFormData.trn_number,
            type: prefilledPO.type || nextFormData.type,
            po_details: [
              { 
                po_number: prefilledPO.po_number,
                units: String(initialUnits),
                cartons: '',
                weight: '',
                cbm: ''
              },
              ...nextFormData.po_details.slice(1)
            ]
          };
        }
        setFormData(nextFormData);
      }
    }
    init();
  }, [prefilledPO]);

  const updateField = (key: string, value: any) => {
    setFormData((prev: any) => ({ ...prev, [key]: value }));
  };

  const updatePODetail = (index: number, updates: Record<string, string>) => {
    setFormData((prev: any) => {
      const newDetails = [...prev.po_details];
      newDetails[index] = { ...newDetails[index], ...updates };

      // Auto-compute derived fields from the PO table
      const concatPO = newDetails
        .map(p => p.po_number.trim())
        .filter(Boolean)
        .join(', ');
      
      const sumCartons = newDetails
        .reduce((acc, p) => acc + (parseFloat(p.cartons) || 0), 0);
        
      // Extract unique seasons
      const uniqueSeasons = Array.from(new Set(
        vendorPOs
          .filter(p => newDetails.some(nd => nd.po_number === p.po_number))
          .map(p => p.season)
          .filter(Boolean)
      )).join(', ');

      return {
        ...prev,
        po_details: newDetails,
        tentree_po_number: concatPO,
        number_of_cartons: sumCartons > 0 ? String(sumCartons) : prev.number_of_cartons,
        season: uniqueSeasons || prev.season
      };
    });
  };

  const handleDownloadPdf = () => {
    toast.info("Generating Booking PDF...");
    // Mock PDF generation logic
    setTimeout(() => {
      const content = `BOOKING FORM\n\nBooking Number: PENDING\nVendor: ${formData.vendor_name}\nWarehouse: ${formData.receiving_warehouse}\nPOs: ${formData.tentree_po_number}\n\nGenerated via tentree SC Portal`;
      const blob = new Blob([content], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `booking_draft_${formData.vendor_name.replace(/\s+/g, '_')}.txt`;
      link.click();
      toast.success("Booking draft downloaded.");
    }, 1000);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    // Basic validation
    if (!formData.vendor_name || !formData.receiving_warehouse || !formData.mode) {
      toast.error('Please fill in all required fields.');
      return;
    }

    // F2 — Overbooking guard
    const filledPODetails = formData.po_details.filter((p: any) => p.po_number);
    for (const pod of filledPODetails) {
      const selected = vendorPOs.find((p: any) => p.po_number === pod.po_number);
      if (selected) {
        const remaining = (parseInt(selected.expected_qty) || 0) - (parseInt(selected.booked_qty) || 0);
        if (parseInt(pod.units) > remaining) {
          toast.error(
            `Booked qty for ${pod.po_number} (${pod.units}) exceeds remaining (${remaining}). Please reduce.`
          );
          return;
        }
      }
    }

    setIsLoading(true);

    try {
      // 1. Generate Booking Number & Payload
      const randomId = Math.floor(1000 + Math.random() * 9000);
      const bookingNumber = `BKG-${randomId}`;
      const bookingPayload = {
        ...formData,
        booking_number: bookingNumber,
        booking_status: formData.type === 'sms' ? 'No Booking' : 'Booking Pending',
        season: formData.season,
        po_details: formData.po_details.filter((p: any) => p.po_number),
        submitted_at: new Date().toISOString(),
      };

      // 2. Create the Booking entry (Backend handles split lot logic and SMS routing)
      const result = await createBooking(bookingPayload);
      
      if (!result || result.error) {
        throw new Error(result?.error || 'Failed to create booking on the server. Backend rejected the request.');
      }

      toast.success(formData.type === 'sms' 
        ? `Shipment created directly for ${formData.tentree_po_number}`
        : `Booking ${bookingNumber} submitted for approval!`
      );
      
      // Reset form
      setFormData(INITIAL_FORM_STATE);

      if (onSuccess) onSuccess();

    } catch (error: any) {
      console.error(error);
      toast.error(error.message || 'Failed to submit booking. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  const isSimple = !!prefilledPO;

  return (
    <div className="max-w-2xl mx-auto bg-card border border-border rounded-xl shadow-sm overflow-hidden animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="bg-muted/30 border-b border-border p-6">
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-xl font-semibold flex items-center gap-2">
              <PackageOpen className="w-5 h-5 text-primary" />
              Submit New Booking
            </h2>
            <p className="text-sm text-muted-foreground mt-1">
              Vendors: Please fill out the logistics details for your upcoming PO handover.
            </p>
          </div>
          {isSimple && onSwitchToMultiPO && (
            <Button type="button" variant="outline" size="sm" onClick={() => setShowSwitchConfirm(true)}>
              Switch to Multi-PO
            </Button>
          )}
        </div>
      </div>

      <form onSubmit={handleSubmit} className="p-6 space-y-6">
        
        {/* Core Info */}
        {!isSimple ? (
          <div className="space-y-4">
            <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-2">
              <Building2 className="w-4 h-4" /> Vendor & Order
            </h3>
            <div className="grid grid-cols-2 gap-4 bg-muted/10 p-4 rounded-lg border border-border/50">
              <div className="space-y-2">
                <Label>Vendor Name <span className="text-red-500">*</span></Label>
                <Input 
                  placeholder="e.g. EcoTech Garments" 
                  value={formData.vendor_name} 
                  onChange={(e) => updateField('vendor_name', e.target.value)} 
                  readOnly={user?.role === 'Vendor'}
                  className={user?.role === 'Vendor' ? "bg-muted/50" : ""}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label>Season</Label>
                <Input 
                  placeholder="e.g. FW26" 
                  value={formData.season} 
                  onChange={(e) => updateField('season', e.target.value)} 
                />
              </div>
              <div className="space-y-2 col-span-2">
                <Label className="flex items-center gap-1.5">
                  PO Number(s)
                  <span className="text-[10px] font-normal text-muted-foreground bg-muted px-1.5 py-0.5 rounded">auto-filled from PO table</span>
                </Label>
                <Input
                  readOnly
                  value={formData.tentree_po_number}
                  placeholder="Auto-populated from PO# entries below..."
                  className="bg-muted/40 text-muted-foreground cursor-default font-mono text-sm"
                />
              </div>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="bg-primary/5 border border-primary/20 p-4 rounded-xl flex items-center justify-between">
              <div>
                <div className="text-[10px] uppercase font-bold text-primary/60 tracking-widest">Booking For</div>
                <div className="text-xl font-bold font-mono">{prefilledPO.po_number}</div>
              </div>
              <div className="text-right">
                <div className="text-[10px] uppercase font-bold text-muted-foreground tracking-widest">{prefilledPO.season} • {prefilledPO.receiving_warehouse}</div>
                <div className="text-sm font-medium text-muted-foreground">{prefilledPO.supplier}</div>
              </div>
            </div>
          </div>
        )}

        {/* Cargo Details */}
        <div className="space-y-4">
          <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-2">
            <Hash className="w-4 h-4" /> Cargo Details
          </h3>
          <div className="space-y-4 bg-muted/10 p-4 rounded-lg border border-border/50">
            {isSimple ? (
              <div className="grid grid-cols-2 gap-4">
                {prefilledPO.type === 'sms' && (
                  <div className="space-y-4 col-span-2 pb-2 border-b border-border/30 mb-2">
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-1">
                        <Label className="text-[10px] uppercase font-bold text-muted-foreground">Shipment Destination</Label>
                        <div className="text-sm font-bold text-primary">{prefilledPO.receiving_warehouse}</div>
                      </div>
                      <div className="space-y-1 text-right">
                        <Label className="text-[10px] uppercase font-bold text-muted-foreground">Transport Mode</Label>
                        <div className="text-sm font-bold text-primary capitalize">{prefilledPO.mode || 'Courier'}</div>
                      </div>
                    </div>
                  </div>
                )}
                 <div className="space-y-2">
                  <Label>Shipped Quantity <span className="text-red-500">*</span></Label>
                  <div className="relative">
                    <Input 
                      type="number" 
                      value={formData.po_details[0].units} 
                      onChange={(e) => updatePODetail(0, { units: e.target.value })} 
                      className="font-bold text-primary pr-20"
                    />
                    {(() => {
                      const totalRem = (parseInt(prefilledPO.expected_qty) || 0) - (parseInt(prefilledPO.booked_qty) || 0);
                      const afterShip = totalRem - (parseInt(formData.po_details[0].units) || 0);
                      return (
                        <div className={cn(
                          'absolute right-3 top-1/2 -translate-y-1/2 text-[10px] bg-muted px-2 py-1 rounded',
                          afterShip < 0 ? 'text-red-500 font-semibold' : 'text-muted-foreground'
                        )}>
                          / {afterShip} left
                        </div>
                      );
                    })()}
                  </div>
                </div>
                <div className="space-y-2">
                  <Label>No. of Cartons <span className="text-red-500">*</span></Label>
                  <Input 
                    type="number" 
                    value={formData.po_details[0].cartons} 
                    onChange={(e) => updatePODetail(0, { cartons: e.target.value })} 
                    required
                  />
                </div>
                {prefilledPO.type !== 'sms' && (
                  <>
                    <div className="space-y-2">
                      <Label>Weight (kg)</Label>
                      <Input 
                        type="number" 
                        value={formData.po_details[0].weight} 
                        onChange={(e) => updatePODetail(0, { weight: e.target.value })} 
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>CBM (Total Volume)</Label>
                      <Input 
                        type="number" 
                        value={formData.po_details[0].cbm} 
                        onChange={(e) => updatePODetail(0, { cbm: e.target.value })} 
                      />
                    </div>
                  </>
                )}
                <div className="space-y-2 col-span-2">
                  <Label>{prefilledPO.type === 'sms' ? 'Shipped Date' : 'Cargo Ready Date'} <span className="text-red-500">*</span></Label>
                  <Input 
                    type="date" 
                    value={formData.cargo_ready_date} 
                    onChange={(e) => updateField('cargo_ready_date', e.target.value)} 
                    required
                  />
                </div>
              </div>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label className="flex items-center gap-1.5">
                      Total Cartons
                      <span className="text-[10px] font-normal text-muted-foreground bg-muted px-1.5 py-0.5 rounded">auto-summed</span>
                    </Label>
                    <Input
                      readOnly
                      value={formData.number_of_cartons}
                      placeholder="Sum of carton entries below..."
                      className="bg-muted/40 text-muted-foreground cursor-default font-semibold"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Cargo Ready Date</Label>
                    <Input 
                      type="date" 
                      value={formData.cargo_ready_date} 
                      onChange={(e) => updateField('cargo_ready_date', e.target.value)} 
                    />
                  </div>
                </div>

                <div className="space-y-3 pt-2">
                  <Label className="text-xs font-bold text-muted-foreground uppercase">PO Details (Multi-PO Shipment)</Label>
                  <div className="grid grid-cols-[2fr_1fr_1fr_1fr_1.5fr] gap-2 text-[10px] font-bold uppercase text-muted-foreground px-1">
                    <div>PO#</div>
                    <div>Cartons</div>
                    <div>Shipped Qty</div>
                    <div className="text-emerald-600">Remaining</div>
                    <div>CBM / Wt</div>
                  </div>
                  {formData.po_details.map((po: any, idx: number) => (
                    <div key={idx} className="grid grid-cols-[2fr_1fr_1fr_1fr_1.5fr] gap-2">
                      <Select
                        value={po.po_number}
                        onValueChange={(val) => {
                          const selected = vendorPOs.find(p => p.po_number === val);
                          if (selected) {
                            // Duplicate PO guard — same PO cannot appear in two slots
                            const alreadySelected = formData.po_details
                              .filter((_: any, i: number) => i !== idx)
                              .some((pod: any) => pod.po_number === val);
                            if (alreadySelected) {
                              toast.error(`${val} is already selected in another slot.`);
                              return;
                            }

                            // F1 — Vendor-mismatch guard
                            const otherSelectedPO = formData.po_details
                              .filter((_: any, i: number) => i !== idx)
                              .find((pod: any) => pod.po_number);
                            if (otherSelectedPO) {
                              const otherPO = vendorPOs.find((p: any) => p.po_number === otherSelectedPO.po_number);
                              if (otherPO && otherPO.supplier !== selected.supplier) {
                                toast.error('All POs in a booking must belong to the same vendor.');
                                return;
                              }
                            }

                            // F3 — Warehouse-mismatch guard
                            const otherFilledSlots = formData.po_details
                              .filter((_: any, i: number) => i !== idx)
                              .filter((pod: any) => pod.po_number);
                            if (otherFilledSlots.length > 0) {
                              const firstOtherPO = vendorPOs.find((p: any) => p.po_number === otherFilledSlots[0].po_number);
                              if (firstOtherPO && firstOtherPO.receiving_warehouse !== selected.receiving_warehouse) {
                                toast.error('All POs in a booking must ship to the same receiving warehouse.');
                                return;
                              }
                            }

                            updatePODetail(idx, {
                              po_number: selected.po_number,
                              units: ''
                            });
                            
                            setFormData((prev: any) => ({
                              ...prev,
                              vendor_name: prev.vendor_name || selected.supplier || '',
                              receiving_warehouse: prev.receiving_warehouse || selected.receiving_warehouse || '',
                              mode: prev.mode || selected.mode || prev.mode,
                              trn_number: prev.trn_number || selected.trn_number || '',
                              type: prev.type || selected.type || 'mainline',
                              incoterm: prev.incoterm || selected.incoterm || 'FOB',
                              cargo_ready_date: prev.cargo_ready_date || selected.etd || ''
                            }));
                          } else {
                            updatePODetail(idx, { po_number: val });
                          }
                        }}
                      >
                        <SelectTrigger className="h-8 text-xs">
                          <SelectValue placeholder="PO#" />
                        </SelectTrigger>
                        <SelectContent>
                          {vendorPOs.map((p: any) => {
                            const rem = (parseInt(p.expected_qty) || 0) - (parseInt(p.booked_qty) || 0);
                            return (
                              <SelectItem key={p.id} value={p.po_number}>
                                <span className="font-mono">{p.po_number}</span> 
                                <span className="ml-2 opacity-50 text-[10px]">({p.type || 'mainline'})</span>
                                <span className="ml-2 font-bold text-emerald-600 text-[10px]">{rem} left</span>
                              </SelectItem>
                            );
                          })}
                        </SelectContent>
                      </Select>
                      <Input 
                        type="number" 
                        placeholder="Ctns" 
                        value={po.cartons} 
                        onChange={(e) => updatePODetail(idx, { cartons: e.target.value })}
                        className="h-8 text-xs"
                      />
                      <Input 
                        type="number" 
                        placeholder="Units" 
                        value={po.units} 
                        onChange={(e) => updatePODetail(idx, { units: e.target.value })}
                        className="h-8 text-xs font-semibold text-primary"
                      />
                      {(() => {
                        const selected = vendorPOs.find(p => p.po_number === po.po_number);
                        const rem = selected ? (parseInt(selected.expected_qty) || 0) - (parseInt(selected.booked_qty) || 0) : null;
                        const afterShip = rem !== null ? rem - (parseInt(po.units) || 0) : null;
                        return (
                          <Input
                            readOnly
                            tabIndex={-1}
                            value={afterShip !== null ? afterShip : ''}
                            placeholder="—"
                            className={cn(
                              'h-8 text-xs font-semibold pointer-events-none bg-muted/40',
                              afterShip === null ? 'text-muted-foreground' :
                              afterShip < 0 ? 'text-red-500' : 'text-emerald-600'
                            )}
                          />
                        );
                      })()}
                      <div className="flex gap-1">
                        <Input placeholder="CBM" value={po.cbm} onChange={(e) => updatePODetail(idx, { cbm: e.target.value })} className="h-8 text-[10px] p-1" />
                        <Input placeholder="kg" value={po.weight} onChange={(e) => updatePODetail(idx, { weight: e.target.value })} className="h-8 text-[10px] p-1" />
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>

        {/* Routing */}
        <div className="space-y-4">
          <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-2">
            <Navigation className="w-4 h-4" /> Routing & Logistics
          </h3>
          <div className="grid grid-cols-2 gap-4 bg-muted/10 p-4 rounded-lg border border-border/50">
            {!(isSimple && prefilledPO.type === 'sms') && (
              <div className="space-y-2">
                <Label>Receiving Warehouse <span className="text-red-500">*</span></Label>
                <Select 
                  disabled={formData.type === 'mainline' && !!prefilledPO}
                  value={formData.receiving_warehouse} 
                  onValueChange={(val) => updateField('receiving_warehouse', val || '')}
                >
                  <SelectTrigger className={formData.type === 'mainline' && !!prefilledPO ? "bg-muted/50" : ""}><SelectValue placeholder="Select warehouse" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="NRI US">NRI US</SelectItem>
                    <SelectItem value="NRI CAN">NRI CAN</SelectItem>
                    <SelectItem value="Direct US">Direct US</SelectItem>
                    <SelectItem value="Direct CAN">Direct CAN</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
            {!(isSimple && prefilledPO.type === 'sms') && (
              <div className="space-y-2">
                <Label>Transport Mode <span className="text-red-500">*</span></Label>
                <Select 
                  disabled={formData.type === 'mainline' && !!prefilledPO}
                  value={formData.mode} 
                  onValueChange={(val) => updateField('mode', val || '')}
                >
                  <SelectTrigger className={formData.type === 'mainline' && !!prefilledPO ? "bg-muted/50" : ""}><SelectValue placeholder="Select mode" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Ocean">Ocean</SelectItem>
                    <SelectItem value="Air">Air</SelectItem>
                    <SelectItem value="Courier">Courier</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
            {!(isSimple && prefilledPO.type === 'sms') && (
              <div className="space-y-2">
                <Label>Incoterm <span className="text-red-500">*</span></Label>
                <Select 
                  disabled={formData.type === 'mainline' && !!prefilledPO}
                  value={formData.incoterm} 
                  onValueChange={(val) => updateField('incoterm', val || 'FOB')}
                >
                  <SelectTrigger className={formData.type === 'mainline' && !!prefilledPO ? "bg-muted/50" : ""}><SelectValue placeholder="Select incoterm" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="FOB">FOB</SelectItem>
                    <SelectItem value="DDP">DDP</SelectItem>
                    <SelectItem value="Ex-works">Ex-works</SelectItem>
                    <SelectItem value="DAP">DAP</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="space-y-2 col-span-2">
              <Label>Courier / Freight Forwarder</Label>
              <div className="relative">
                <Truck className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input 
                  placeholder="e.g. DHL, FedEx, UPS..." 
                  className="pl-9"
                  value={formData.courier} 
                  onChange={(e) => updateField('courier', e.target.value)} 
                />
              </div>
            </div>
            <div className="space-y-2 col-span-2 animate-in slide-in-from-top-2 duration-300">
              <Label className={formData.mode === 'Courier' ? "text-primary flex items-center gap-2" : "flex items-center gap-2"}>
                <Hash className="w-4 h-4" /> Tracking Number {formData.mode === 'Courier' ? '(Required for Courier)' : '(Optional)'}
              </Label>
              <Input 
                placeholder={formData.mode === 'Courier' ? "Enter tracking number..." : "Enter Tracking/Container/AWB..."}
                value={formData.tracking_number} 
                onChange={(e) => updateField('tracking_number', e.target.value)} 
                className={formData.mode === 'Courier' ? "border-primary/30 focus:border-primary" : ""}
                required={formData.mode === 'Courier'}
              />
            </div>
            <div className="space-y-2 col-span-2">
              <Label className="flex items-center gap-2">Commercial Invoice <span className="text-[10px] font-normal text-muted-foreground">(Optional)</span></Label>
              <CiUploadSection
                poNumbers={
                  prefilledPO
                    ? [prefilledPO.po_number]
                    : (formData.po_details?.filter((p: any) => p.po_number?.trim()).map((p: any) => p.po_number.trim()) || [])
                }
                onConfirm={(ci) => {
                  updateField('commercial_invoice', ci);

                  // Build per-PO shipping map from CI PO summary — use shipped_qty directly
                  // so it works regardless of whether line items matched PO SKUs
                  const poShipping: Record<string, any> = {};
                  ci.po_summary?.forEach((row: any) => {
                    if (row.po_number) poShipping[row.po_number] = row;
                  });

                  setFormData((prev: any) => {
                    const newDetails = [...prev.po_details];

                    // Bug 1 fix: For each PO in CI summary, find existing slot or allocate
                    // the first empty slot. This handles CI-before-PO-selection order.
                    Object.entries(poShipping).forEach(([poNum, ship]: [string, any]) => {
                      let targetIdx = newDetails.findIndex((pod: any) => pod.po_number === poNum);
                      if (targetIdx < 0) targetIdx = newDetails.findIndex((pod: any) => !pod.po_number);
                      if (targetIdx < 0) return; // no slots left

                      newDetails[targetIdx] = {
                        ...newDetails[targetIdx],
                        po_number: poNum,
                        ...(ship.shipped_qty && { units:   String(ship.shipped_qty) }),
                        ...(ship.cartons     && { cartons: String(ship.cartons) }),
                        ...(ship.weight_kg   && { weight:  String(ship.weight_kg) }),
                        ...(ship.cbm         && { cbm:     String(ship.cbm) }),
                      };
                    });

                    // Bug 2 fix: Derive vendor_name, receiving_warehouse, season from matched POs
                    const matchedVendorPOs = newDetails
                      .filter((pod: any) => pod.po_number)
                      .map((pod: any) => vendorPOs.find((p: any) => p.po_number === pod.po_number))
                      .filter(Boolean);

                    const concatPO = newDetails.map((p: any) => p.po_number?.trim()).filter(Boolean).join(', ');
                    // Bug 3 fix: Recompute number_of_cartons from updated po_details
                    const sumCartons = newDetails.reduce((acc: number, p: any) => acc + (parseFloat(p.cartons) || 0), 0);
                    const uniqueSeasons = [...new Set(matchedVendorPOs.map((p: any) => p.season).filter(Boolean))].join(', ');

                    return {
                      ...prev,
                      po_details: newDetails,
                      tentree_po_number: concatPO || prev.tentree_po_number,
                      number_of_cartons: sumCartons > 0 ? String(sumCartons) : prev.number_of_cartons,
                      vendor_name: matchedVendorPOs[0]?.supplier || prev.vendor_name,
                      receiving_warehouse: matchedVendorPOs[0]?.receiving_warehouse || prev.receiving_warehouse,
                      season: uniqueSeasons || prev.season,
                    };
                  });
                }}
                existingCI={formData.commercial_invoice}
              />
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="pt-4 flex justify-between gap-3 border-t border-border">
          <Button type="button" variant="outline" onClick={handleDownloadPdf} className="gap-2">
            <Download className="w-4 h-4" /> Export PDF
          </Button>
          <div className="flex gap-3">
            <Button type="button" variant="ghost" onClick={() => { if (onSuccess) onSuccess(); }}>
              Cancel
            </Button>
            <Button type="submit" disabled={isLoading} className="min-w-[120px]">
              {isLoading ? 'Submitting...' : 'Submit Booking'}
            </Button>
          </div>
        </div>
      </form>

      <Dialog open={showSwitchConfirm} onOpenChange={setShowSwitchConfirm}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Switch to Multi-PO Booking?</DialogTitle>
            <DialogDescription asChild>
              <div>
                <p>The current single PO pre-fill will be cleared and you'll be able to manually select multiple POs in the booking form.</p>
                <p className="mt-3">Are you sure you want to switch?</p>
              </div>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowSwitchConfirm(false)}>Cancel</Button>
            <Button onClick={() => {
              setShowSwitchConfirm(false);
              onSwitchToMultiPO();
            }}>
              Yes, Switch to Multi-PO
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
