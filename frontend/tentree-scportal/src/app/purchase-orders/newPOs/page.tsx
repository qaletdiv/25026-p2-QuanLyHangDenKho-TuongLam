import { getSession } from '@/app/actions/auth';
import { getSuppliers, getIncoterms, getWarehouses, getModes } from '@/app/actions/master-data';
import OrderDetail from '@/components/purchase-orders/OrderDetail';

export default async function NewPurchaseOrderPage() {
  const [session, suppliers, incoterms, warehouses, modes] = await Promise.all([
    getSession(),
    getSuppliers(),
    getIncoterms(),
    getWarehouses(),
    getModes(),
  ]);

  return (
    <OrderDetail
      po={null}
      suppliers={Array.isArray(suppliers) ? suppliers : []}
      incoterms={Array.isArray(incoterms) ? incoterms : []}
      warehouses={Array.isArray(warehouses) ? warehouses : []}
      modes={Array.isArray(modes) ? modes : []}
      user={session}
    />
  );
}
