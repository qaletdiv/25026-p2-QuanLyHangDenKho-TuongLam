'use client';

/**
 * CHANNEL RULES — Wholesale or Ecomm, set by dragging cards between two columns,
 * in two steps that look and work the same:
 *
 *   1. BY ORDER TYPE — ECOM, PREBOOK, WHOLESALE, … (from the uploaded order data,
 *      looked up by the line's Client Ref 1 — the workbook's "NRI Order data"
 *      VLOOKUP). Only a charge on a known order has a type.
 *   2. BY SERVICE — every other charge (storage, labour, returns on an RMA …).
 *
 * Step 1 comes first because services like Order Processing, Order NonMasterPack
 * and Outbound Freight are split between the channels BY THE ORDER. On the 2026 CA
 * data no trade-type order carries an Ecomm-column service, and the team left all
 * 7,672 trade-order lines as Wholesale — so step 1 deciding Wholesale too is
 * exactly the hand coding.
 *
 * This page is for GENERAL rules, so a card is just its name. Unusual cases
 * (overtime, transfer orders, special services) are EXCEPTIONS, in their own
 * table, checked between the two steps.
 *
 * Unchanged: rules code only files NOT marked Booked, and a line someone coded by
 * hand keeps its coding. Stored as rules (nri_class_rules, with a `kind`); the
 * server fixes the evaluation order by kind.
 */

import { Fragment, useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ChevronDown, GripVertical, Info, Loader2, Pencil, Plus, Search, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import ConfirmDialog from '@/modules/mainline/components/ConfirmDialog';
import { saveClassRules, clearRuleMonth } from '../actions';
import { EntitySwitch, count } from './shared';
import type { ClassRule, Entity, RuleCondition, RuleField, RuleKind, RuleOp, RulesPayload } from '../types';

type Side = 'whsle' | 'online';
type Sides = Record<string, Side>;

const monthName = (ym: string | null) =>
  ym ? new Date(`${ym}-01T00:00:00`).toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) : '—';

