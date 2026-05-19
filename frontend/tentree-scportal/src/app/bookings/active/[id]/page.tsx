import { notFound } from 'next/navigation';
import { getBooking } from '@/app/actions/bookings';
import { getSession } from '@/app/actions/auth';
import BookingDetail from '@/components/bookings/BookingDetail';

export default async function ActiveBookingDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [booking, session] = await Promise.all([getBooking(id), getSession()]);

  if (!booking || booking.error) notFound();

  return <BookingDetail booking={booking} user={session} isHistory={false} />;
}
