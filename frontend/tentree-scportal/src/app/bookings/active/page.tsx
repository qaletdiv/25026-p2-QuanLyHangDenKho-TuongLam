import { Suspense } from 'react';
import BookingsClient from '../BookingsClient';
import { getBookings } from '@/app/actions/bookings';
import { getSession } from '@/app/actions/auth';

export default async function ActiveBookingsPage({
  searchParams,
}: {
  searchParams: Promise<{ bkg?: string }>;
}) {
  let activeBookings: any[] = [];
  const params = await searchParams;

  try {
    const [data, session] = await Promise.all([getBookings(), getSession()]);
    const isVendor = session?.role === 'Vendor';
    activeBookings = (data || []).filter(
      (b: any) => !isVendor || b.vendor_name === session.supplier
    );
  } catch (e) {
    console.error('Failed to fetch active bookings:', e);
  }

  return (
    <Suspense>
      <BookingsClient tab="list" initialActive={activeBookings} initialBkg={params.bkg} />
    </Suspense>
  );
}
