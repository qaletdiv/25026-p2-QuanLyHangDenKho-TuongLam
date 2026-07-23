import { NotFoundCard } from '@/modules/mainline/components/RouteFallbacks';

export default function PoLegDetailNotFound() {
  return <NotFoundCard noun="PO leg" backHref="/mainline/purchase-orders" backLabel="Back to Purchase Orders" />;
}
