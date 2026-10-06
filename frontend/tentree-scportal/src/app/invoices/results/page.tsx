import { getBillingFiles, getBillingResults } from '@/modules/nri-billing/actions';
import ResultsView from '@/modules/nri-billing/components/ResultsView';
import type { Entity, LineFilter, Scope } from '@/modules/nri-billing/types';

// Cost per GL by channel. The scope lives in the URL (?entity=CA&files=a,b…) so a
// view can be linked from Uploads / GL Codes and shared. Files only — no month scope.
export default async function ResultsPage({
  searchParams,
}: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const entity: Entity = one(sp.entity) === 'US' ? 'US' : 'CA';
  const scope: Scope = { entity, files: one(sp.files) || undefined };
  // there is no "all files" view: with nothing chosen, open on the latest invoice
  if (!scope.files) {
    const { files } = await getBillingFiles(entity);
    const latest = [...files].sort((a, b) => (b.periodEnd ?? '').localeCompare(a.periodEnd ?? '') || b.uploadedAt.localeCompare(a.uploadedAt))[0];
    if (latest) scope.files = latest.id;
  }
  const data = await getBillingResults(scope);
  // a drill-down can be linked to: ?service=Storage&glSource=manual (GL Codes page)
  const service = one(sp.service);
  const glSource = one(sp.glSource) === 'manual' ? 'manual' as const : undefined;
  const initialDrill: { filter: LineFilter; title: string } | null = service
    ? { filter: { service, ...(glSource ? { glSource } : {}) }, title: `Service · ${service}${glSource ? ' · GL recoded by hand' : ''}` }
    : null;
  return <ResultsView data={data} scope={scope} initialDrill={initialDrill} />;
}
