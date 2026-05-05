import PurchaseOrdersClient from './PurchaseOrdersClient';
import { getPurchaseOrders } from '@/app/actions/purchase-orders';

export default async function PurchaseOrdersPage() {
  let pos = [];
  try {
    pos = await getPurchaseOrders() || [];
  } catch (e) {
    console.error('Failed to fetch purchase orders:', e);
  }

  return <PurchaseOrdersClient initialPOs={pos} />;
}
