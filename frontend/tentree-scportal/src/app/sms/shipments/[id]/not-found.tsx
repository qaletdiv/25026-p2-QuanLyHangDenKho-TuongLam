import { NotFoundCard } from '@/modules/mainline/components/RouteFallbacks';

export default function SmsShipmentNotFound() {
  return <NotFoundCard noun="SMS shipment" backHref="/sms/shipments" backLabel="Back to SMS Shipments" />;
}
