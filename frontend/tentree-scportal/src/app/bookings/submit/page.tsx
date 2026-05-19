import { Suspense } from 'react';
import BookingsClient from '../BookingsClient';
import { getPurchaseOrders } from '@/app/actions/purchase-orders';

export default async function SubmitBookingPage({
  searchParams,
}: {
  // Next.js 15+ passes searchParams as a Promise
  searchParams: Promise<{ po?: string }>;
}) {
  const resolvedParams = await searchParams;
  let prefilledPO: any = null;
  if (resolvedParams.po) {
    try {
      const allPOs = await getPurchaseOrders();
      prefilledPO = (allPOs || []).find((p: any) => p.po_number === resolvedParams.po) ?? null;
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
