'use client';

/**
 * The lines behind a pivot cell / bucket / service — and the workbook's two
 * manual columns ("Manual Class Override", "Manual GL Code Override").
 *
 * Recoding applies to the ticked lines, or to EVERY line this panel matches
 * (not just the page on screen) — that is how the team codes a file: filter,
 * then fill down. A booked file refuses it until it is reopened on Uploads.
 */

import { useEffect, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { ChevronLeft, ChevronRight, Loader2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select';
import ConfirmDialog from '@/modules/mainline/components/ConfirmDialog';
import { cn } from '@/lib/utils';
import { getBillingLines, setBillingOverride } from '../actions';
import { money, count, signed, fmtDate, VerdictBadge } from './shared';
import type { CodedLine, LineFilter, LinePage, Scope } from '../types';

const PAGE = 50;
const KEEP = '__keep__';
const CLEAR = '__clear__';

export default function LinesPanel({
  scope, filter, title, classes, glOptions, onClose, onChanged,
}: {
  scope: Scope; filter: LineFilter; title: string;
  classes: string[]; glOptions: { gl: number; glDesc: string | null }[];
  onClose: () => void; onChanged: () => void;
}) {
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<LinePage | null>(null);
  const [loading, startLoad] = useTransition();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [cls, setCls] = useState<string>(KEEP);
  const [gl, setGl] = useState<string>(KEEP);
  const [confirm, setConfirm] = useState<null | 'all' | 'picked'>(null);
  const [saving, startSave] = useTransition();
  const [version, setVersion] = useState(0);

  const effective: LineFilter = { ...filter, ...(query ? { q: query } : {}) };

  useEffect(() => {
    startLoad(async () => {
      setData(await getBillingLines(scope, effective, page, PAGE));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, query, version]);

  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE)) : 1;
  const patch = {
    ...(cls === KEEP ? {} : { classOverride: cls === CLEAR ? null : cls }),
    ...(gl === KEEP ? {} : { glOverride: gl === CLEAR ? null : Number(gl) }),
  };
  const hasPatch = Object.keys(patch).length > 0;

  const apply = () => {
    const target = confirm === 'picked' ? { lineIds: [...picked] } : { filter: effective };
    startSave(async () => {
      const res = await setBillingOverride(scope, target, patch);
      setConfirm(null);
      if ('error' in res) return void toast.error(res.error);
      toast.success(`${count(res.updated)} lines recoded (${money(res.charges)}).`);
      setPicked(new Set()); setCls(KEEP); setGl(KEEP);
      setVersion((v) => v + 1);
      onChanged();
    });
  };

  const describe = () => [
    cls !== KEEP && (cls === CLEAR ? 'clear the manual class' : `class → ${cls}`),
    gl !== KEEP && (gl === CLEAR ? 'clear the manual GL' : `GL → ${gl}`),
  ].filter(Boolean).join(' and ');

  const togglePage = (on: boolean) => {
    const next = new Set(picked);
    for (const l of data?.lines ?? []) { if (on) next.add(l.id); else next.delete(l.id); }
    setPicked(next);
  };
  const allOnPage = !!data?.lines.length && data.lines.every((l) => picked.has(l.id));

  return (
    <section id="lines" className="scroll-mt-4 rounded-lg border border-primary/40 bg-card">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5">
        <h2 className="text-sm font-semibold">
          {title}
          {data && <span className="font-normal text-muted-foreground"> · {count(data.total)} lines · {money(data.charges)}</span>}
        </h2>
        <div className="flex items-center gap-2">
          <Input
            value={q} onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { setPage(1); setQuery(q.trim()); } }}
            placeholder="Order, reference, customer… ⏎" className="h-8 w-60"
          />
          <Button size="sm" variant="ghost" onClick={onClose} aria-label="Close"><X className="h-4 w-4" /></Button>
        </div>
      </div>

      {/* recode bar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-muted/20 px-4 py-2 text-sm">
        <span className="text-muted-foreground">Recode:</span>
        <Select value={cls} onValueChange={(v) => setCls(String(v ?? KEEP))}>
          <SelectTrigger className="h-8 w-44">{cls === KEEP ? 'Class — unchanged' : cls === CLEAR ? 'Class — clear manual' : cls}</SelectTrigger>
          <SelectContent>
            <SelectItem value={KEEP}>Class — unchanged</SelectItem>
            {classes.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
            <SelectItem value={CLEAR}>Class — clear manual</SelectItem>
          </SelectContent>
        </Select>
        <Select value={gl} onValueChange={(v) => setGl(String(v ?? KEEP))}>
          <SelectTrigger className="h-8 w-56">{gl === KEEP ? 'GL — unchanged' : gl === CLEAR ? 'GL — clear manual' : `GL ${gl}`}</SelectTrigger>
          <SelectContent>
            <SelectItem value={KEEP}>GL — unchanged</SelectItem>
            {glOptions.map((g) => <SelectItem key={g.gl} value={String(g.gl)}>{g.gl} · {(g.glDesc ?? '').split(':').pop()?.trim()}</SelectItem>)}
            <SelectItem value={CLEAR}>GL — clear manual</SelectItem>
          </SelectContent>
        </Select>
        <Button size="sm" disabled={!hasPatch || !picked.size || saving} onClick={() => setConfirm('picked')}>
          Apply to {count(picked.size)} ticked
        </Button>
        <Button size="sm" variant="outline" disabled={!hasPatch || !data?.total || saving} onClick={() => setConfirm('all')}>
          Apply to all {count(data?.total ?? 0)} lines
        </Button>
      </div>

      <div className={cn('overflow-x-auto', loading && 'opacity-60')}>
        <table className="w-full text-sm">
          <thead className="bg-card/80 text-xs text-muted-foreground">
            <tr className="border-b border-border">
              <th className="w-8 px-3 py-2"><Checkbox checked={allOnPage} onCheckedChange={(v) => togglePage(!!v)} aria-label="Tick this page" /></th>
              <th className="px-3 py-2 text-left font-medium">File</th>
              <th className="px-3 py-2 text-left font-medium">Order / ref</th>
              <th className="px-3 py-2 text-left font-medium">Customer</th>
              <th className="px-3 py-2 text-left font-medium">Completed</th>
              <th className="px-3 py-2 text-left font-medium">Service</th>
              <th className="px-3 py-2 text-right font-medium">Units</th>
              <th className="px-3 py-2 text-right font-medium">Charges</th>
              <th className="px-3 py-2 text-left font-medium">GL</th>
              <th className="px-3 py-2 text-left font-medium">Channel</th>
              <th className="px-3 py-2 text-left font-medium">Rate check</th>
            </tr>
          </thead>
          <tbody>
            {data?.lines.map((l) => <Row key={l.id} l={l} picked={picked.has(l.id)} onPick={(on) => {
              const next = new Set(picked); if (on) next.add(l.id); else next.delete(l.id); setPicked(next);
            }} />)}
            {data && !data.lines.length && (
              <tr><td colSpan={11} className="px-4 py-8 text-center text-muted-foreground">No lines match.</td></tr>
            )}
            {!data && loading && (
              <tr><td colSpan={11} className="px-4 py-8 text-center text-muted-foreground"><Loader2 className="mx-auto h-4 w-4 animate-spin" /></td></tr>
            )}
          </tbody>
        </table>
      </div>

      {data && data.total > PAGE && (
        <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-2 text-xs text-muted-foreground">
          {count((page - 1) * PAGE + 1)}–{count(Math.min(page * PAGE, data.total))} of {count(data.total)}
          <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => setPage(page - 1)} aria-label="Previous page"><ChevronLeft className="h-4 w-4" /></Button>
          <Button size="sm" variant="ghost" disabled={page >= pages} onClick={() => setPage(page + 1)} aria-label="Next page"><ChevronRight className="h-4 w-4" /></Button>
        </div>
      )}

      <ConfirmDialog
        open={!!confirm}
        title="Recode these lines?"
        description={confirm === 'picked'
          ? <>This will {describe()} on {count(picked.size)} ticked line(s).</>
          : <>This will {describe()} on <b>all {count(data?.total ?? 0)} lines</b> ({money(data?.charges ?? 0)}) matching “{title}”, not just this page.</>}
        confirmLabel="Recode"
        busy={saving}
        onConfirm={apply}
        onCancel={() => setConfirm(null)}
      />
    </section>
  );
}

function Row({ l, picked, onPick }: { l: CodedLine; picked: boolean; onPick: (on: boolean) => void }) {
  const rc = l.rateCheck;
  const detail = rc.verdict === 'overcharge' || rc.verdict === 'undercharge'
    ? `expected ${money(rc.expected)} · ${signed(rc.variance)}`
    : rc.verdict === 'qtyUnsupported' && rc.impliedHours !== undefined
      ? `${rc.impliedHours} h implied`
      : rc.verdict === 'tierBlend' && rc.impliedRate !== undefined
        ? `${money(rc.impliedRate, 4)}/unit`
        : null;
  return (
    <tr className={cn('border-b border-border align-top hover:bg-muted/30', picked && 'bg-primary/5')}>
      <td className="px-3 py-2"><Checkbox checked={picked} onCheckedChange={(v) => onPick(!!v)} aria-label="Tick line" /></td>
      <td className="max-w-[11rem] truncate px-3 py-2 text-xs text-muted-foreground" title={l.fileName}>{l.fileName?.replace(/^NRI (CA|US) Invoice /, '')}</td>
      <td className="px-3 py-2">
        <div className="font-mono text-xs">{l.orderId}</div>
        <div className="text-xs text-muted-foreground">{l.clientRef1}</div>
      </td>
      <td className="max-w-[14rem] truncate px-3 py-2" title={l.customer ?? ''}>{l.customer}</td>
      <td className="whitespace-nowrap px-3 py-2">{fmtDate(l.completed)}</td>
      <td className="px-3 py-2">{l.service}</td>
      <td className="px-3 py-2 text-right tabular-nums">{l.units}</td>
      <td className="px-3 py-2 text-right tabular-nums">{money(l.charges)}</td>
      <td className="px-3 py-2">
        <span className="font-mono text-xs">{l.revisedGl ?? '—'}</span>
        {l.glSource === 'manual' && <span className="ml-1 text-[10px] uppercase text-primary" title={`legend: ${l.netsuiteGl ?? 'none'}`}>manual</span>}
      </td>
      <td className="whitespace-nowrap px-3 py-2">
        {l.revisedClass ?? <span className="text-amber-700 dark:text-amber-300">No class</span>}
        <div className="text-[10px] uppercase text-muted-foreground" title={l.orderType ? `Order type ${l.orderType}` : undefined}>
          {l.classSource.replace('rule:', 'rule · ')}{l.orderType ? ` · ${l.orderType}` : ''}
        </div>
      </td>
      <td className="px-3 py-2">
        <VerdictBadge verdict={rc.verdict} />
        {detail && <div className="mt-0.5 text-xs text-muted-foreground tabular-nums">{detail}</div>}
      </td>
    </tr>
  );
}
