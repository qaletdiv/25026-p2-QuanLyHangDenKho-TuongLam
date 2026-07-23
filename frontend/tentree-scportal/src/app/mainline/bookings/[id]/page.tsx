import { notFound } from 'next/navigation';
import { getMainlineBooking, getMainlineCi, getMainlinePacking, getMainlineDocuments } from '@/modules/mainline/actions';
import BookingDetail from '@/modules/mainline/components/BookingDetail';

// Mainline booking detail — booking + legs + CI (confirm) + packing summary + documents.
// (ASN is shipment-scoped — generated from the shipment detail page.)
export default async function MainlineBookingDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const booking = await getMainlineBooking(id);
  if (!booking) notFound();
  const [ci, packing, documents] = await Promise.all([
    getMainlineCi(id), getMainlinePacking(id), getMainlineDocuments(id),
  ]);
  return <BookingDetail booking={booking} ci={ci} packing={packing?.summary ?? null} packingByPo={packing?.by_po ?? []} documents={documents} />;
}
