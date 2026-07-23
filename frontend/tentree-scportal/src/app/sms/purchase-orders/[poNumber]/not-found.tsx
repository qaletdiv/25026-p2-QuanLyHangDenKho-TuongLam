import { NotFoundCard } from '@/modules/mainline/components/RouteFallbacks';

export default function SmsPoNotFound() {
  return <NotFoundCard noun="SMS purchase order" backHref="/sms/purchase-orders" backLabel="Back to SMS Purchase Orders" />;
}
