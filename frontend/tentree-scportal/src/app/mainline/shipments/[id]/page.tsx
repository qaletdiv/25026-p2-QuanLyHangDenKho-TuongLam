import { notFound } from 'next/navigation';
import { getMainlineShipment, getMainlineDocuments, getMainlineAsn, getPorts, getContainerTypes } from '@/modules/mainline/actions';
import ShipmentDetail from '@/modules/mainline/components/ShipmentDetail';

// Mainline shipment detail — tracking + leg documents + ASN (shipment-scoped).
export default async function MainlineShipmentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const shipment = await getMainlineShipment(id);
  if (!shipment) notFound();
  const [documents, asn, ports, containerTypes] = await Promise.all([
    shipment.booking_id ? getMainlineDocuments(shipment.booking_id) : Promise.resolve([]),
    getMainlineAsn(id),
    getPorts(),
    getContainerTypes(),
  ]);
  return <ShipmentDetail shipment={shipment} documents={documents} asn={asn} ports={ports} containerTypes={containerTypes} />;
}
