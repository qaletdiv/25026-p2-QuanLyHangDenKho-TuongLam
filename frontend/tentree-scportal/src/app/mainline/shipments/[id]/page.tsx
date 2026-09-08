import { notFound } from 'next/navigation';
import { getMainlineShipment, getMainlineDocuments, getMainlineAsn, getPorts, getContainerTypes, getCarriers } from '@/modules/mainline/actions';
import ShipmentDetail from '@/modules/mainline/components/ShipmentDetail';

// Mainline shipment detail — tracking + leg documents + ASN (shipment-scoped).
export default async function MainlineShipmentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const shipment = await getMainlineShipment(id);
  if (!shipment) notFound();
  // carriers back the Carrier picker — the carrier decides whether this shipment's
  // landed cost is the actual off invoices or an estimate from the CI value.
  const [documents, asn, ports, containerTypes, couriers] = await Promise.all([
    shipment.booking_id ? getMainlineDocuments(shipment.booking_id) : Promise.resolve([]),
    getMainlineAsn(id),
    getPorts(),
    getContainerTypes(),
    getCarriers(),
  ]);
  return <ShipmentDetail shipment={shipment} documents={documents} asn={asn} ports={ports} containerTypes={containerTypes} couriers={couriers} />;
}
