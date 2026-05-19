import { notFound } from 'next/navigation';
import { getShipment } from '@/app/actions/shipments';
import { getSession } from '@/app/actions/auth';
import SmsShipmentDetail from '@/components/shipments/SmsShipmentDetail';

export default async function SmsShipmentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [shipment, session] = await Promise.all([getShipment(id), getSession()]);

  if (!shipment || shipment.error) notFound();

  return <SmsShipmentDetail shipment={shipment} user={session} />;
}
