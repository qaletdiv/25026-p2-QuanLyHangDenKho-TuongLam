import { NotFoundCard } from '@/modules/mainline/components/RouteFallbacks';

export default function MainlineShipmentDetailNotFound() {
  return <NotFoundCard noun="Shipment" backHref="/mainline/shipments" backLabel="Back to Shipments" />;
}
