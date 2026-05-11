'use client';

import React, { useRef, useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { CheckCircle2, RotateCcw, FileSpreadsheet, Loader2, Upload, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';
import { fetchApi } from '@/lib/api';
import CiPreviewTable from './CiPreviewTable';
import type { CIParseResult } from '@/app/actions/commercial-invoices';

/** Maximum file size accepted for CI upload (10 MB) */
const MAX_FILE_SIZE_MB = 10;

interface CiUploadSectionProps {
  /** PO numbers selected in the booking form — used for SKU auto-matching */
  poNumbers: string[];
  /** Called when the vendor clicks "Confirm CI" with the confirmed CI data object */
  onConfirm: (ci: any) => void;
  /** Pass an existing CI when editing a booking that already has one */
  existingCI?: any;
}

type UploadState = 'idle' | 'parsing' | 'preview' | 'confirmed';

export default function CiUploadSection({ poNumbers, onConfirm, existingCI }: CiUploadSectionProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<UploadState>(
    existingCI?.status === 'confirmed' ? 'confirmed' : 'idle'
  );
  const [parseResult, setParseResult] = useState<CIParseResult | null>(null);
  const [confirmedCI, setConfirmedCI] = useState<any>(existingCI || null);
  // Track the PO numbers that were active when the last parse ran
  const parsedForPOs = useRef<string[]>([]);
  const [poMismatch, setPoMismatch] = useState(false);

  // Warn when PO selection changes after a CI has been parsed or confirmed
  useEffect(() => {
    if (state === 'idle') return;
    if (parsedForPOs.current.length === 0) return;
    const changed =
      parsedForPOs.current.length !== poNumbers.length ||
      parsedForPOs.current.some((po, i) => po !== poNumbers[i]);
    setPoMismatch(changed);
  }, [poNumbers, state]);

  const triggerFilePicker = () => fileInputRef.current?.click();

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Reset so the same file can be reselected after a re-upload
    e.target.value = '';

    const ext = file.name.split('.').pop()?.toLowerCase();
    if (!['xlsx', 'xls'].includes(ext || '')) {
      toast.error('Please upload an Excel file (.xlsx or .xls)');
      return;
    }

    const sizeMB = file.size / (1024 * 1024);
    if (sizeMB > MAX_FILE_SIZE_MB) {
      toast.error(`File is too large (${sizeMB.toFixed(1)} MB). Maximum allowed is ${MAX_FILE_SIZE_MB} MB.`);
      return;
    }

    setState('parsing');
    setPoMismatch(false);
    parsedForPOs.current = [...poNumbers];
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('po_numbers', JSON.stringify(poNumbers));

      const result = await fetchApi('/commercial-invoices/parse', { method: 'POST', body: form });
      if (!result) throw new Error('No response from server');

      setParseResult(result as CIParseResult);
      setState('preview');
    } catch (err: any) {
      toast.error(`Failed to parse CI: ${err?.message || 'Unknown error'}`);
      setState('idle');
    }
  };

  const handleConfirm = () => {
    if (!parseResult) return;
    const ci = {
      invoice_number: parseResult.header.invoice_number,
      invoice_date: parseResult.header.invoice_date,
      total_value: parseResult.header.total_value,
      po_summary: parseResult.poSummary,
      status: 'confirmed',
      confirmed_at: new Date().toISOString(),
      line_items: parseResult.lineItems,
    };
    setConfirmedCI(ci);
    onConfirm(ci);
    setState('confirmed');
    toast.success('Commercial Invoice confirmed.');
  };

  const handleReupload = () => {
    setParseResult(null);
    setState('idle');
    // Trigger file picker on next tick so state settles first
    setTimeout(triggerFilePicker, 50);
  };

  // ── Confirmed ────────────────────────────────────────────────────────────────
  if (state === 'confirmed' && confirmedCI) {
    return (
      <div className="space-y-2">
        {poMismatch && (
          <div className="flex items-start gap-2 px-3 py-2 rounded-lg border border-amber-300 bg-amber-50 text-amber-800 text-xs">
            <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
            <span>
              The PO selection has changed since this CI was confirmed. Replace the CI to re-match against the current PO(s).
            </span>
          </div>
        )}
      <div className="flex items-center gap-3 p-3 rounded-lg bg-emerald-500/5 border border-emerald-400/30">
        <CheckCircle2 className="w-4 h-4 text-emerald-600 flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-emerald-700">
            {confirmedCI.invoice_number || 'CI'} confirmed
          </p>
          <p className="text-[11px] text-muted-foreground">
            {confirmedCI.line_items?.length || 0} SKUs
            {' · '}
            ${Number(confirmedCI.total_value || 0).toLocaleString(undefined, {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            })}
            {confirmedCI.invoice_date ? ` · ${confirmedCI.invoice_date}` : ''}
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          type="button"
          onClick={handleReupload}
          className="h-7 gap-1.5 text-xs text-muted-foreground flex-shrink-0"
        >
          <RotateCcw className="w-3 h-3" /> Replace
        </Button>
        <input ref={fileInputRef} type="file" accept=".xlsx,.xls" className="hidden" onChange={handleFileChange} />
      </div>
      </div>
    );
  }

  // ── Parsing ───────────────────────────────────────────────────────────────────
  if (state === 'parsing') {
    return (
      <div className="flex items-center gap-2 p-3 rounded-lg bg-muted/20 border border-border/50 text-sm text-muted-foreground">
        <Loader2 className="w-4 h-4 animate-spin" />
        Parsing Excel file…
      </div>
    );
  }

  // ── Preview ───────────────────────────────────────────────────────────────────
  if (state === 'preview' && parseResult) {
    return (
      <div className="space-y-4 p-4 rounded-lg bg-muted/10 border border-border/50">
        {/* Stale-CI warning: PO selection changed after parse */}
        {poMismatch && (
          <div className="flex items-start gap-2 px-3 py-2 rounded-lg border border-amber-300 bg-amber-50 text-amber-800 text-xs">
            <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
            <span>
              The PO selection has changed since this CI was parsed. Re-upload the file to match the current PO(s).
            </span>
          </div>
        )}
        {/* Invoice header summary */}
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-0.5">
            <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">
              Parsed Invoice
            </p>
            <p className="text-sm font-bold">
              {parseResult.header.invoice_number || 'No invoice number found'}
            </p>
            <p className="text-xs text-muted-foreground">
              {parseResult.header.invoice_date || '—'}
              {' · '}
              <span className="font-medium text-foreground">
                $
                {Number(parseResult.header.total_value).toLocaleString(undefined, {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                })}
              </span>
            </p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            type="button"
            onClick={handleReupload}
            className="h-7 gap-1.5 text-xs text-muted-foreground flex-shrink-0"
          >
            <RotateCcw className="w-3 h-3" /> Re-upload
          </Button>
        </div>

        {/* PO shipping summary */}
        {parseResult.poSummary && parseResult.poSummary.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">PO Shipping Summary</p>
            <div className="overflow-x-auto rounded-lg border border-border/50">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border/50 bg-muted/30">
                    <th className="text-left font-semibold text-muted-foreground px-3 py-2">PO #</th>
                    <th className="text-right font-semibold text-muted-foreground px-3 py-2">Shipped Qty</th>
                    <th className="text-right font-semibold text-muted-foreground px-3 py-2">Cartons</th>
                    <th className="text-right font-semibold text-muted-foreground px-3 py-2">Weight (kg)</th>
                    <th className="text-right font-semibold text-muted-foreground px-3 py-2">CBM</th>
                  </tr>
                </thead>
                <tbody>
                  {parseResult.poSummary.map((row, i) => (
                    <tr key={i} className="border-b border-border/30 last:border-0">
                      <td className="px-3 py-2 font-mono font-semibold text-primary">{row.po_number}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{row.shipped_qty.toLocaleString()}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{row.cartons.toLocaleString()}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{row.weight_kg.toLocaleString()}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{row.cbm.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <CiPreviewTable lineItems={parseResult.lineItems} summary={parseResult.summary} />

        <div className="flex justify-end pt-1">
          <Button size="sm" type="button" onClick={handleConfirm} className="gap-2">
            <CheckCircle2 className="w-4 h-4" /> Confirm CI
          </Button>
        </div>

        <input ref={fileInputRef} type="file" accept=".xlsx,.xls" className="hidden" onChange={handleFileChange} />
      </div>
    );
  }

  // ── Idle ──────────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-2">
      <input
        ref={fileInputRef}
        type="file"
        accept=".xlsx,.xls"
        className="hidden"
        onChange={handleFileChange}
      />
      <button
        type="button"
        onClick={triggerFilePicker}
        className="w-full flex items-center gap-3 p-3 rounded-lg border border-dashed border-border hover:border-primary hover:bg-primary/5 transition-all text-left group"
      >
        <div className="w-8 h-8 rounded-lg bg-muted flex items-center justify-center flex-shrink-0 group-hover:bg-primary/10 transition-colors">
          <FileSpreadsheet className="w-4 h-4 text-muted-foreground group-hover:text-primary" />
        </div>
        <div>
          <p className="text-sm font-medium text-foreground group-hover:text-primary transition-colors">
            Upload Commercial Invoice
          </p>
          <p className="text-[11px] text-muted-foreground">
            Excel format (.xlsx, .xls) · SKUs auto-matched to your PO
          </p>
        </div>
        <Upload className="w-4 h-4 text-muted-foreground ml-auto group-hover:text-primary flex-shrink-0 transition-colors" />
      </button>
    </div>
  );
}
