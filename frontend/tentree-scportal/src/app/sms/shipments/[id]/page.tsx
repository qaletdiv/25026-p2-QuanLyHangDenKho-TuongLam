import { notFound } from 'next/navigation';
import { getSmsShipment, getSmsShipmentDocuments, getSmsCouriers, getSmsModes } from '@/modules/sms/actions';
import SmsShipmentDetail from '@/modules/sms/components/SmsShipmentDetail';

// SMS shipment detail — contents (PO lots), shipping data (packing + generated
// CI/packing-list docs), courier tracking timeline, manual-status fallback, delete.
export default async function SmsShipmentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const shipment = await getSmsShipment(id);
  if (!shipment) notFound();
  // couriers + modes back the editable Carrier/Mode pickers — the mode is what the
  // landed-cost push maps to the NetSuite shipping method (custbody16).
  const [documents, couriers, modes] = await Promise.all([
    getSmsShipmentDocuments(id), getSmsCouriers(), getSmsModes(),
  ]);
  return <SmsShipmentDetail shipment={shipment} documents={documents} couriers={couriers} modes={modes} />;
}
