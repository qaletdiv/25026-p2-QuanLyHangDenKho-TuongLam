import { Suspense } from 'react';
import BookingsClient from '../BookingsClient';
import { getPurchaseOrders } from '@/app/actions/purchase-orders';

export default async function SubmitBookingPage({
  searchParams,
}: {
  searchParams: { po?: string };
}) {
  let prefilledPO: any = null;
  if (searchParams.po) {
    try {
      const allPOs = await getPurchaseOrders();
      prefilledPO = (allPOs || []).find((p: any) => p.po_number === searchParams.po) ?? null;
    } catch (e) {
      console.error('Failed to fetch PO for prefill:', e);
    }
  }

  return (
    <Suspense>
      <BookingsClient tab="submit" prefilledPO={prefilledPO} />
    </Suspense>
  );
}
