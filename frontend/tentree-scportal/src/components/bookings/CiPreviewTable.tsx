'use client';

import React from 'react';
import { Badge } from '@/components/ui/badge';
import { CheckCircle2, AlertCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { CILineItem } from '@/app/actions/commercial-invoices';

interface CiPreviewTableProps {
  lineItems: CILineItem[];
  summary: {
    total_items: number;
    matched: number;
    unmatched: number;
    total_qty: number;
  };
}

export default function CiPreviewTable({ lineItems, summary }: CiPreviewTableProps) {
  if (lineItems.length === 0) {
    return <p className="text-sm text-muted-foreground italic py-2 px-1">No line items parsed.</p>;
  }

  return (
    <div className="space-y-3">
      {/* F3 — Unmatched SKU warning banner */}
      {lineItems.some(item => item.match_status === 'unmatched') && (
        <div className="flex items-start gap-2 px-3 py-2 rounded-lg border border-amber-200 bg-amber-50 text-amber-800 text-xs">
          <span className="font-bold flex-shrink-0">Warning:</span>
          <span>
            {lineItems.filter(item => item.match_status === 'unmatched').length} SKU(s) not found in PO — they will not count toward fulfillment.
          </span>
        </div>
      )}
      <div className="overflow-x-auto rounded-lg border border-border/50">
        <table className="w-full text-xs min-w-[560px]">
          <thead>
            <tr className="border-b border-border/50 bg-muted/30">
              <th className="text-left font-semibold text-muted-foreground px-3 py-2 uppercase tracking-wider">SKU</th>
              <th className="text-left font-semibold text-muted-foreground px-3 py-2 uppercase tracking-wider">Description</th>
              <th className="text-right font-semibold text-muted-foreground px-3 py-2 uppercase tracking-wider">CI Qty</th>
              <th className="text-right font-semibold text-muted-foreground px-3 py-2 uppercase tracking-wider">Weight (kg)</th>
              <th className="text-right font-semibold text-muted-foreground px-3 py-2 uppercase tracking-wider">CBM</th>
              <th className="text-right font-semibold text-muted-foreground px-3 py-2 uppercase tracking-wider">PO Expected</th>
              <th className="text-right font-semibold text-muted-foreground px-3 py-2 uppercase tracking-wider">Δ</th>
              <th className="text-center font-semibold text-muted-foreground px-3 py-2 uppercase tracking-wider">Status</th>
            </tr>
          </thead>
          <tbody>
            {lineItems.map((item, idx) => {
              const isUnmatched = item.match_status === 'unmatched';
              const delta =
                item.po_expected_qty != null ? item.qty - item.po_expected_qty : null;

              return (
                <tr
                  key={idx}
                  className={cn(
                    'border-b border-border/30 last:border-0 transition-colors',
                    isUnmatched ? 'bg-amber-500/5' : 'hover:bg-muted/10'
                  )}
                >
                  <td className="px-3 py-2 font-mono font-semibold text-primary">{item.sku_code}</td>
                  <td className="px-3 py-2 text-foreground max-w-[140px] truncate">{item.description || '—'}</td>
                  <td className="px-3 py-2 text-right font-semibold tabular-nums">{item.qty.toLocaleString()}</td>
                  <td className="px-3 py-2 text-right font-semibold tabular-nums">{item.weight_kg ? item.weight_kg.toFixed(2) : '—'}</td>
                  <td className="px-3 py-2 text-right font-semibold tabular-nums">{item.cbm ? item.cbm.toFixed(3) : '—'}</td>
                  <td className="px-3 py-2 text-right text-muted-foreground tabular-nums">
                    {item.po_expected_qty != null ? item.po_expected_qty.toLocaleString() : '—'}
                  </td>
                  <td
                    className={cn(
                      'px-3 py-2 text-right font-semibold tabular-nums',
                      delta == null
                        ? 'text-muted-foreground italic'
                        : delta < 0
                        ? 'text-amber-600'
                        : delta > 0
                        ? 'text-blue-600'
                        : 'text-emerald-600'
                    )}
                    title={delta == null ? 'SKU not found in selected PO(s)' : undefined}
                  >
                    {delta == null
                      ? 'N/A — not on PO'
                      : delta === 0
                      ? '='
                      : delta > 0
                      ? `+${delta.toLocaleString()}`
                      : delta.toLocaleString()}
                  </td>
                  <td className="px-3 py-2 text-center">
                    {isUnmatched ? (
                      <Badge
                        variant="outline"
                        className="text-[9px] font-bold gap-1 border-amber-400/50 text-amber-600 bg-amber-500/5"
                      >
                        <AlertCircle className="w-2.5 h-2.5" /> Unmatched
                      </Badge>
                    ) : (
                      <Badge
                        variant="outline"
                        className="text-[9px] font-bold gap-1 border-emerald-400/50 text-emerald-600 bg-emerald-500/5"
                      >
                        <CheckCircle2 className="w-2.5 h-2.5" /> Matched
                      </Badge>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="border-t border-border/50 bg-muted/20">
              <td
                colSpan={2}
                className="px-3 py-2 text-xs font-bold text-muted-foreground uppercase tracking-wider"
              >
                Total ({lineItems.length} SKU{lineItems.length !== 1 ? 's' : ''})
              </td>
              <td className="px-3 py-2 text-right text-sm font-bold text-primary tabular-nums">
                {summary.total_qty.toLocaleString()}
              </td>
              <td className="px-3 py-2 text-right text-sm font-bold text-primary tabular-nums">
                {lineItems.reduce((acc, item) => acc + (item.weight_kg || 0), 0).toFixed(2)}
              </td>
              <td className="px-3 py-2 text-right text-sm font-bold text-primary tabular-nums">
                {lineItems.reduce((acc, item) => acc + (item.cbm || 0), 0).toFixed(3)}
              </td>
              <td colSpan={3} className="px-3 py-2" />
            </tr>
          </tfoot>
        </table>
      </div>

      {/* Summary badges */}
      <div className="flex items-center gap-2 flex-wrap">
        <Badge
          variant="secondary"
          className="text-[10px] gap-1 bg-emerald-500/10 text-emerald-700 border-emerald-200"
        >
          <CheckCircle2 className="w-3 h-3" /> {summary.matched} matched
        </Badge>
        {summary.unmatched > 0 && (
          <>
            <Badge
              variant="secondary"
              className="text-[10px] gap-1 bg-amber-500/10 text-amber-700 border-amber-200"
            >
              <AlertCircle className="w-3 h-3" /> {summary.unmatched} unmatched
            </Badge>
            <p className="text-[10px] text-muted-foreground">
              Unmatched SKUs are not in the selected PO(s). You can still confirm.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
