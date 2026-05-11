'use client';

import React, { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';
import { X, Send, Paperclip, DollarSign, Package, ArrowRight, ArrowLeft, Mail, Copy, Calculator, Pencil, Hash } from 'lucide-react';
import { submitAsnWorkflow } from '@/app/actions/asn';

export default function AsnEmailModal({ open, onClose, onSuccess, shipment }: any) {
  // Normalise: always work with an array of shipments
  const shipments: any[] = Array.isArray(shipment) ? shipment : (shipment ? [shipment] : []);
  const rep = shipments[0]; // representative row for single-value fields

  const [step, setStep] = useState(1);
  const [isLoading, setIsLoading] = useState(false);

  const [receivedQty, setReceivedQty]       = useState(''); // cartons
  const [receivedUnits, setReceivedUnits]   = useState(''); // units
  const [invoiceValue, setInvoiceValue]     = useState('');
  const [duty, setDuty]                     = useState('');
  const [freight, setFreight]               = useState('');
  const [file, setFile]                     = useState<File | null>(null);

  const [calcMode, setCalcMode]             = useState<'auto' | 'manual'>('auto');
  const [dutyPercent, setDutyPercent]       = useState('25');
  const [freightPercent, setFreightPercent] = useState('40');

  const isMultiPO = shipments.length > 1;

  useEffect(() => {
    if (open && shipments.length > 0) {
      setStep(1);
      setIsLoading(false);
      setCalcMode('auto');
      setDutyPercent('25');
      setFreightPercent('40');

      // Cartons: sum number_of_cartons across all POs in the group
      const totalCartons = shipments.reduce(
        (sum, s) => sum + (parseInt(s.number_of_cartons) || 0), 0
      );
      // Units: sum expected_quantity across all POs in the group
      const totalUnits = shipments.reduce(
        (sum, s) => sum + (parseInt(s.expected_quantity) || parseInt(s.expected_qty) || 0), 0
      );

      setReceivedQty(totalCartons > 0 ? totalCartons.toString() : '');
      setReceivedUnits(totalUnits > 0 ? totalUnits.toString() : '');
      setInvoiceValue(rep.invoice_value || '');
      setDuty(rep.duty || '');
      setFreight(rep.freight || '');
      setFile(null);
    }
  }, [open, shipment]);

  const isSms = rep
    ? rep.type === 'sms' || rep.type === 'SMS' || rep.mode === 'Courier'
    : false;

  // Auto-calc duty/freight from invoice value
  useEffect(() => {
    if (isSms && calcMode === 'auto' && invoiceValue) {
      const numVal = parseFloat(invoiceValue);
      if (!isNaN(numVal)) {
        setDuty((numVal * ((parseFloat(dutyPercent) || 0) / 100)).toFixed(2));
        setFreight((numVal * ((parseFloat(freightPercent) || 0) / 100)).toFixed(2));
      }
    }
  }, [invoiceValue, dutyPercent, freightPercent, calcMode, isSms]);

  if (!open || !shipments.length) return null;

  const handleNext = () => {
    if (!receivedQty || !receivedUnits || !invoiceValue || !file) {
      toast.error('Please fill out all required fields (cartons, units, value, and file).');
      return;
    }
    setStep(2);
  };

  const getEmailContent = (docUrl?: string) => {
    const subject = isMultiPO
      ? `ASN - ${rep.mode} - ${rep.booking_number} (${shipments.length} POs)`
      : `ASN - ${rep.mode} - ${rep.po_number}`;

    let body = `Please be advised of incoming shipment:\n\n`;

    if (isMultiPO) {
      body += `Booking #: ${rep.booking_number}\n`;
      body += `PO Numbers:\n`;
      shipments.forEach(s => {
        body += `  - ${s.po_number}  (${s.expected_quantity || s.expected_qty || 0} units)\n`;
      });
      body += `\n`;
    } else {
      body += `PO Number: ${rep.po_number}\n`;
    }

    body += `# Cartons: ${receivedQty}\n`;
    body += `# Units: ${receivedUnits}\n`;
    body += `Tracking Number: ${rep.tracking_number || 'N/A'}\n`;
    body += `ETA: ${rep.eta || 'TBD'}\n\n`;

    if (docUrl) {
      const fullUrl = docUrl.startsWith('http') ? docUrl : `${window.location.origin}${docUrl}`;
      body += `Please find the commercial invoice here: ${fullUrl}\n`;
    } else {
      body += `Commercial Invoice will be uploaded to the SC Portal.\n`;
    }

    return { subject, body };
  };

  const handleSubmit = async (action: 'mailto' | 'gmail' | 'copy') => {
    setIsLoading(true);
    try {
      const formData = new FormData();
      // Send all shipment IDs so the server updates the whole booking group
      formData.append('shipmentIds', JSON.stringify(shipments.map(s => s.id)));
      formData.append('shipmentId', rep.id); // backward compat
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

      toast.success('ASN finalized successfully!');
      const { subject, body } = getEmailContent(result.ciUrl);

      if (action === 'mailto') {
        window.location.href = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
      } else if (action === 'gmail') {
        window.open(
          `https://mail.google.com/mail/?view=cm&fs=1&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`,
          '_blank'
        );
      } else if (action === 'copy') {
        navigator.clipboard.writeText(`Subject: ${subject}\n\n${body}`);
        toast.success('Email details copied to clipboard!');
      }

      if (onSuccess) onSuccess();
      onClose();
    } catch {
      toast.error('An unexpected error occurred.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
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

          {/* ── Shipment / booking details ── */}
          <div className="bg-primary/5 border border-primary/20 p-4 rounded-lg">
            <p className="text-sm font-medium text-primary mb-2">
              {isMultiPO ? `Booking Details — ${shipments.length} POs` : 'Shipment Details'}
            </p>

            {isMultiPO ? (
              <div className="space-y-1">
                <p className="text-xs font-bold text-muted-foreground uppercase tracking-wider mb-1">
                  Booking # {rep.booking_number}
                </p>
                {shipments.map(s => (
                  <div key={s.id} className="flex items-center justify-between text-sm py-0.5 border-b border-border/30 last:border-0">
                    <span className="font-bold">{s.po_number}</span>
                    <span className="text-muted-foreground text-xs">
                      {s.expected_quantity || s.expected_qty || 0} units
                      {s.number_of_cartons ? ` · ${s.number_of_cartons} ctn` : ''}
                    </span>
                  </div>
                ))}
                <p className="text-xs text-muted-foreground mt-2">{rep.supplier} · {rep.mode}</p>
              </div>
            ) : (
              <div className="flex justify-between items-center">
                <div>
                  <p className="text-lg font-bold">{rep.po_number}</p>
                  <p className="text-sm text-muted-foreground">{rep.supplier}</p>
                </div>
                {isSms && (
                  <div className="text-right">
                    <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">Mode</p>
                    <p className="text-sm font-semibold">{rep.mode}</p>
                  </div>
                )}
              </div>
            )}
          </div>

          {step === 1 ? (
            <div className="space-y-6 animate-in slide-in-from-left-4 duration-300">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label className="flex items-center gap-1">
                    <Package className="w-4 h-4 text-muted-foreground" /> # Cartons <span className="text-destructive">*</span>
                  </Label>
                  <Input
                    type="number"
                    value={receivedQty}
                    onChange={e => setReceivedQty(e.target.value)}
                    placeholder="Cartons"
                  />
                </div>
                <div className="space-y-2">
                  <Label className="flex items-center gap-1">
                    <Hash className="w-4 h-4 text-muted-foreground" /> # Units <span className="text-destructive">*</span>
                  </Label>
                  <Input
                    type="number"
                    value={receivedUnits}
                    onChange={e => setReceivedUnits(e.target.value)}
                    placeholder="Units"
                  />
                </div>
                <div className="space-y-2">
                  <Label className="flex items-center gap-1">
                    <DollarSign className="w-4 h-4 text-muted-foreground" /> Invoice Value <span className="text-destructive">*</span>
                  </Label>
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
                      <Input type="number" step="0.1" value={dutyPercent} onChange={e => setDutyPercent(e.target.value)} className="h-8" />
                    </div>
                    <div className="space-y-2">
                      <Label className="text-xs text-muted-foreground">Freight Rate (%)</Label>
                      <Input type="number" step="0.1" value={freightPercent} onChange={e => setFreightPercent(e.target.value)} className="h-8" />
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
                <Label className="flex items-center gap-1">
                  <Paperclip className="w-4 h-4 text-muted-foreground" /> Commercial Invoice <span className="text-destructive">*</span>
                </Label>
                <Input
                  type="file"
                  accept=".pdf,.png,.jpg,.jpeg,.doc,.docx"
                  className="cursor-pointer"
                  onChange={e => setFile(e.target.files?.[0] || null)}
                />
                <p className="text-xs text-muted-foreground">Please attach the finalized commercial invoice.</p>
              </div>

              <div className="pt-4 flex gap-3">
                <Button type="button" variant="outline" className="flex-1" onClick={onClose}>Cancel</Button>
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
