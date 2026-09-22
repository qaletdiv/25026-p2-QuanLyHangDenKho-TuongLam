import { DetailSkeleton } from '@/modules/mainline/components/RouteFallbacks';

// BookingDetail is max-w-4xl mx-auto — match it or the content jumps sideways.
export default function MainlineBookingDetailLoading() {
  return <DetailSkeleton width="4xl" />;
}
