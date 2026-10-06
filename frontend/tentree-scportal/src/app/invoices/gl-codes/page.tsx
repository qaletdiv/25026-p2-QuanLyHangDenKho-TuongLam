import { getGlCodes } from '@/modules/nri-billing/actions';
import GlCodesView from '@/modules/nri-billing/components/GlCodesView';
import type { Entity } from '@/modules/nri-billing/types';

// ?entity=CA&month=YYYY-MM — the month is the invoice PERIOD-END month the GLs apply to
export default async function GlCodesPage({
  searchParams,
}: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const entity: Entity = one(sp.entity) === 'US' ? 'US' : 'CA';
  const data = await getGlCodes(entity, one(sp.month) || undefined);
  return <GlCodesView entity={entity} data={data} />;
}
