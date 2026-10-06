'use client';

/**
 * GL CODES — which GL each NRI service posts to, BY MONTH, and the place to change it.
 *
 * A month is an invoice's PERIOD-END month (the Aug 15 and Aug 31 files are August).
 * Saving a month stores its complete service → GL list, and later months use it until
 * another month is saved — so a GL change is made once, and a one-month exception is
 * that month changed and the next one changed back. A month with no settings of its
 * own says where its GLs come from (an earlier month, or the coding legend).
 *
 * Columns are service · legend · GL only (Lam, 2026-10-05 — the On wholesale orders,
 * Lines and Recoded by hand columns were removed). A wholesale-order GL already stored
 * is carried through a save unchanged, so saving here never drops one.
 *
 * Unchanged: the CODING LEGEND is what files marked Booked are coded by and is never
 * edited here, so a booked month is never re-coded; a line someone coded by hand
 * keeps its GL.
 */

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { AlertTriangle, Info, Loader2, Lock, Plus, Search, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select';
import ConfirmDialog from '@/modules/mainline/components/ConfirmDialog';
import { cn } from '@/lib/utils';
import { saveGlCodes, clearGlCodes } from '../actions';
import { EntitySwitch, count, DASH } from './shared';
import type { Entity, GlCodeRow, GlCodesPayload } from '../types';

/** "COGS : Distribution/Logistics : Fulfillment - Storage" → "Fulfillment - Storage" */
const shortDesc = (d: string | null | undefined) => (d ? d.split(':').pop()!.trim() : DASH);
const monthName = (ym: string | null) =>
  ym ? new Date(`${ym}-01T00:00:00`).toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) : DASH;

