import { notFound } from 'next/navigation';
import { getSmsShipment, getSmsShipmentDocuments } from '@/modules/sms/actions';
import SmsShipmentDetail from '@/modules/sms/components/SmsShipmentDetail';

// SMS shipment detail — contents (PO lots), shipping data (packing + generated
// CI/packing-list docs), courier tracking timeline, manual-status fallback, delete.
export default async function SmsShipmentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const shipment = await getSmsShipment(id);
  if (!shipment) notFound();
  const documents = await getSmsShipmentDocuments(id);
  return <SmsShipmentDetail shipment={shipment} documents={documents} />;
}
