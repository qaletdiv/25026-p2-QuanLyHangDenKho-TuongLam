import { Suspense } from 'react';
import BookingsClient from '../BookingsClient';
import { getPurchaseOrders } from '@/app/actions/purchase-orders';
import { getSession } from '@/app/actions/auth';

export default async function PendingBookingsPage() {
  let pendingPOs: any[] = [];
  try {
    const [allPOsData, session] = await Promise.all([getPurchaseOrders(), getSession()]);
    const isVendor = session?.role === 'Vendor';
    const allPOs = allPOsData || [];
    pendingPOs = allPOs.filter((p: any) => {
      const remaining = (parseInt(p.expected_qty) || 0) - (parseInt(p.booked_qty) || 0);
      const isVendorMatch = !isVendor || p.supplier === session.supplier;
      return remaining > 0 && isVendorMatch;
    });
  } catch (e) {
    console.error('Failed to fetch pending POs:', e);
  }

  return (
    <Suspense>
      <BookingsClient tab="pending" initialPending={pendingPOs} />
    </Suspense>
  );
}
