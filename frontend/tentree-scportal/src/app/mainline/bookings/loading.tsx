import { ListSkeleton } from '@/modules/mainline/components/RouteFallbacks';

// BookingsTable is the one list that passes a `title` to DataTable, so its
// header block is 20px taller than the others'.
export default function MainlineBookingsLoading() {
  return <ListSkeleton title />;
}
