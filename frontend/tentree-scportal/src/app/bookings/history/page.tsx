import { Suspense } from 'react';
import BookingsClient from '../BookingsClient';
import { getHistoryBookings } from '@/app/actions/bookings';
import { getSession } from '@/app/actions/auth';

export default async function HistoryBookingsPage() {
  let historyBookings: any[] = [];
  try {
    const [data, session] = await Promise.all([getHistoryBookings(), getSession()]);
    const isVendor = session?.role === 'Vendor';
    historyBookings = (data || []).filter(
      (b: any) => !isVendor || b.vendor_name === session.supplier
    );
  } catch (e) {
    console.error('Failed to fetch history bookings:', e);
  }

  return (
    <Suspense>
      <BookingsClient tab="history" initialHistory={historyBookings} />
    </Suspense>
  );
}
