'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { Pencil, RotateCcw, Loader2 } from 'lucide-react';
import { DASH, usd, usdSigned, num, varianceTone, VerdictBadge, ConfidenceBadge } from './shared';
import { setLineOverride, clearLineOverride } from '../actions';
import type { InvoiceLine, ChargeCode } from '../types';

type Filter = 'attention' | 'variance' | 'all';

const CLASSES = ['US - Whsle', 'US - Online', 'US - Corp', 'Mobile Mini'];

/**
 * The coded detail. Defaults to the ATTENTION filter — 3,775 lines is not a
 * review queue, and the whole point is that only the handful the machine could
 * not settle needs a human.
 */
export default function LinesTable({
  invoiceNo, lines, chargeCodes, readOnly,
}: { invoiceNo: string; lines: InvoiceLine[]; chargeCodes: ChargeCode[]; readOnly?: boolean }) {
  const router = useRouter();
  const [filter, setFilter] = useState<Filter>('attention');
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<InvoiceLine | null>(null);

  const counts = useMemo(() => ({
    attention: lines.filter(l => l.coding_status !== 'coded').length,
    variance: lines.filter(l => l.verdict !== 'ok' && l.verdict !== 'no_contract_rate').length,
    all: lines.length,
  }), [lines]);

  const rows = useMemo(() => {
    const base = filter === 'attention' ? lines.filter(l => l.coding_status !== 'coded')
      : filter === 'variance' ? lines.filter(l => l.verdict !== 'ok' && l.verdict !== 'no_contract_rate')
        : lines;
    const needle = q.trim().toLowerCase();
    const searched = needle
      ? base.filter(l => [l.service, l.customer, l.client_ref_1, l.order, l.po_number, String(l.gl)]
        .some(v => v && String(v).toLowerCase().includes(needle)))
      : base;
    return searched.slice(0, 400);
  }, [lines, filter, q]);

  return (
    <section className="rounded-lg border border-border bg-card">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
        <h2 className="text-sm font-semibold">Coded lines</h2>
        <div className="flex gap-1">
          {(['attention', 'variance', 'all'] as Filter[]).map(f => (
            <Button
              key={f}
              size="sm"
              variant={filter === f ? 'default' : 'ghost'}
              className="h-7 px-2 text-xs"
              onClick={() => setFilter(f)}
            >
              {f === 'attention' ? 'Needs a decision' : f === 'variance' ? 'Off agreement' : 'All'}
              <span className="ml-1 opacity-70">{counts[f]}</span>
            </Button>
          ))}
        </div>
        <Input
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder="Search service, customer, ref…"
          className="ml-auto h-8 w-full max-w-56 text-xs"
        />
      </div>

      {rows.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-muted-foreground">
          {filter === 'attention'
            ? 'Every line is coded — nothing needs a decision.'
            : 'Nothing matches this filter.'}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-card/80">
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-3 py-2 font-medium">#</th>
                <th className="px-3 py-2 font-medium">Service</th>
                <th className="px-3 py-2 font-medium">Customer</th>
                <th className="px-3 py-2 text-right font-medium">Units</th>
                <th className="px-3 py-2 text-right font-medium">Charged</th>
                <th className="px-3 py-2 text-right font-medium">Agreement</th>
                <th className="px-3 py-2 text-right font-medium">Var</th>
                <th className="px-3 py-2 font-medium">GL</th>
                <th className="px-3 py-2 font-medium">Class</th>
                <th className="px-3 py-2 font-medium">Basis</th>
                <th className="px-3 py-2 font-medium">Verdict</th>
                {!readOnly && <th className="px-3 py-2" />}
              </tr>
            </thead>
            <tbody>
              {rows.map(l => (
                <tr
                  key={l.seq}
                  className={cn(
                    'border-b border-border last:border-0 hover:bg-muted/30',
                    l.coding_status !== 'coded' && 'bg-amber-500/5',
                  )}
                >
                  <td className="px-3 py-2 font-mono text-xs text-muted-foreground">{l.seq}</td>
                  <td className="px-3 py-2">
                    <span className="font-medium">{l.service ?? '(blank)'}</span>
                    {l.check_detail && (
                      <span className="mt-0.5 block max-w-md text-xs text-muted-foreground">{l.check_detail}</span>
                    )}
                    {l.coding_reason && (
                      <span className="mt-0.5 block max-w-md text-xs text-amber-700 dark:text-amber-300">{l.coding_reason}</span>
                    )}
                  </td>
                  <td className="px-3 py-2 max-w-44 truncate text-xs text-muted-foreground" title={l.customer ?? ''}>
                    {l.customer ?? DASH}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{num(l.units)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{usd(l.charges)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{usd(l.expected)}</td>
                  <td className={cn('px-3 py-2 text-right tabular-nums', varianceTone(l.variance))}>
                    {l.variance === null ? DASH : usdSigned(l.variance)}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">
                    {l.gl ?? <span className="text-red-600 dark:text-red-400">none</span>}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {l.class ?? <span className="text-red-600 dark:text-red-400">none</span>}
                    {l.class && l.legend_class && l.class !== l.legend_class && (
                      <span className="mt-0.5 block text-[11px] text-muted-foreground">
                        legend said {l.legend_class}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <ConfidenceBadge basis={l.class_basis} confidence={l.class_confidence} />
                  </td>
                  <td className="px-3 py-2"><VerdictBadge verdict={l.verdict} /></td>
                  {!readOnly && (
                    <td className="px-3 py-2 text-right">
                      <Button variant="ghost" size="sm" className="h-7 px-2" onClick={() => setEditing(l)}>
                        <Pencil className="h-3.5 w-3.5" />
                        <span className="sr-only">Set coding for line {l.seq}</span>
                      </Button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {rows.length === 400 && (
        <p className="border-t border-border px-4 py-2 text-xs text-muted-foreground">
          Showing the first 400 matches — narrow the search to see more.
        </p>
      )}

      {editing && (
        <OverrideDialog
          invoiceNo={invoiceNo}
          line={editing}
          chargeCodes={chargeCodes}
          onClose={() => setEditing(null)}
          onDone={() => { setEditing(null); router.refresh(); }}
        />
      )}
    </section>
  );
}

function OverrideDialog({
  invoiceNo, line, chargeCodes, onClose, onDone,
}: {
  invoiceNo: string; line: InvoiceLine; chargeCodes: ChargeCode[];
  onClose: () => void; onDone: () => void;
}) {
  const [gl, setGl] = useState<string>(line.gl === null ? '' : String(line.gl));
  const [cls, setCls] = useState<string>(line.class ?? '');
  const [note, setNote] = useState<string>(line.override_note ?? '');
  const [busy, setBusy] = useState(false);

  const glOptions = useMemo(() => {
    const seen = new Map<number, string>();
    for (const c of chargeCodes) if (c.gl !== null && !seen.has(c.gl)) seen.set(c.gl, c.gl_desc ?? '');
    return [...seen.entries()].sort((a, b) => a[0] - b[0]);
  }, [chargeCodes]);

  const save = async () => {
    setBusy(true);
    const res = await setLineOverride(invoiceNo, line.seq, {
      gl: gl === '' ? null : Number(gl),
      class: cls || null,
      note: note || null,
    });
    setBusy(false);
    if (res?.error) return toast.error(res.error);
    toast.success(`Line ${line.seq} coding recorded.`);
    onDone();
  };

  const reset = async () => {
    setBusy(true);
    const res = await clearLineOverride(invoiceNo, line.seq);
    setBusy(false);
    if (res?.error) return toast.error(res.error);
    toast.success(`Line ${line.seq} reverted to the derived coding.`);
    onDone();
  };

  return (
    <Dialog open onOpenChange={o => { if (!o) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Code line {line.seq} — {line.service ?? '(blank)'}</DialogTitle>
        </DialogHeader>

        <div className="space-y-3 text-sm">
          <div className="rounded border border-border bg-muted/20 p-3 text-xs">
            <p><span className="text-muted-foreground">Charged</span> {usd(line.charges)} · <span className="text-muted-foreground">units</span> {num(line.units)}</p>
            {line.customer && <p className="mt-1"><span className="text-muted-foreground">Customer</span> {line.customer}</p>}
            {line.client_ref_1 && <p className="mt-1"><span className="text-muted-foreground">Ref</span> {line.client_ref_1}</p>}
            {line.coding_reason && <p className="mt-1 text-amber-700 dark:text-amber-300">{line.coding_reason}</p>}
            {line.legend_note && <p className="mt-1 text-muted-foreground">Legend note: {line.legend_note}</p>}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor={`gl-${line.seq}`}>GL account</Label>
              <Select value={gl} onValueChange={(v) => setGl(v ?? "")}>
                <SelectTrigger id={`gl-${line.seq}`}>{gl || 'Derived / none'}</SelectTrigger>
                <SelectContent>
                  {glOptions.map(([code, desc]) => (
                    <SelectItem key={code} value={String(code)}>{code} — {desc.split(':').pop()?.trim()}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`cls-${line.seq}`}>Class</Label>
              <Select value={cls} onValueChange={(v) => setCls(v ?? "")}>
                <SelectTrigger id={`cls-${line.seq}`}>{cls || 'Derived / none'}</SelectTrigger>
                <SelectContent>
                  {CLASSES.map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor={`note-${line.seq}`}>Why (kept with the decision)</Label>
            <Input id={`note-${line.seq}`} value={note} onChange={e => setNote(e.target.value)}
              placeholder="e.g. wholesale return — Nordstrom dropship" />
          </div>

          <p className="text-xs text-muted-foreground">
            Stored against invoice {invoiceNo} line {line.seq}, so loading another invoice can never
            shift it onto a different row.
          </p>
        </div>

        <div className="flex justify-between gap-2 pt-2">
          <Button variant="ghost" onClick={reset} disabled={busy}>
            <RotateCcw className="mr-2 h-4 w-4" /> Revert to derived
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
            <Button onClick={save} disabled={busy}>
              {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} Save
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
