import { NotFoundCard } from '@/modules/mainline/components/RouteFallbacks';

export default function SmsBookingNotFound() {
  return <NotFoundCard noun="SMS booking" backHref="/sms/bookings" backLabel="Back to SMS Bookings" />;
}
