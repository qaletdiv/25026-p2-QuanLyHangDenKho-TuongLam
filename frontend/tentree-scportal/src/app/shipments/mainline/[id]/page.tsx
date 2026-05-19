import { notFound } from 'next/navigation';
import { getShipment } from '@/app/actions/shipments';
import { getSession } from '@/app/actions/auth';
import ShipmentDetail from '@/components/shipments/ShipmentDetail';

export default async function MainlineShipmentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [shipment, session] = await Promise.all([getShipment(id), getSession()]);

  if (!shipment || shipment.error) notFound();

  return <ShipmentDetail shipment={shipment} user={session} />;
}
