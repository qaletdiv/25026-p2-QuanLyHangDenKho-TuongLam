import OrdersTable from './OrdersTable';
import { getPurchaseOrders } from '@/app/actions/purchase-orders';
import { getSession } from '@/app/actions/auth';

export default async function PurchaseOrdersPage() {
  let pos = [];
  try {
    const [allPOs, session] = await Promise.all([getPurchaseOrders(), getSession()]);
    const isVendor = session?.role === 'Vendor';
    pos = (allPOs || []).filter((p: any) =>
      !isVendor || p.supplier === session.supplier
    );
  } catch {
    // render with empty state
  }

  return <OrdersTable initialPOs={pos} />;
}