export default function GlCodesView({ entity, data }: { entity: Entity; data: GlCodesPayload | null }) {
  const router = useRouter();
  const go = (e: Entity, month?: string) =>
    router.push(`/invoices/gl-codes?entity=${e}${month ? `&month=${month}` : ''}`);
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <EntitySwitch value={entity} onChange={(e) => go(e)} />
        {data && (
          <Select value={data.month} onValueChange={(v) => v && go(entity, String(v))}>
            {/* label rendered directly: SelectValue cannot derive it for a programmatic value */}
            <SelectTrigger className="w-72">{monthName(data.month)}</SelectTrigger>
            <SelectContent>
              {[...data.months].reverse().map((m) => (
                <SelectItem key={m.month} value={m.month}>
                  {monthName(m.month)}
                  {' · '}{m.files ? `${m.files} file${m.files === 1 ? '' : 's'}${m.booked === m.files ? ', Booked' : ''}` : 'no files yet'}
                  {m.saved ? ' · GLs set' : ''}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>
      {data
        ? <Editor key={`${entity}-${data.month}-${data.savedAt}`} entity={entity} data={data} />
        : <p className="text-sm text-muted-foreground">Could not load the GL codes.</p>}
    </div>
  );
}

function Editor({ entity, data }: { entity: Entity; data: GlCodesPayload }) {
  const router = useRouter();
  const start0 = useMemo(() => Object.fromEntries(data.services.map((s) => [s.service, s.gl])), [data]);
  const [picked, setPicked] = useState<Record<string, number | null>>(start0);
  const [q, setQ] = useState('');
  const [billedOnly, setBilledOnly] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [saving, start] = useTransition();
  const desc = useMemo(() => new Map(data.glOptions.map((g) => [g.gl, g.glDesc])), [data]);
  // services ADDED here (a new NRI service, before its first invoice) and ones removed
  const [added, setAdded] = useState<GlCodeRow[]>([]);
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [newGl, setNewGl] = useState<number | null>(null);
  const rows = [...added, ...data.services.filter((s) => !removed.has(s.service))];
  const isNew = (s: GlCodeRow) => added.includes(s);
  // only a service the legend does not know and that has no lines this month can go
  const removable = (s: GlCodeRow) => s.legendGl === null && s.lines === 0;

  const valueOf = (s: GlCodeRow) => picked[s.service] ?? null;
  // the stored wholesale-order GL, carried through a save ("same" is stored as null)
  const wOf = (s: GlCodeRow) => (s.glWholesaleOrder === valueOf(s) ? null : s.glWholesaleOrder);
  const dirty = added.length > 0 || removed.size > 0 || data.services.some((s) => valueOf(s) !== s.gl);
  const uncoded = (s: GlCodeRow) => (valueOf(s) === null ? s.lines - s.handRecoded : 0);
  const noGl = data.services.filter((s) => uncoded(s) > 0);
  const shown = rows.filter((s) =>
    (!billedOnly || isNew(s) || s.lines > 0 || s.gl !== s.legendGl || s.gl === null || s.glWholesaleOrder !== null)
    && (!q.trim() || s.service.toLowerCase().includes(q.trim().toLowerCase())));

  const addService = () => {
    const name = newName.trim().replace(/\s+/g, ' ');
    if (!name) return void setError('Give the new service a name — exactly as NRI writes it on the invoice.');
    if (rows.some((r) => r.service.toLowerCase() === name.toLowerCase())) return void setError(`"${name}" is already in the list.`);
    if (newGl === null) return void setError(`Pick the GL "${name}" posts to.`);
    setError(null);
    setAdded((a) => [{ service: name, legendGl: null, legendDesc: null, gl: null, glWholesaleOrder: null, lines: 0, handRecoded: 0, handTo: {} }, ...a]);
    setPicked((p) => ({ ...p, [name]: newGl }));
    setNewName(''); setNewGl(null); setAdding(false);
  };
  const remove = (s: GlCodeRow) => {
    if (isNew(s)) setAdded((a) => a.filter((x) => x !== s));
    else setRemoved((r) => new Set(r).add(s.service));
  };
  const discard = () => { setPicked(start0); setAdded([]); setRemoved(new Set()); setAdding(false); setError(null); };
  const allBooked = data.files.total > 0 && data.files.booked === data.files.total;
  const month = monthName(data.month);

  const save = () => {
    setError(null);
    start(async () => {
      const res = await saveGlCodes(entity, data.month, rows.map((s) => ({ service: s.service, gl: valueOf(s), glWholesaleOrder: wOf(s) })));
      if ('error' in res) return void setError(res.error);
      toast.success(`GL codes saved for ${month} — later months use them until another month is saved.`);
      router.refresh();
    });
  };
  const clear = () => {
    start(async () => {
      const res = await clearGlCodes(entity, data.month);
      setConfirmClear(false);
      if ('error' in res) return void setError(res.error);
      toast.success(`${month} now uses ${data.months.some((m) => m.saved && m.month < data.month) ? 'the settings of an earlier month' : 'the coding legend'}.`);
      router.refresh();
    });
  };

  return (
    <div className="space-y-4">
      <p className="flex items-start gap-2 text-sm text-muted-foreground">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
        <span>
          The GL each NRI service posts to in <b className="text-foreground">{month}</b> invoices (by period-end month). Saving a month
          carries forward to later months until another month is saved. Files marked <b className="text-foreground">Booked</b> keep the
          coding legend, and a line someone coded by hand keeps its GL.
        </span>
      </p>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-border bg-card px-4 py-3 text-sm">
        <span>
          {data.source === 'own' && <>GLs <b>set for {month}</b>{data.savedBy ? <span className="text-muted-foreground"> by {data.savedBy}</span> : null}</>}
          {data.source === 'inherited' && <>Using the GLs set for <b>{monthName(data.inheritedFrom)}</b> — save to give {month} its own</>}
          {data.source === 'legend' && <>Using the <b>coding legend</b> — no month has GL settings yet</>}
        </span>
        <span className="text-muted-foreground">
          {data.files.total
            ? <>{count(data.files.total)} file{data.files.total === 1 ? '' : 's'} this month{data.files.booked ? `, ${count(data.files.booked)} Booked` : ''}</>
            : 'No files for this month yet'}
        </span>
        {allBooked && (
          <span className="flex items-center gap-1 text-amber-700 dark:text-amber-300">
            <Lock className="h-3.5 w-3.5" /> All of this month’s files are Booked — a change takes effect only if one is reopened
          </span>
        )}
        {data.source === 'own' && (
          <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setConfirmClear(true)} disabled={saving}>
            Clear {month}’s settings
          </Button>
        )}
      </div>

      {noGl.length > 0 && (
        <p className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-sm text-amber-900 dark:text-amber-100">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
          <span>
            Not in the coding legend, so lines nobody coded by hand have no GL:
            {' '}<b>{noGl.map((s) => `${s.service} (${count(uncoded(s))} line${uncoded(s) === 1 ? '' : 's'})`).join(', ')}</b>. Pick a GL below.
          </span>
        </p>
      )}

      <section className="rounded-lg border border-border bg-card">
        <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
          <h2 className="min-w-0 flex-1 text-sm font-semibold">GL by NRI service · {month}</h2>
          <Button size="sm" variant="outline" onClick={() => setAdding(true)} disabled={adding}>
            <Plus className="mr-1.5 h-4 w-4" /> Add service
          </Button>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input type="checkbox" checked={billedOnly} onChange={(e) => setBilledOnly(e.target.checked)} className="h-3.5 w-3.5 accent-primary" />
            Only services billed this month (and any changed)
          </label>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a service" className="h-8 w-48 pl-7" />
          </div>
        </div>
        {adding && (
          <div className="flex flex-wrap items-center gap-2 border-b border-border bg-primary/5 px-4 py-3 text-sm">
            <span className="font-medium">New service</span>
            <Input
              autoFocus value={newName} onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') addService(); if (e.key === 'Escape') setAdding(false); }}
              placeholder="Name exactly as on NRI’s invoice" className="h-8 w-72" aria-label="New service name"
            />
            <span className="text-muted-foreground">posts to</span>
            <Select value={newGl === null ? '' : String(newGl)} onValueChange={(v) => setNewGl(v ? Number(v) : null)}>
              <SelectTrigger className="h-8 w-64" aria-label="New service GL">{newGl === null ? 'Choose a GL' : `${newGl} · ${shortDesc(desc.get(newGl))}`}</SelectTrigger>
              <SelectContent>
                {data.glOptions.map((g) => <SelectItem key={g.gl} value={String(g.gl)}>{g.gl} · {shortDesc(g.glDesc)}</SelectItem>)}
              </SelectContent>
            </Select>
            <Button size="sm" onClick={addService}>Add</Button>
            <Button size="sm" variant="ghost" onClick={() => { setAdding(false); setError(null); }}>Cancel</Button>
            <span className="basis-full text-xs text-muted-foreground">
              Applies from {month} on, like every setting here. Set its channel on the Rules page (step 2).
            </span>
          </div>
        )}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-card/80 text-xs text-muted-foreground">
              <tr className="border-b border-border">
                <th className="px-4 py-2 text-left font-medium">NRI service</th>
                <th className="px-4 py-2 text-left font-medium">Coding legend</th>
                <th className="px-4 py-2 text-left font-medium">GL for {month}</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((s) => {
                const value = valueOf(s);
                const changed = isNew(s) || value !== s.gl;
                const differs = value !== null && value !== s.legendGl;
                return (
                  <tr key={s.service} className={cn('border-b border-border align-top hover:bg-muted/30', value === null && 'bg-amber-500/5')}>
                    <td className="px-4 py-2 font-medium">
                      <div className="flex items-center gap-1.5">
                        {s.service}
                        {isNew(s) && <span className="text-[10px] font-semibold uppercase text-primary">new</span>}
                        {removable(s) && (
                          <button type="button" onClick={() => remove(s)} aria-label={`Remove ${s.service}`} title={`Remove ${s.service} from ${month} on`}
                            className="text-muted-foreground hover:text-foreground">
                            <X className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-2">
                      {s.legendGl !== null
                        ? <><span className="font-mono text-xs">{s.legendGl}</span> <span className="text-muted-foreground">{shortDesc(s.legendDesc)}</span></>
                        : value !== null
                          ? <span className="text-muted-foreground">— not in the legend</span>
                          : <span className="text-amber-700 dark:text-amber-300">Not in the legend — no GL yet</span>}
                    </td>
                    <td className="px-4 py-2">
                      <div className="flex items-center gap-2">
                        <Select value={value === null ? '' : String(value)} onValueChange={(v) => setPicked((p) => ({ ...p, [s.service]: v ? Number(v) : null }))}>
                          <SelectTrigger className={cn('h-8 w-64', differs && 'border-primary/60 font-medium')}>
                            {value === null ? 'Choose a GL' : `${value} · ${shortDesc(desc.get(value))}`}
                          </SelectTrigger>
                          <SelectContent>
                            {data.glOptions.map((g) => (
                              <SelectItem key={g.gl} value={String(g.gl)}>
                                {g.gl} · {shortDesc(g.glDesc)}{g.gl === s.legendGl ? ' (legend)' : ''}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        {changed
                          ? <span className="text-[10px] font-semibold uppercase text-primary">unsaved</span>
                          : differs && (
                            // where this month's GL comes from, in words — not just "differs"
                            <span className="text-[10px] font-semibold uppercase text-muted-foreground"
                              title={s.legendGl === null ? 'Not in the coding legend — this GL comes from the GL Codes settings' : `The coding legend says ${s.legendGl}`}>
                              {data.source === 'own' ? `set for ${month}` : data.inheritedFrom ? `from ${monthName(data.inheritedFrom)}` : 'set here'}
                            </span>
                          )}
                      </div>
                    </td>
                  </tr>
                );
              })}
              {!shown.length && <tr><td colSpan={3} className="px-4 py-6 text-center text-sm text-muted-foreground">No services match.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      <div className="sticky bottom-0 z-10 flex flex-wrap items-center gap-2 border-t border-border bg-background/95 py-3 backdrop-blur">
        <div className="ml-auto flex items-center gap-2">
          {error
            ? <span role="alert" className="text-sm text-red-700 dark:text-red-300">{error}</span>
            : dirty && <span className="text-sm text-amber-700 dark:text-amber-300">Unsaved changes</span>}
          <Button variant="ghost" disabled={!dirty || saving} onClick={discard}>Discard</Button>
          <Button disabled={(!dirty && data.source === 'own') || saving} onClick={save}
            title={data.source !== 'own' && !dirty ? `Save the GLs shown as ${month}'s own` : undefined}>
            {saving && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />} Save for {month}
          </Button>
        </div>
      </div>

      <ConfirmDialog
        open={confirmClear}
        title={`Clear ${month}’s GL settings?`}
        description={<>{month} will use the GLs of the latest earlier month that has its own, or the coding legend. Later months that inherited from {month} move with it.</>}
        confirmLabel="Clear"
        destructive
        busy={saving}
        onConfirm={clear}
        onCancel={() => setConfirmClear(false)}
      />
    </div>
  );
}
