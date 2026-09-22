import { ListSkeleton } from '@/modules/mainline/components/RouteFallbacks';

// The Landed Costs layout renders the heading + SMS|Mainline strip itself and
// stays mounted across this boundary, so the skeleton must NOT draw a tab strip.
// rows=20 = the tables' pageSize.
export default function LandedCostsLoading() {
  return <ListSkeleton tabs={false} rows={20} />;
}
