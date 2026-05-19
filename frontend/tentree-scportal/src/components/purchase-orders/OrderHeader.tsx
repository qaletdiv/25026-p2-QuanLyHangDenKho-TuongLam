'use client';

import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  ArrowLeft, Save, Edit3, Trash2, Copy,
  Package, Building2, Layers, X,
} from 'lucide-react';
import type { Order } from '@/types/order';

interface OrderHeaderProps {
  formData: Partial<Order>;
  isEditing: boolean;
  isNew: boolean;
  isSaving: boolean;
  canEdit: boolean;
  canDelete: boolean;
  onBack: () => void;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSave: () => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onPoNumberChange: (value: string) => void;
}

export default function OrderHeader({
  formData,
  isEditing,
  isNew,
  isSaving,
  canEdit,
  canDelete,
  onBack,
  onStartEdit,
  onCancelEdit,
  onSave,
  onDelete,
  onDuplicate,
  onPoNumberChange,
}: OrderHeaderProps) {
  return (
    <div className="border-b border-border bg-muted/30 px-6 py-4 flex-shrink-0">
      <div className="max-w-3xl mx-auto">

        {/* Top row: breadcrumb + action buttons */}
        <div className="flex items-center justify-between gap-4">
          <Button
            variant="ghost"
            size="sm"
            onClick={onBack}
            className="gap-1.5 text-muted-foreground hover:text-foreground -ml-2 h-8"
          >
            <ArrowLeft className="w-4 h-4" />
            Purchase Orders
          </Button>

          <div className="flex items-center gap-1">
            {!isEditing ? (
              <>
                <Button
                  variant="ghost" size="sm"
                  onClick={onDuplicate}
                  className="h-8 w-8 p-0 text-muted-foreground hover:text-primary"
                  title="Duplicate"
                >
                  <Copy className="w-4 h-4" />
                </Button>
                {canDelete && (
                  <Button
                    variant="ghost" size="sm"
                    onClick={onDelete}
                    className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive"
                    title="Delete"
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                )}
                {canEdit && (
                  <Button
                    variant="ghost" size="sm"
                    onClick={onStartEdit}
                    className="h-8 gap-1.5 px-3 text-primary hover:text-primary hover:bg-primary/10 ml-1"
                  >
                    <Edit3 className="w-4 h-4" /> Edit
                  </Button>
                )}
              </>
            ) : (
              <div className="flex items-center gap-2">
                {!isNew && (
                  <Button variant="ghost" size="sm" onClick={onCancelEdit} className="h-8 w-8 p-0">
                    <X className="w-4 h-4" />
                  </Button>
                )}
                <Button size="sm" onClick={onSave} disabled={isSaving} className="h-8 gap-1.5 px-4">
                  <Save className="w-4 h-4" />
                  {isSaving ? 'Saving…' : 'Save'}
                </Button>
              </div>
            )}
          </div>
        </div>

        {/* Hero row: icon + PO# + meta badges */}
        <div className="flex items-start gap-4 mt-4">
          <div className="w-11 h-11 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center flex-shrink-0">
            <Package className="w-5 h-5 text-primary" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-3 flex-wrap">
              {isEditing ? (
                <Input
                  value={formData.po_number || ''}
                  onChange={e => onPoNumberChange(e.target.value)}
                  className="h-8 bg-background border-primary/30 focus:border-primary w-44 text-lg font-bold"
                  placeholder="PO Number"
                />
              ) : (
                <h1 className="text-2xl font-bold tracking-tight">
                  {formData.po_number || 'New PO'}
                </h1>
              )}
              {formData.booking_status && (
                <Badge variant="secondary" className="text-[10px] font-bold uppercase tracking-widest px-2 py-0.5">
                  {formData.booking_status}
                </Badge>
              )}
              {formData.booking_number && (
                <span className="text-xs font-mono text-muted-foreground">{formData.booking_number}</span>
              )}
            </div>
            <div className="flex items-center gap-3 mt-1.5 flex-wrap">
              <span className="flex items-center gap-1.5 text-sm text-muted-foreground font-medium">
                <Building2 className="w-3.5 h-3.5" />
                {formData.supplier || 'Unassigned'}
              </span>
              {formData.season && (
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground uppercase tracking-wider font-medium">
                  <Layers className="w-3 h-3" />
                  {formData.season}
                </span>
              )}
              {formData.type && (
                <Badge variant="outline" className="text-[10px] font-bold uppercase px-1.5 py-0 h-4 border-primary/30 text-primary">
                  {formData.type}
                </Badge>
              )}
            </div>
          </div>
        </div>

      </div>
    </div>
  );
}
