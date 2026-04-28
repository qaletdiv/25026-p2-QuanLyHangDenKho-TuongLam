'use client';

import React, { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';
import { X, Send, Paperclip, DollarSign, Package, ArrowRight, ArrowLeft, Mail, Copy, Calculator, Pencil, Hash } from 'lucide-react';
import { submitAsnWorkflow } from '@/app/actions/asn';

export default function AsnEmailModal({ open, onClose, onSuccess, shipment }: any) {
  const [step, setStep] = useState(1);
  const [isLoading, setIsLoading] = useState(false);

  // Form State
  const [receivedQty, setReceivedQty] = useState(''); // This will be cartons
  const [receivedUnits, setReceivedUnits] = useState(''); // New field for units
  const [invoiceValue, setInvoiceValue] = useState('');
  const [duty, setDuty] = useState('');
  const [freight, setFreight] = useState('');
  const [file, setFile] = useState<File | null>(null);

  // Auto-calc State
  const [calcMode, setCalcMode] = useState<'auto'|'manual'>('auto');
  const [dutyPercent, setDutyPercent] = useState('25');
  const [freightPercent, setFreightPercent] = useState('40');

  useEffect(() => {
    if (open && shipment) {
      setStep(1);
      setIsLoading(false);
      setCalcMode('auto');
      setDutyPercent('25');
      setFreightPercent('40');
      setReceivedQty(shipment.expected_quantity || '');
      setReceivedUnits(shipment.expected_units || '');
      setInvoiceValue(shipment.invoice_value || '');
      setDuty(shipment.duty || '');
      setFreight(shipment.freight || '');
      setFile(null);
    }
  }, [open, shipment]);

  const isSms = shipment ? (shipment.type === 'sms' || shipment.type === 'SMS' || shipment.mode === 'Courier') : false;

  // Auto calculation effect
  useEffect(() => {
    if (isSms && calcMode === 'auto' && invoiceValue) {
      const numVal = parseFloat(invoiceValue);
      if (!isNaN(numVal)) {
        const dPct = parseFloat(dutyPercent) || 0;
        const fPct = parseFloat(freightPercent) || 0;
        setDuty((numVal * (dPct / 100)).toFixed(2));
        setFreight((numVal * (fPct / 100)).toFixed(2));
      }
    }
  }, [invoiceValue, dutyPercent, freightPercent, calcMode, isSms]);

  if (!open || !shipment) return null;

  const handleNext = () => {
    if (!receivedQty || !receivedUnits || !invoiceValue || !file) {
      toast.error('Please fill out all required fields (cartons, units, value, and file).');
      return;
    }
    setStep(2);
  };

  const getEmailContent = () => {
    const subject = `ASN - ${shipment.mode} - ${shipment.po_number}`;
    const body = `Please be advised of incoming shipment:\n\n` +
      `PO Number: ${shipment.po_number}\n` +
      `# Cartons: ${receivedQty}\n` +
      `# Units: ${receivedUnits}\n` +
      `Tracking Number: ${shipment.tracking_number || 'N/A'}\n` +
      `ETA: ${shipment.eta || 'TBD'}\n\n` +
      `Please find the commercial invoice attached (sent via SC Portal).\n`;
    return { subject, body };
  };

  const handleSubmit = async (action: 'mailto' | 'gmail' | 'copy') => {
    setIsLoading(true);

    try {
      const formData = new FormData();
      formData.append('shipmentId', shipment.id);
      formData.append('receivedQuantity', receivedQty);
      formData.append('receivedUnits', receivedUnits);
      formData.append('invoiceValue', invoiceValue);
      formData.append('duty', duty);
      formData.append('freight', freight);
      if (file) formData.append('invoiceFile', file);

      const result = await submitAsnWorkflow(formData);
      
      if (result.error) {
        toast.error(result.error);
        setIsLoading(false);
        return;
      }

      toast.success(`ASN finalized successfully!`);
      const { subject, body } = getEmailContent();

      if (action === 'mailto') {
        window.location.href = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
      } else if (action === 'gmail') {
        const gmailUrl = `https://mail.google.com/mail/?view=cm&fs=1&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
        window.open(gmailUrl, '_blank');
      } else if (action === 'copy') {
        navigator.clipboard.writeText(`Subject: ${subject}\n\n${body}`);
        toast.success('Email details copied to clipboard!');
      }

      if (onSuccess) onSuccess();
      onClose();
    } catch (error) {
      console.error(error);
      toast.error('An unexpected error occurred.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="bg-card w-full max-w-lg rounded-xl shadow-2xl border border-border overflow-hidden animate-in fade-in zoom-in-95 duration-200 max-h-[90vh] overflow-y-auto">
        
        <div className="flex items-center justify-between p-4 border-b border-border bg-muted/30 sticky top-0 z-10 backdrop-blur-xl">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Send className="w-5 h-5 text-primary" />
            Send ASN & Finalize (Step {step}/2)
          </h2>
          <Button variant="ghost" size="icon" onClick={onClose} disabled={isLoading}>
            <X className="w-4 h-4" />
          </Button>
        </div>

        <div className="p-6 space-y-6">
          <div className="bg-primary/5 border border-primary/20 p-4 rounded-lg flex justify-between items-center">
            <div>
              <p className="text-sm font-medium text-primary">Shipment Details</p>
              <p className="text-lg font-bold mt-1">{shipment.po_number}</p>
              <p className="text-sm text-muted-foreground">{shipment.supplier}</p>
            </div>
            {isSms && (
              <div className="text-right">
                <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">Mode</p>
                <p className="text-sm font-semibold">{shipment.mode}</p>
              </div>
            )}
          </div>

          {step === 1 ? (
            <div className="space-y-6 animate-in slide-in-from-left-4 duration-300">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label className="flex items-center gap-1"><Package className="w-4 h-4 text-muted-foreground"/> # Cartons <span className="text-destructive">*</span></Label>
                  <Input 
                    type="number" 
                    value={receivedQty} 
                    onChange={e => setReceivedQty(e.target.value)}
                    placeholder="Cartons"
                  />
                </div>
                <div className="space-y-2">
                  <Label className="flex items-center gap-1"><Hash className="w-4 h-4 text-muted-foreground"/> # Units <span className="text-destructive">*</span></Label>
                  <Input 
                    type="number" 
                    value={receivedUnits} 
                    onChange={e => setReceivedUnits(e.target.value)}
                    placeholder="Units"
                  />
                </div>
                <div className="space-y-2">
                  <Label className="flex items-center gap-1"><DollarSign className="w-4 h-4 text-muted-foreground"/> Invoice Value <span className="text-destructive">*</span></Label>
                  <Input 
                    type="number" 
                    step="0.01"
                    value={invoiceValue} 
                    onChange={e => setInvoiceValue(e.target.value)}
                    placeholder="0.00"
                  />
                </div>
              </div>

              <div className="p-4 bg-muted/20 rounded-xl border border-border/50 space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold flex items-center gap-2">
                    <DollarSign className="w-4 h-4 text-primary" /> Financials
                  </h3>
                  {isSms && (
                    <div className="flex bg-muted p-1 rounded-lg">
                      <button 
                        type="button"
                        onClick={() => setCalcMode('auto')}
                        className={`text-xs px-2 py-1 rounded-md transition-colors flex items-center gap-1 ${calcMode === 'auto' ? 'bg-background shadow-sm font-bold text-primary' : 'text-muted-foreground hover:text-foreground'}`}
                      >
                        <Calculator className="w-3 h-3" /> Auto
                      </button>
                      <button 
                        type="button"
                        onClick={() => setCalcMode('manual')}
                        className={`text-xs px-2 py-1 rounded-md transition-colors flex items-center gap-1 ${calcMode === 'manual' ? 'bg-background shadow-sm font-bold text-primary' : 'text-muted-foreground hover:text-foreground'}`}
                      >
                        <Pencil className="w-3 h-3" /> Manual
                      </button>
                    </div>
                  )}
                </div>

                {isSms && calcMode === 'auto' && (
                  <div className="grid grid-cols-2 gap-4 pb-4 border-b border-border/50">
                    <div className="space-y-2">
                      <Label className="text-xs text-muted-foreground">Duty Rate (%)</Label>
                      <Input 
                        type="number" 
                        step="0.1"
                        value={dutyPercent} 
                        onChange={e => setDutyPercent(e.target.value)}
                        className="h-8"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label className="text-xs text-muted-foreground">Freight Rate (%)</Label>
                      <Input 
                        type="number" 
                        step="0.1"
                        value={freightPercent} 
                        onChange={e => setFreightPercent(e.target.value)}
                        className="h-8"
                      />
                    </div>
                  </div>
                )}

                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label className={isSms && calcMode === 'auto' ? 'text-muted-foreground' : ''}>Duty Amount ($)</Label>
                    <Input 
                      type="number" 
                      step="0.01"
                      value={duty} 
                      onChange={e => setDuty(e.target.value)}
                      readOnly={isSms && calcMode === 'auto'}
                      className={isSms && calcMode === 'auto' ? 'bg-muted/50 cursor-not-allowed' : ''}
                      placeholder="0.00"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label className={isSms && calcMode === 'auto' ? 'text-muted-foreground' : ''}>Freight Cost ($)</Label>
                    <Input 
                      type="number" 
                      step="0.01"
                      value={freight} 
                      onChange={e => setFreight(e.target.value)}
                      readOnly={isSms && calcMode === 'auto'}
                      className={isSms && calcMode === 'auto' ? 'bg-muted/50 cursor-not-allowed' : ''}
                      placeholder="0.00"
                    />
                  </div>
                </div>
              </div>

              <div className="space-y-2">
                <Label className="flex items-center gap-1"><Paperclip className="w-4 h-4 text-muted-foreground"/> Commercial Invoice <span className="text-destructive">*</span></Label>
                <div className="flex items-center gap-2">
                  <Input 
                    type="file" 
                    accept=".pdf,.png,.jpg,.jpeg,.doc,.docx"
                    className="cursor-pointer"
                    onChange={e => setFile(e.target.files?.[0] || null)}
                  />
                </div>
                <p className="text-xs text-muted-foreground">Please attach the finalized commercial invoice.</p>
              </div>

              <div className="pt-4 flex gap-3">
                <Button type="button" variant="outline" className="flex-1" onClick={onClose}>
                  Cancel
                </Button>
                <Button type="button" className="flex-1 gap-2" onClick={handleNext}>
                  Next <ArrowRight className="w-4 h-4" />
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-6 animate-in slide-in-from-right-4 duration-300">
              <div className="bg-muted/30 p-4 rounded-xl border border-border space-y-4">
                <p className="text-sm font-semibold flex items-center gap-2 text-primary">
                  <Mail className="w-4 h-4" /> Email Preview
                </p>
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">Subject</Label>
                  <div className="font-medium text-sm font-mono bg-background p-2 rounded border border-border/50">
                    {getEmailContent().subject}
                  </div>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">Body</Label>
                  <div className="text-sm bg-background p-3 rounded border border-border/50 whitespace-pre-wrap font-sans text-muted-foreground">
                    {getEmailContent().body}
                  </div>
                </div>
                <p className="text-xs text-muted-foreground flex items-center gap-1 mt-2">
                  <Paperclip className="w-3 h-3" /> {file?.name} will be saved in the portal.
                </p>
              </div>

              <div className="pt-2">
                <Label className="text-xs text-muted-foreground mb-3 block">Choose Email Method</Label>
                <div className="flex flex-col gap-3">
                  <div className="flex gap-2">
                    <Button type="button" variant="default" className="flex-1" onClick={() => handleSubmit('mailto')} disabled={isLoading}>
                      <Mail className="w-4 h-4 mr-2" /> Default App
                    </Button>
                    <Button type="button" variant="outline" className="flex-1 border-red-200 text-red-600 hover:bg-red-50" onClick={() => handleSubmit('gmail')} disabled={isLoading}>
                      Gmail (Web)
                    </Button>
                  </div>
                  <div className="flex gap-2">
                    <Button type="button" variant="outline" className="flex-1 text-muted-foreground" onClick={() => setStep(1)} disabled={isLoading}>
                      <ArrowLeft className="w-4 h-4 mr-2" /> Back
                    </Button>
                    <Button type="button" variant="secondary" className="flex-1" onClick={() => handleSubmit('copy')} disabled={isLoading}>
                      <Copy className="w-4 h-4 mr-2" /> Copy & Close
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

      </div>
    </div>
  );
}
