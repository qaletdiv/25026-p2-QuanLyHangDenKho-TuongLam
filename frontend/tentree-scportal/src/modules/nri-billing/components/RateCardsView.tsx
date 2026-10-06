'use client';

/**
 * The two contracts every NRI line is checked against. Each card is the
 * warehouse's rate-card workbook (sheets Contract Info · Rate Card · Validation
 * Rules); uploading a new one REPLACES that warehouse's card and re-validates
 * every line on the next read — no code change, which is the point.
 *
 * The "Checks" column answers the question a reviewer actually has: which NRI
 * invoice services does this rate validate? NRI's service names are not the
 * card's charge names ("Order NonMasterPack" is "Outbound Handling – B2C").
 */

import { useMemo, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Upload, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import DataTable, { type DataColumn } from '@/modules/mainline/components/DataTable';
import { uploadRateCard } from '../actions';
import { EntitySwitch, money, DASH, CURRENCY } from './shared';
import type { ContractRate, ContractTerm, Entity, RateCard } from '../types';

type Row = ContractRate & { checks: string };

export default function RateCardsView({ cards }: { cards: Record<Entity, RateCard> | null }) {
  const router = useRouter();
  const [entity, setEntity] = useState<Entity>('CA');
  const [pending, start] = useTransition();
  const fileRef = useRef<HTMLInputElement>(null);
  const card = cards?.[entity];

  const rows: Row[] = useMemo(() => {
    if (!card) return [];
    const checks = new Map<string, string[]>();
    for (const m of card.serviceMap) for (const c of m.codes) checks.set(c, [...(checks.get(c) ?? []), m.service]);
    return card.rates.map((r) => ({ ...r, checks: (checks.get(r.id) ?? []).join(', ') }));
  }, [card]);

  const columns: DataColumn<Row>[] = useMemo(() => [
    { key: 'id', label: 'Code', render: (r) => <span className="font-mono text-xs">{r.id}</span> },
    { key: 'section', label: 'Section' },
    { key: 'service', label: 'Service / Charge' },
    { key: 'productGroup', label: 'Product group', defaultVisible: false },
    { key: 'uom', label: 'UOM' },
    {
      key: 'rate', label: 'Rate', align: 'right',
      accessor: (r) => r.rate ?? -1,
      render: (r) => (r.rate !== null
        ? <span className="tabular-nums">{money(r.rate, r.rate < 1 ? 3 : 2)}</span>
        : <span className="text-muted-foreground">{r.rateText ?? DASH}</span>),
    },
    { key: 'rateType', label: 'Type' },
    { key: 'checks', label: 'Checks NRI services', render: (r) => (r.checks ? <span className="text-xs">{r.checks}</span> : <span className="text-muted-foreground">{DASH}</span>) },
    { key: 'conditions', label: 'Conditions', defaultVisible: false },
    { key: 'source', label: 'Source', defaultVisible: false },
  ], []);

  const upload = (file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('entity', entity);
    start(async () => {
      const res = await uploadRateCard(fd);
      if (fileRef.current) fileRef.current.value = '';
      if ('error' in res) return void toast.error(res.error);
      toast.success(`NRI ${res.entity} rate card loaded — ${res.rates} rates (${res.priced} priced), ${res.rules} validation rules.`);
      if (res.entity !== entity) setEntity(res.entity);
      router.refresh();
    });
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <EntitySwitch value={entity} onChange={setEntity} />
        <div className="flex items-center gap-2">
          <input
            ref={fileRef} type="file" accept=".xlsx" className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); }}
          />
          <Button size="sm" variant="outline" disabled={pending} onClick={() => fileRef.current?.click()}>
            {pending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Upload className="mr-1.5 h-3.5 w-3.5" />}
            Replace NRI {entity} rate card
          </Button>
        </div>
      </div>

      {!card || !card.rates.length ? (
        <div className="rounded-lg border border-dashed border-border bg-card px-6 py-10 text-center text-sm text-muted-foreground">
          No rate card loaded for NRI {entity}. Upload the rate-card workbook (sheets “Contract Info”, “Rate Card”, “Validation Rules”).
          Until then every NRI {entity} line reads “No rate on card”.
        </div>
      ) : (
        <>
          <ContractInfo info={card.info} entity={entity} />
          <DataTable
            title={`Rate card · ${CURRENCY[entity]}`}
            noun="rate"
            rows={rows}
            columns={columns}
            rowKey={(r) => r.id}
            pageSize={25}
            storageKey="nri-billing-rate-card-cols"
            searchPlaceholder="Search code, service, NRI service…"
          />
          <Rules rules={card.rules} />
        </>
      )}
    </div>
  );
}

function ContractInfo({ info, entity }: { info: ContractTerm[]; entity: Entity }) {
  if (!info.length) return null;
  return (
    <section className="rounded-lg border border-border bg-card">
      <h2 className="border-b border-border px-4 py-2.5 text-sm font-semibold">Contract · NRI {entity}</h2>
      <dl className="grid gap-x-6 gap-y-3 px-4 py-3 sm:grid-cols-2 lg:grid-cols-3">
        {info.map((t) => (
          <div key={t.id} className="min-w-0">
            <dt className="text-xs text-muted-foreground">{t.label}</dt>
            <dd className="text-sm font-medium">{t.value ?? DASH}</dd>
            {t.detail && <dd className="text-xs text-muted-foreground">{t.detail}</dd>}
          </div>
        ))}
      </dl>
    </section>
  );
}

function Rules({ rules }: { rules: ContractTerm[] }) {
  if (!rules.length) return null;
  return (
    <section className="rounded-lg border border-border bg-card">
      <h2 className="border-b border-border px-4 py-2.5 text-sm font-semibold">Validation rules</h2>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-card/80 text-xs text-muted-foreground">
            <tr className="border-b border-border">
              <th className="px-4 py-2 text-left font-medium">Rule</th>
              <th className="px-4 py-2 text-left font-medium">Topic</th>
              <th className="px-4 py-2 text-left font-medium">Rule / threshold</th>
              <th className="px-4 py-2 text-left font-medium">Value</th>
              <th className="px-4 py-2 text-left font-medium">How to use it</th>
            </tr>
          </thead>
          <tbody>
            {rules.map((r) => (
              <tr key={r.id} className="border-b border-border align-top last:border-0 hover:bg-muted/30">
                <td className="px-4 py-2 font-mono text-xs">{r.code}</td>
                <td className="px-4 py-2 font-medium">{r.label}</td>
                <td className="px-4 py-2">{r.detail}</td>
                <td className="whitespace-nowrap px-4 py-2">{r.value}</td>
                <td className="px-4 py-2 text-muted-foreground">{r.validationUse}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
