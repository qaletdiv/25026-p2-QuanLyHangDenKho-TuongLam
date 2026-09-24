'use client';

// One tab per invoicing WAREHOUSE, driven by the registry rather than by a list
// in this file — the section used to be "NRI Invoices" with NRI US hardcoded, and
// every 3PL bills on its own format, so which warehouses exist is data.
//
// Same visual as the Mainline | SMS strips (ModuleTabs / LandedCostsTabs), plus
// an "Add warehouse" affordance because the set grows.

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Plus, Lock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { addInvoiceSource } from '../actions';
import type { InvoiceSource } from '../types';

const NONE = '__none__';

export default function WarehouseTabs({
  sources, facilities = [],
}: { sources: InvoiceSource[]; facilities?: { id: string; name: string }[] }) {
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState('');
  const [entity, setEntity] = useState('');
  const [facilityId, setFacilityId] = useState<string>(NONE);
  const [saving, startSaving] = useTransition();

  // A facility already registered to another warehouse would make the link
  // ambiguous, so it is offered only once.
  const taken = new Set(sources.map((s) => s.facilityId).filter(Boolean) as string[]);
  const free = facilities.filter((f) => !taken.has(f.id));

  const submit = () => {
    if (!label.trim()) return void toast.error('Give the warehouse a name.');
    startSaving(async () => {
      const res = await addInvoiceSource({
        label: label.trim(),
        entity: entity.trim() || undefined,
        facilityId: facilityId === NONE ? null : facilityId,
      });
      if ('error' in res) return void toast.error(res.error);
      toast.success(`${res.label} added — uploads stay off until its invoice format is mapped.`);
      setOpen(false); setLabel(''); setEntity(''); setFacilityId(NONE);
      router.push(`/invoices/${res.code}`);
      router.refresh();
    });
  };

  return (
    <>
      <div className="flex flex-wrap items-center gap-1 border-b border-border">
        {sources.map((s) => {
          const href = `/invoices/${s.code}`;
          const active = pathname === href || pathname.startsWith(`${href}/`);
          return (
            <Link
              key={s.code}
              href={href}
              className={cn(
                '-mb-px inline-flex items-center gap-1.5 border-b-2 px-4 py-2 text-sm font-semibold transition-colors',
                active ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              {s.label}
              {/* a shell tab says so on the tab itself — otherwise you find out by
                  looking for an upload box that isn't there */}
              {!s.uploadEnabled && (
                <Lock className="h-3 w-3 text-muted-foreground" aria-label="uploads not enabled yet" />
              )}
              {typeof s.invoiceCount === 'number' && s.invoiceCount > 0 && (
                <span className="text-xs font-normal text-muted-foreground">({s.invoiceCount})</span>
              )}
            </Link>
          );
        })}
        <Button
          size="sm" variant="ghost"
          className="my-1 ml-1 h-7 text-muted-foreground"
          onClick={() => setOpen(true)}
          title="Register another invoicing warehouse"
        >
          <Plus className="mr-1 h-3.5 w-3.5" /> Add warehouse
        </Button>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Add an invoicing warehouse</DialogTitle></DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1">
              <Label className="text-xs uppercase tracking-wide text-muted-foreground">Warehouse name</Label>
              <Input placeholder="e.g. NRI Europe" value={label} onChange={(e) => setLabel(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs uppercase tracking-wide text-muted-foreground">Entity code (optional)</Label>
              <Input placeholder="derived from the name — e.g. EU" value={entity} onChange={(e) => setEntity(e.target.value)} />
              <p className="text-[11px] text-muted-foreground">
                The key its invoices, coding legend and rate card are filed under. Must be unique.
              </p>
            </div>
            <div className="space-y-1">
              <Label className="text-xs uppercase tracking-wide text-muted-foreground">Destination facility (optional)</Label>
              <Select value={facilityId} onValueChange={(v) => setFacilityId(v ?? NONE)}>
                <SelectTrigger className="w-full">
                  {facilityId === NONE ? <span className="text-muted-foreground">—</span> : (free.find((f) => f.id === facilityId)?.name ?? facilityId)}
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>—</SelectItem>
                  {free.map((f) => <SelectItem key={f.id} value={f.id}>{f.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <p className="rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-[11px] text-amber-700 dark:text-amber-300">
              It starts as a shell: the tab, its invoice list and its slice of the coding legend and rate
              card exist immediately, but <strong>uploads stay off</strong> until this warehouse&apos;s invoice
              file layout has been mapped. Every 3PL builds its workbook differently, and guessing a layout
              would load misread charges into the GL.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={saving}>Cancel</Button>
            <Button onClick={submit} disabled={saving}>{saving ? 'Adding…' : 'Add warehouse'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
