import { getClassRules } from '@/modules/nri-billing/actions';
import RulesView from '@/modules/nri-billing/components/RulesView';
import type { Entity } from '@/modules/nri-billing/types';

// ?entity=CA&month=YYYY-MM — the month applies to the service columns (step 2)
export default async function RulesPage({
  searchParams,
}: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const entity: Entity = one(sp.entity) === 'US' ? 'US' : 'CA';
  const data = await getClassRules(entity, one(sp.month) || undefined);
  return <RulesView entity={entity} data={data} />;
}
