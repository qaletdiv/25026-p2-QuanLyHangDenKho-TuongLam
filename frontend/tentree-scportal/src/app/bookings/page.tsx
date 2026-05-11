import { Suspense } from 'react';
import BookingsClient from './BookingsClient';
import { getBookings, getHistoryBookings } from '@/app/actions/bookings';
import { getPurchaseOrders } from '@/app/actions/purchase-orders';
import { getSession } from '@/app/actions/auth';

export default async function BookingsPage() {
  let activeBookings = [];
  let historyBookings = [];
  let pendingPOs = [];

  try {
    const [activeBookingsData, historyBookingsData, allPOsData, session] = await Promise.all([
      getBookings(),
      getHistoryBookings(),
      getPurchaseOrders(),
      getSession(),
    ]);

    const isVendor = session?.role === 'Vendor';

    activeBookings = (activeBookingsData || []).filter((b: any) =>
      !isVendor || b.vendor_name === session.supplier
    );
    historyBookings = (historyBookingsData || []).filter((b: any) =>
      !isVendor || b.vendor_name === session.supplier
    );

    const allPOs = allPOsData || [];
    pendingPOs = allPOs.filter((p: any) => {
      const remaining = (parseInt(p.expected_qty) || 0) - (parseInt(p.booked_qty) || 0);
      const isVendorMatch = !isVendor || p.supplier === session.supplier;
      return remaining > 0 && isVendorMatch;
    });

  } catch (e) {
    console.error('Failed to fetch initial bookings data:', e);
  }

  return (
    <Suspense>
      <BookingsClient
        initialActive={activeBookings || []}
        initialHistory={historyBookings || []}
        initialPending={pendingPOs || []}
      />
    </Suspense>
  );
}
