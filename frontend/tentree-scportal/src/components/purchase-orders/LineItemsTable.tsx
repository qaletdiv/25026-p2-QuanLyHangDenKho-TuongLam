'use client';

import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Plus, Trash2 } from 'lucide-react';

const PAGE_LIMIT = 10;

export interface LineItem {
  id?: string;
  sku_code: string;
  description: string;
  color: string;
  size: string;
  expected_qty: number;
  unit_price?: number;
}

interface LineItemsTableProps {
  items: LineItem[];
  editable: boolean;
  onChange?: (items: LineItem[]) => void;
}

export default function LineItemsTable({ items, editable, onChange }: LineItemsTableProps) {
  const [showAll, setShowAll] = useState(false);
  const visibleItems = showAll || editable ? items : items.slice(0, PAGE_LIMIT);
  const hiddenCount = items.length - PAGE_LIMIT;

  const handleChange = (idx: number, field: keyof LineItem, value: any) => {
    const updated = items.map((item, i) =>
      i === idx
        ? { ...item, [field]: field === 'expected_qty' || field === 'unit_price' ? Number(value) || 0 : value }
        : item
    );
    onChange?.(updated);
  };

  const handleAdd = () => {
    onChange?.([
      ...items,
      { id: `li_new_${Date.now()}`, sku_code: '', description: '', color: '', size: '', expected_qty: 0, unit_price: 0 },
    ]);
  };

  const handleDelete = (idx: number) => {
    onChange?.(items.filter((_, i) => i !== idx));
  };

  const totalQty = items.reduce((sum, item) => sum + (Number(item.expected_qty) || 0), 0);

  if (!editable && items.length === 0) {
    return <p className="text-sm text-muted-foreground italic py-2 px-1">No line items added yet.</p>;
  }

  return (
    <div className="space-y-3">
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-xs min-w-[560px] bg-card">
          <thead>
            <tr className="border-b border-border bg-card/80">
              <th className="text-left font-semibold text-muted-foreground px-3 py-2 uppercase tracking-wider">SKU Code</th>
              <th className="text-left font-semibold text-muted-foreground px-3 py-2 uppercase tracking-wider">Description</th>
              <th className="text-left font-semibold text-muted-foreground px-3 py-2 uppercase tracking-wider">Color</th>
              <th className="text-left font-semibold text-muted-foreground px-3 py-2 uppercase tracking-wider">Size</th>
              <th className="text-right font-semibold text-muted-foreground px-3 py-2 uppercase tracking-wider">Qty</th>
              <th className="text-right font-semibold text-muted-foreground px-3 py-2 uppercase tracking-wider">Unit $</th>
              {editable && <th className="w-8 px-1 py-2" />}
            </tr>
          </thead>
          <tbody>
            {visibleItems.map((item, idx) => (
              <tr key={item.id || idx} className="border-b border-border last:border-0 hover:bg-muted/30 transition-colors">
                {editable ? (
                  <>
                    <td className="px-2 py-1.5">
                      <Input
                        value={item.sku_code}
                        onChange={e => handleChange(idx, 'sku_code', e.target.value)}
                        className="h-7 text-xs font-mono w-32 bg-background"
                        placeholder="SKU-CODE"
                      />
                    </td>
                    <td className="px-2 py-1.5">
                      <Input
                        value={item.description}
                        onChange={e => handleChange(idx, 'description', e.target.value)}
                        className="h-7 text-xs w-36 bg-background"
                        placeholder="Description"
                      />
                    </td>
                    <td className="px-2 py-1.5">
                      <Input
                        value={item.color}
                        onChange={e => handleChange(idx, 'color', e.target.value)}
                        className="h-7 text-xs w-20 bg-background"
                        placeholder="Color"
                      />
                    </td>
                    <td className="px-2 py-1.5">
                      <Input
                        value={item.size}
                        onChange={e => handleChange(idx, 'size', e.target.value)}
                        className="h-7 text-xs w-14 bg-background"
                        placeholder="S/M/L"
                      />
                    </td>
                    <td className="px-2 py-1.5">
                      <Input
                        type="number"
                        value={item.expected_qty}
                        onChange={e => handleChange(idx, 'expected_qty', e.target.value)}
                        className="h-7 text-xs w-20 bg-background text-right"
                        min={0}
                      />
                    </td>
                    <td className="px-2 py-1.5">
                      <Input
                        type="number"
                        value={item.unit_price ?? ''}
                        onChange={e => handleChange(idx, 'unit_price', e.target.value)}
                        className="h-7 text-xs w-20 bg-background text-right"
                        placeholder="0.00"
                        min={0}
                        step="0.01"
                      />
                    </td>
                    <td className="px-1 py-1.5">
                      <Button
                        variant="ghost"
                        size="icon"
                        type="button"
                        onClick={() => handleDelete(idx)}
                        className="h-6 w-6 text-muted-foreground hover:text-destructive"
                      >
                        <Trash2 className="w-3 h-3" />
                      </Button>
                    </td>
                  </>
                ) : (
                  <>
                    <td className="px-3 py-2 font-mono font-semibold text-primary">{item.sku_code || '—'}</td>
                    <td className="px-3 py-2 text-foreground">{item.description || '—'}</td>
                    <td className="px-3 py-2 text-muted-foreground">{item.color || '—'}</td>
                    <td className="px-3 py-2 text-muted-foreground font-medium">{item.size || '—'}</td>
                    <td className="px-3 py-2 text-right font-semibold tabular-nums">{Number(item.expected_qty).toLocaleString()}</td>
                    <td className="px-3 py-2 text-right text-muted-foreground tabular-nums">
                      {item.unit_price != null && item.unit_price !== 0 ? `$${Number(item.unit_price).toFixed(2)}` : '—'}
                    </td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-border bg-card/80">
              <td colSpan={4} className="px-3 py-2 text-xs font-bold text-muted-foreground uppercase tracking-wider">
                Total ({items.length} SKU{items.length !== 1 ? 's' : ''})
              </td>
              <td className="px-3 py-2 text-right text-sm font-bold text-primary tabular-nums">
                {totalQty.toLocaleString()}
              </td>
              <td className="px-3 py-2" />
              {editable && <td />}
            </tr>
          </tfoot>
        </table>
      </div>

      {!editable && hiddenCount > 0 && (
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" type="button" onClick={() => setShowAll(true)} className="h-7 text-xs text-muted-foreground hover:text-foreground">
            View {hiddenCount} more SKU{hiddenCount !== 1 ? 's' : ''}
          </Button>
          <span className="text-muted-foreground/40 text-xs">·</span>
          <Button variant="ghost" size="sm" type="button" onClick={() => setShowAll(false)} disabled={!showAll} className="h-7 text-xs text-muted-foreground hover:text-foreground disabled:opacity-30">
            Collapse
          </Button>
        </div>
      )}

      {editable && (
        <Button variant="outline" size="sm" type="button" onClick={handleAdd} className="h-7 gap-1.5 text-xs">
          <Plus className="w-3.5 h-3.5" /> Add SKU
        </Button>
      )}
    </div>
  );
}
