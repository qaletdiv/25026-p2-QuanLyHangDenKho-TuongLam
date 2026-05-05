import { Suspense } from 'react';
import BookingsClient from './BookingsClient';
import { getBookings, getHistoryBookings } from '@/app/actions/bookings';
import { getPurchaseOrders } from '@/app/actions/purchase-orders';

export default async function BookingsPage() {
  let activeBookings = [];
  let historyBookings = [];
  let pendingPOs = [];

  try {
    const [activeBookingsData, historyBookingsData, allPOsData] = await Promise.all([
      getBookings(),
      getHistoryBookings(),
      getPurchaseOrders()
    ]);

    activeBookings = activeBookingsData;
    historyBookings = historyBookingsData;
    
    const allPOs = allPOsData || [];
    // Filter for pending bookings only (remaining qty > 0)
    pendingPOs = allPOs.filter((p: any) => {
      const remaining = (parseInt(p.expected_qty) || 0) - (parseInt(p.booked_qty) || 0);
      return remaining > 0;
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