export default function RulesView({ entity, data }: { entity: Entity; data: RulesPayload | null }) {
  const router = useRouter();
  const go = (e: Entity, month?: string) => router.push(`/invoices/rules?entity=${e}${month ? `&month=${month}` : ''}`);
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <EntitySwitch value={entity} onChange={(e) => go(e)} />
        {data && (
          <Select value={data.monthInfo.month} onValueChange={(v) => v && go(entity, String(v))}>
            {/* label rendered directly: SelectValue cannot derive it for a programmatic value */}
            <SelectTrigger className="w-72">Rules for {monthName(data.monthInfo.month)}</SelectTrigger>
            <SelectContent>
              {[...data.monthInfo.months].reverse().map((m) => (
                <SelectItem key={m.month} value={m.month}>
                  {monthName(m.month)}{' · '}
                  {m.files ? `${m.files} file${m.files === 1 ? '' : 's'}${m.booked === m.files ? ', Booked' : ''}` : 'no files yet'}
                  {m.saved ? ' · rules set' : ''}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>
      {data
        ? <Editor key={`${entity}-${data.monthInfo.month}`} entity={entity} data={data} />
        : <p className="text-sm text-muted-foreground">Could not load the rules.</p>}
    </div>
  );
}

// ─── state <-> stored rules ──────────────────────────────────────────────────

const key = (s: string) => s.trim().toLowerCase();

function channels(data: RulesPayload, entity: Entity) {
  const whsle = data.classes.find((c) => /whsle/i.test(c)) ?? `${entity} - Whsle`;
  const online = data.classes.find((c) => /online/i.test(c)) ?? `${entity} - Online`;
  return { whsle, online };
}

type State = {
  types: Sides;          // step 1 — order type → column
  services: Sides;       // step 2 — service → column
  custom: ClassRule[];   // exceptions
};

/** Display names for the cards, keyed case-insensitively. */
function names(data: RulesPayload) {
  const types = new Map<string, string>();
  for (const t of data.suggestions.orderType) types.set(key(t), t);
  for (const r of data.rules.filter((x) => x.kind === 'orderType')) {
    for (const v of r.conditions[0]?.values ?? []) if (!types.has(key(v))) types.set(key(v), v);
  }
  const services = new Map(data.services.map((s) => [key(s.service), s.service]));
  return { types, services };
}

function placed(rules: ClassRule[], kind: ClassRule['kind'], online: string) {
  const m = new Map<string, Side>();
  for (const r of rules.filter((x) => x.kind === kind)) {
    const side: Side = r.setClass === online ? 'online' : 'whsle';
    for (const v of r.conditions[0]?.values ?? []) if (!m.has(key(v))) m.set(key(v), side);
  }
  return m;
}

function fromRules(data: RulesPayload, entity: Entity): State {
  const ch = channels(data, entity);
  const n = names(data);
  const t = placed(data.rules, 'orderType', ch.online);
  const s = placed(data.rules, 'serviceColumn', ch.online);
  const types: Sides = {};
  // an order type nobody has placed (a new one in the order data) starts in Wholesale
  for (const k of n.types.keys()) types[k] = t.get(k) ?? 'whsle';
  const services: Sides = {};
  // a service nobody has placed takes the coding legend's default channel
  for (const svc of data.services) {
    services[key(svc.service)] = s.get(key(svc.service)) ?? (svc.defaultClass && /online/i.test(svc.defaultClass) ? 'online' : 'whsle');
  }
  return { types, services, custom: data.rules.filter((r) => r.kind === 'custom') };
}

function toRules(state: State, data: RulesPayload, entity: Entity): ClassRule[] {
  const ch = channels(data, entity);
  const n = names(data);
  const pair = (kind: 'orderType' | 'serviceColumn', sides: Sides, display: Map<string, string>, noun: string): ClassRule[] =>
    (['whsle', 'online'] as Side[]).map((side) => ({
      kind,
      name: `${side === 'online' ? 'Ecomm' : 'Wholesale'} ${noun}`,
      enabled: true,
      setClass: side === 'online' ? ch.online : ch.whsle,
      conditions: [{
        field: kind === 'orderType' ? 'orderType' : 'service',
        op: 'is',
        values: Object.entries(sides).filter(([, v]) => v === side).map(([k]) => display.get(k) ?? k).sort(),
      }],
    }));
  return [
    ...pair('orderType', state.types, n.types, 'order types'),
    ...state.custom,
    ...pair('serviceColumn', state.services, n.services, 'services'),
  ];
}

// empty columns are not stored, so compare without them
const comparable = (rules: ClassRule[]) => JSON.stringify(rules
  .filter((r) => r.kind === 'custom' || r.conditions[0]?.values.length)
  .map((r) => ({
    kind: r.kind, name: r.kind === 'custom' ? r.name : '', enabled: r.enabled, setClass: r.setClass,
    conditions: r.conditions.map((c) => ({ ...c, values: [...c.values].sort() })),
  })));

// ─── the editor ──────────────────────────────────────────────────────────────

const SECTION_LABEL: Record<RuleKind, string> = { orderType: 'Step 1', custom: 'Exceptions', serviceColumn: 'Step 2' };

/** "set for this month" / "using August 2026's" / "the starting rules" — per section. */
function SourceNote({ s }: { s: RulesPayload['monthInfo']['sections'][RuleKind] }) {
  return (
    <span className="text-xs text-muted-foreground">
      {s.source === 'own' && <>Set for this month</>}
      {s.source === 'inherited' && <>Using {monthName(s.inheritedFrom)}’s</>}
      {s.source === 'base' && <>Using the starting rules</>}
    </span>
  );
}

function Editor({ entity, data }: { entity: Entity; data: RulesPayload }) {
  const router = useRouter();
  const start0 = useMemo(() => fromRules(data, entity), [data, entity]);
  const display = useMemo(() => names(data), [data]);
  const [state, setState] = useState<State>(start0);
  const [error, setError] = useState<string | null>(null);   // shown in the save bar — a toast would cover it
  const [confirmClear, setConfirmClear] = useState(false);
  const [saving, start] = useTransition();
  const month = data.monthInfo.month;
  const sections = data.monthInfo.sections;

  const current = toRules(state, data, entity);
  const before = useMemo(() => toRules(start0, data, entity), [start0, data, entity]);
  // which sections changed — only those are written for the month
  const of = (rs: ClassRule[], k: RuleKind) => comparable(rs.filter((r) => r.kind === k));
  const changedKinds = (['orderType', 'custom', 'serviceColumn'] as RuleKind[]).filter((k) => of(current, k) !== of(before, k));
  const dirty = changedKinds.length > 0;
  const anyOwn = Object.values(sections).some((x) => x.source === 'own');

  const save = () => {
    const problem = firstProblem(state);
    if (problem) return void setError(problem);
    setError(null);
    start(async () => {
      const res = await saveClassRules(entity, current, { month, saveKinds: changedKinds });
      if ('error' in res) return void setError(res.error);
      toast.success(`${changedKinds.map((k) => SECTION_LABEL[k]).join(', ')} saved for ${monthName(month)} — later months use it until another month is set.`);
      router.refresh();
    });
  };
  const clearMonth = () => start(async () => {
    const res = await clearRuleMonth(entity, month);
    setConfirmClear(false);
    if ('error' in res) return void setError(res.error);
    toast.success(`${monthName(month)} now uses the rules of an earlier month.`);
    router.refresh();
  });

  const allBooked = data.files.total > 0 && data.files.booked === data.files.total;

  return (
    <div className="space-y-5">
      <p className="flex items-start gap-2 text-sm text-muted-foreground">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
        <span>
          The rules for <b className="text-foreground">{monthName(month)}</b> invoices (by period-end month). Saving a section carries it
          forward to later months until another month is set. Rules decide the channel on files <b className="text-foreground">not marked
          Booked</b>; a line someone coded by hand keeps its coding.
          {' '}{count(data.files.booked)} of {count(data.files.total)} NRI {entity} files are Booked
          {allBooked && ' — so a change here shows up on the next file you upload'}.
        </span>
        {anyOwn && (
          <Button size="sm" variant="ghost" className="ml-auto shrink-0" disabled={saving} onClick={() => setConfirmClear(true)}>
            Clear {monthName(month)}’s rules
          </Button>
        )}
      </p>

      <ChannelColumns
        step={1}
        title="By order type"
        hint="Charges on an order in the order data go by the order’s type. Charges with no order (storage, labour, returns…) go to step 2."
        noun="order type"
        items={display.types}
        sides={state.types}
        baseline={start0.types}
        defaultOpen
        note={<SourceNote s={sections.orderType} />}
        empty="No order types yet — add order data on the Uploads tab."
        onMove={(k, side) => setState((s) => ({ ...s, types: { ...s.types, [k]: side } }))}
      />

      <ChannelColumns
        step={2}
        title="Everything else, by service"
        hint="Drag each NRI service to the channel its charges belong to."
        noun="service"
        items={display.services}
        sides={state.services}
        baseline={start0.services}
        searchable
        note={<SourceNote s={sections.serviceColumn} />}
        onMove={(k, side) => setState((s) => ({ ...s, services: { ...s.services, [k]: side } }))}
      />

      <Exceptions
        rules={state.custom}
        data={data}
        note={<SourceNote s={sections.custom} />}
        onChange={(custom) => setState((s) => ({ ...s, custom }))}
      />

      <div className="sticky bottom-0 z-10 flex flex-wrap items-center gap-2 border-t border-border bg-background/95 py-3 backdrop-blur">
        <div className="ml-auto flex items-center gap-2">
          {error
            ? <span role="alert" className="text-sm text-red-700 dark:text-red-300">{error}</span>
            : dirty && <span className="text-sm text-amber-700 dark:text-amber-300">Unsaved: {changedKinds.map((k) => SECTION_LABEL[k]).join(', ')}</span>}
          <Button variant="ghost" disabled={!dirty || saving} onClick={() => { setState(start0); setError(null); }}>Discard</Button>
          <Button disabled={!dirty || saving} onClick={save}>
            {saving && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />} Save for {monthName(month)}
          </Button>
        </div>
      </div>

      <ConfirmDialog
        open={confirmClear}
        title={`Clear ${monthName(month)}’s rules?`}
        description={<>Everything set for {monthName(month)} is removed; each section goes back to the latest earlier month that has its own, or the starting rules. Later months that used {monthName(month)}’s move with it.</>}
        confirmLabel="Clear"
        destructive
        busy={saving}
        onConfirm={clearMonth}
        onCancel={() => setConfirmClear(false)}
      />
    </div>
  );
}

function firstProblem(s: State): string | null {
  for (const [i, r] of s.custom.entries()) {
    const n = `Exception ${i + 1}`;
    if (!r.name.trim()) return `${n} needs a name.`;
    if (!r.setClass) return `${n} needs the channel it sets.`;
    const empty = r.conditions.findIndex((c) => !c.values.length);
    if (empty >= 0) return `${n}: condition ${empty + 1} has no values.`;
  }
  return null;
}

function Step({ n }: { n: number }) {
  return <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/15 text-sm font-semibold text-primary">{n}</span>;
}

// ─── the two columns (both steps) ────────────────────────────────────────────

function ChannelColumns({ step, title, hint, noun, items, sides, baseline, onMove, searchable, defaultOpen = false, empty, note }: {
  step: number; title: string; hint: string; noun: string;
  items: Map<string, string>;            // key → display name
  sides: Sides; baseline: Sides;
  onMove: (key: string, side: Side) => void;
  searchable?: boolean; defaultOpen?: boolean; empty?: string;
  /** where this section's settings for the month come from */
  note?: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [q, setQ] = useState('');
  const [over, setOver] = useState<Side | null>(null);
  const id = `channel-columns-${step}`;

  const all = [...items.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const shown = all.filter(([, label]) => !q.trim() || label.toLowerCase().includes(q.trim().toLowerCase()));
  const sideOf = (k: string) => sides[k] ?? 'whsle';
  const total = (side: Side) => all.filter(([k]) => sideOf(k) === side).length;
  const moved = all.filter(([k]) => (baseline[k] ?? 'whsle') !== sideOf(k)).length;
  const plural = (n: number) => `${count(n)} ${noun}${n === 1 ? '' : 's'}`;
  const a = /^[aeiou]/i.test(noun) ? 'an' : 'a';

  const column = (side: Side, label: string) => {
    const list = shown.filter(([k]) => sideOf(k) === side);
    return (
      <div
        onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (over !== side) setOver(side); }}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(null); }}
        onDrop={(e) => {
          e.preventDefault();
          const k = e.dataTransfer.getData('application/x-nri-card');
          // a card from the OTHER step carries a different type tag — ignore it
          if (k && e.dataTransfer.getData('application/x-nri-step') === String(step)) onMove(k, side);
          setOver(null);
        }}
        className={cn(
          'flex min-h-[6rem] flex-col rounded-lg border-2 border-dashed border-transparent bg-muted/20 p-2 transition-colors',
          over === side && 'border-primary bg-primary/5',
        )}
        aria-label={`Step ${step} ${label} column — drop ${a} ${noun} here`}
      >
        <div className="flex items-baseline justify-between px-1 pb-2">
          <h3 className="text-sm font-semibold">{label}</h3>
          <span className="text-xs text-muted-foreground tabular-nums">{plural(list.length)}</span>
        </div>
        <ul className="space-y-1">
          {list.map(([k, name]) => (
            <Card key={k} k={k} name={name} step={step} side={side} changed={(baseline[k] ?? 'whsle') !== side} onMove={onMove} />
          ))}
          {!list.length && <li className="px-2 py-4 text-center text-xs text-muted-foreground">Drag {a} {noun} here</li>}
        </ul>
      </div>
    );
  };

  return (
    <section className="rounded-lg border border-border bg-card">
      <div className={cn('flex flex-wrap items-center gap-3 px-4 py-3', open && 'border-b border-border')}>
        <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} aria-controls={id}
          className="flex min-w-0 flex-1 items-center gap-3 text-left">
          <Step n={step} />
          <div className="min-w-0 flex-1">
            <h2 className="flex items-center gap-1.5 text-sm font-semibold">
              {title}
              <ChevronDown className={cn('h-4 w-4 text-muted-foreground transition-transform', !open && '-rotate-90')} aria-hidden />
            </h2>
            <p className="text-xs text-muted-foreground">
              {open
                ? hint
                : <>{count(total('whsle'))} Wholesale · {count(total('online'))} Ecomm{moved > 0 && <span className="text-primary"> · {count(moved)} moved, not saved</span>} — click to edit</>}
            </p>
          </div>
        </button>
        {note}
        {open && searchable && (
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Find a ${noun}`} className="h-8 w-48 pl-7" />
          </div>
        )}
      </div>
      {open && (
        all.length === 0 && empty
          ? <p id={id} className="px-4 py-6 text-center text-sm text-muted-foreground">{empty}</p>
          : (
            <div id={id} className="grid gap-3 p-3 md:grid-cols-2">
              {column('whsle', 'Wholesale')}
              {column('online', 'Ecomm')}
            </div>
          )
      )}
    </section>
  );
}

function Card({ k, name, step, side, changed, onMove }: {
  k: string; name: string; step: number; side: Side; changed: boolean; onMove: (key: string, side: Side) => void;
}) {
  const other: Side = side === 'whsle' ? 'online' : 'whsle';
  return (
    <li
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('application/x-nri-card', k);
        e.dataTransfer.setData('application/x-nri-step', String(step));
        e.dataTransfer.effectAllowed = 'move';
      }}
      className={cn(
        'group flex cursor-grab items-center gap-2 rounded-md border border-border bg-card px-2 py-1 active:cursor-grabbing',
        changed && 'border-primary/60 ring-1 ring-primary/30',
      )}
    >
      <GripVertical className="h-4 w-4 shrink-0 text-muted-foreground/60" aria-hidden />
      <span className="min-w-0 flex-1 truncate text-sm">{name}</span>
      {changed && <span className="text-[10px] font-semibold uppercase text-primary">moved</span>}
      {/* the same move without a mouse — keyboard, touch, screen readers */}
      <Button
        size="sm" variant="ghost" className="h-7 px-2 opacity-50 group-hover:opacity-100"
        onClick={() => onMove(k, other)}
        aria-label={`Move ${name} to ${other === 'online' ? 'Ecomm' : 'Wholesale'}`}
        title={`Move to ${other === 'online' ? 'Ecomm' : 'Wholesale'}`}
      >
        {side === 'whsle' ? <ArrowRight className="h-4 w-4" /> : <ArrowLeft className="h-4 w-4" />}
      </Button>
    </li>
  );
}

// ─── Exceptions: the unusual cases, in their own table ───────────────────────

const FIELD_LABEL: Record<RuleField, string> = {
  orderType: 'Order type', service: 'NRI service', clientRef1: 'Client Ref 1', clientRef2: 'Client Ref 2', customer: 'Customer',
};
const OP_LABEL: Record<RuleOp, string> = { is: 'is', startsWith: 'starts with', contains: 'contains' };

/** "NRI service is Warehouse Labour or Overtime, and Client Ref 1 contains gobolt" */
const describe = (r: ClassRule) => r.conditions
  .map((c) => `${FIELD_LABEL[c.field]} ${OP_LABEL[c.op]} ${c.values.length ? c.values.join(' or ') : '…'}`)
  .join(', and ');

const channelLabel = (cls: string) => (/online/i.test(cls) ? 'Ecomm' : /whsle/i.test(cls) ? 'Wholesale' : cls);

function Exceptions({ rules, data, onChange, note }: { rules: ClassRule[]; data: RulesPayload; onChange: (r: ClassRule[]) => void; note?: React.ReactNode }) {
  const [editing, setEditing] = useState<number | null>(null);
  const update = (i: number, p: Partial<ClassRule>) => onChange(rules.map((r, j) => (j === i ? { ...r, ...p } : r)));
  const swap = (i: number, d: -1 | 1) => {
    const n = [...rules];
    [n[i], n[i + d]] = [n[i + d], n[i]];
    onChange(n);
    if (editing === i) setEditing(i + d);
  };
  const remove = (i: number) => { onChange(rules.filter((_, j) => j !== i)); setEditing(null); };
  const add = () => {
    onChange([...rules, {
      kind: 'custom', name: '', enabled: true,
      setClass: data.classes.find((c) => /online/i.test(c)) ?? data.classes[0] ?? '',
      conditions: [{ field: 'clientRef1', op: 'contains', values: [] }],
    }]);
    setEditing(rules.length);
  };

  return (
    <section className="rounded-lg border border-border bg-card">
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold">Exceptions</h2>
          <p className="text-xs text-muted-foreground">
            Unusual cases a column can’t cover — overtime, transfer orders, special services. Checked after step 1 and before
            step 2, top to bottom.
          </p>
        </div>
        {note}
        <Button variant="outline" size="sm" onClick={add}><Plus className="mr-1.5 h-4 w-4" /> Add exception</Button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-card/80 text-xs text-muted-foreground">
            <tr className="border-b border-border">
              <th className="w-10 px-3 py-2 text-left font-medium">#</th>
              <th className="px-3 py-2 text-left font-medium">Exception</th>
              <th className="px-3 py-2 text-left font-medium">When</th>
              <th className="px-3 py-2 text-left font-medium">Channel</th>
              <th className="px-3 py-2 text-left font-medium">On</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {rules.map((r, i) => (
              <Fragment key={r.id ?? `new-${i}`}>
                <tr className={cn('border-b border-border hover:bg-muted/30', !r.enabled && 'opacity-60')}>
                  <td className="px-3 py-2 tabular-nums text-muted-foreground">{i + 1}</td>
                  <td className="px-3 py-2 font-medium">{r.name || <span className="text-amber-700 dark:text-amber-300">Unnamed</span>}</td>
                  <td className="px-3 py-2 text-muted-foreground">{describe(r)}</td>
                  <td className="whitespace-nowrap px-3 py-2">{channelLabel(r.setClass)}</td>
                  <td className="px-3 py-2">
                    <Switch checked={r.enabled} onCheckedChange={(v) => update(i, { enabled: !!v })} aria-label={`${r.name || 'Exception'} on`} />
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-right">
                    <Button size="sm" variant="ghost" disabled={i === 0} onClick={() => swap(i, -1)} aria-label="Move up"><ArrowUp className="h-4 w-4" /></Button>
                    <Button size="sm" variant="ghost" disabled={i === rules.length - 1} onClick={() => swap(i, 1)} aria-label="Move down"><ArrowDown className="h-4 w-4" /></Button>
                    <Button size="sm" variant="ghost" onClick={() => setEditing(editing === i ? null : i)} aria-label="Edit exception" aria-expanded={editing === i}>
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => remove(i)} aria-label="Delete exception"><Trash2 className="h-4 w-4" /></Button>
                  </td>
                </tr>
                {editing === i && (
                  <tr className="border-b border-border bg-muted/20">
                    <td colSpan={6} className="px-3 py-3">
                      <ExceptionEditor index={i} rule={r} data={data} onChange={(p) => update(i, p)} onDone={() => setEditing(null)} />
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
            {!rules.length && (
              <tr><td colSpan={6} className="px-3 py-6 text-center text-xs text-muted-foreground">No exceptions — every charge follows steps 1 and 2.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ExceptionEditor({ index, rule, data, onChange, onDone }: {
  index: number; rule: ClassRule; data: RulesPayload; onChange: (p: Partial<ClassRule>) => void; onDone: () => void;
}) {
  const setCond = (j: number, p: Partial<RuleCondition>) =>
    onChange({ conditions: rule.conditions.map((c, k) => (k === j ? { ...c, ...p } : c)) });
  return (
    <div className="space-y-2">
      <Input value={rule.name} onChange={(e) => onChange({ name: e.target.value })} placeholder="Name — e.g. GoBolt transfers"
        className="h-8 max-w-md font-medium" aria-label="Exception name" />
      {rule.conditions.map((c, j) => (
        <div key={j} className="flex flex-wrap items-start gap-2">
          <span className="w-10 pt-1.5 text-right text-xs font-semibold uppercase text-muted-foreground">{j === 0 ? 'When' : 'and'}</span>
          <Select value={c.field} onValueChange={(v) => setCond(j, { field: v as RuleField })}>
            <SelectTrigger className="h-8 w-36">{FIELD_LABEL[c.field]}</SelectTrigger>
            <SelectContent>{data.fields.map((f) => <SelectItem key={f} value={f}>{FIELD_LABEL[f]}</SelectItem>)}</SelectContent>
          </Select>
          <Select value={c.op} onValueChange={(v) => setCond(j, { op: v as RuleOp })}>
            <SelectTrigger className="h-8 w-32">{OP_LABEL[c.op]}</SelectTrigger>
            <SelectContent>{data.ops.map((o) => <SelectItem key={o} value={o}>{OP_LABEL[o]}</SelectItem>)}</SelectContent>
          </Select>
          <ValuesInput values={c.values} onChange={(values) => setCond(j, { values })}
            suggestions={c.field === 'orderType' ? data.suggestions.orderType : c.field === 'service' ? data.suggestions.service : []}
            id={`sug-exc-${index}-${j}`} />
          {rule.conditions.length > 1 && (
            <Button size="sm" variant="ghost" onClick={() => onChange({ conditions: rule.conditions.filter((_, k) => k !== j) })} aria-label="Remove condition">
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-2 pl-12">
        <Button size="sm" variant="ghost" onClick={() => onChange({ conditions: [...rule.conditions, { field: 'service', op: 'is', values: [] }] })}>
          <Plus className="mr-1 h-3.5 w-3.5" /> Condition
        </Button>
        <span className="text-sm">then channel =</span>
        <Select value={rule.setClass} onValueChange={(v) => onChange({ setClass: String(v ?? '') })}>
          <SelectTrigger className="h-8 w-40 font-medium">{rule.setClass ? channelLabel(rule.setClass) : 'Choose'}</SelectTrigger>
          <SelectContent>{data.classes.map((c) => <SelectItem key={c} value={c}>{channelLabel(c)}</SelectItem>)}</SelectContent>
        </Select>
        <Button size="sm" variant="outline" className="ml-auto" onClick={onDone}>Done</Button>
      </div>
    </div>
  );
}

/** Values as chips; type and press Enter (or comma) to add. Any one value matches. */
function ValuesInput({ values, onChange, suggestions, id, compact }: {
  values: string[]; onChange: (v: string[]) => void; suggestions: string[]; id: string; compact?: boolean;
}) {
  const [draft, setDraft] = useState('');
  const commit = (raw: string) => {
    const next = [...values];
    for (const p of raw.split(',').map((x) => x.trim()).filter(Boolean)) {
      if (!next.some((v) => v.toLowerCase() === p.toLowerCase())) next.push(p);
    }
    onChange(next);
    setDraft('');
  };
  return (
    <div className={cn(
      'flex min-h-8 flex-wrap items-center gap-1 rounded-md border border-input bg-background px-1.5 py-1',
      compact ? 'min-w-[10rem]' : 'min-w-[16rem] flex-1',
      !values.length && 'border-amber-500/60',
    )}>
      {values.map((v) => (
        <span key={v} className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-xs font-medium">
          {v}
          <button type="button" onClick={() => onChange(values.filter((x) => x !== v))} aria-label={`Remove ${v}`} className="text-muted-foreground hover:text-foreground">
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
      <input
        list={suggestions.length ? id : undefined}
        value={draft}
        onChange={(e) => { const v = e.target.value; if (suggestions.includes(v)) commit(v); else setDraft(v); }}
        onKeyDown={(e) => {
          if ((e.key === 'Enter' || e.key === ',') && draft.trim()) { e.preventDefault(); commit(draft); }
          if (e.key === 'Backspace' && !draft && values.length) onChange(values.slice(0, -1));
        }}
        onBlur={() => { if (draft.trim()) commit(draft); }}
        placeholder={values.length ? '+' : 'value — Enter to add'}
        className="h-6 w-16 min-w-[4rem] flex-1 bg-transparent px-1 text-sm outline-none"
        aria-label="Add a value"
      />
      {suggestions.length > 0 && (
        <datalist id={id}>{suggestions.filter((s) => !values.includes(s)).map((s) => <option key={s} value={s} />)}</datalist>
      )}
    </div>
  );
}
