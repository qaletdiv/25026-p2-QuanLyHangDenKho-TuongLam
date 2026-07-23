import { NotFoundCard } from '@/modules/mainline/components/RouteFallbacks';

export default function MainlineBookingDetailNotFound() {
  return <NotFoundCard noun="Booking" backHref="/mainline/bookings" backLabel="Back to Bookings" />;
}
