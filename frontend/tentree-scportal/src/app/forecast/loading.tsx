import { ReportSkeleton } from '@/modules/mainline/components/RouteFallbacks';

// Mainline forecast: hero → 4 KPI tiles → week × facility panels. (The SMS tab
// has its own loading.tsx; without this one, /forecast fell back to the nearest
// boundary and rendered nothing while the leg-grained projection was computed.)
export default function ForecastLoading() {
  return <ReportSkeleton heroLines={1} cards={4} panels={2} />;
}
