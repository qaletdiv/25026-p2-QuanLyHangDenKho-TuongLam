import { ReportSkeleton } from '@/modules/mainline/components/RouteFallbacks';

// SMS report: hero → 5-up stat tiles → donut/pivot panels.
export default function SmsReportsLoading() {
  return <ReportSkeleton heroLines={2} cards={5} cardCols={5} panels={2} />;
}
