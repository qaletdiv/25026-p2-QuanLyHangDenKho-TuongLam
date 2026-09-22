import { DetailSkeleton } from '@/modules/mainline/components/RouteFallbacks';

// SmsBookingDetail is full width (no max-width wrapper).
export default function SmsBookingDetailLoading() {
  return <DetailSkeleton width="full" />;
}
