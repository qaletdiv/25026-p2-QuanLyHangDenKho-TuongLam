import { notFound } from 'next/navigation';
import { getSmsBooking, getSmsIncoterms, getSmsCouriers, getSmsModes } from '@/modules/sms/actions';
import SmsBookingDetail from '@/modules/sms/components/SmsBookingDetail';

export default async function SmsBookingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // incoterms/couriers/modes feed the edit form — a PENDING booking is editable
  // (PATCH /sms/bookings/:id), and carrier + mode must be set before it can be approved.
  const [booking, incoterms, couriers, modes] = await Promise.all([
    getSmsBooking(id), getSmsIncoterms(), getSmsCouriers(), getSmsModes(),
  ]);
  if (!booking) notFound();
  return <SmsBookingDetail booking={booking} incoterms={incoterms} couriers={couriers} modes={modes} />;
}
