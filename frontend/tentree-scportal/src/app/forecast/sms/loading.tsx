import { ReportSkeleton } from '@/modules/mainline/components/RouteFallbacks';

// SMS forecast: hero → 4 KPI tiles → week × facility panels.
export default function SmsForecastLoading() {
  return <ReportSkeleton heroLines={2} cards={4} panels={2} />;
}
