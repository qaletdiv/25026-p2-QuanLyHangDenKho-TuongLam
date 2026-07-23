import { NotFoundCard } from '@/modules/mainline/components/RouteFallbacks';

export default function PoMasterDetailNotFound() {
  return <NotFoundCard noun="Purchase order" backHref="/mainline/purchase-orders" backLabel="Back to Purchase Orders" />;
}
