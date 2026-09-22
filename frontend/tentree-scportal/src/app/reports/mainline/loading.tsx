import { ReportSkeleton } from '@/modules/mainline/components/RouteFallbacks';

// The KPI report is a hero header + two donut panels, not a DataTable list and
// with no stat-tile row: the hero carries the production-schedule cutoffs
// (4 lines), then the panels start straight after.
export default function MainlineReportsLoading() {
  return <ReportSkeleton heroLines={4} cards={0} panels={2} />;
}
