import { notFound } from 'next/navigation';
import { getPurchaseOrder } from '@/app/actions/purchase-orders';
import { getSession } from '@/app/actions/auth';
import { getSuppliers, getIncoterms, getWarehouses, getModes } from '@/app/actions/master-data';
import OrderDetail from '@/components/purchase-orders/OrderDetail';

export default async function PurchaseOrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [po, session, suppliers, incoterms, warehouses, modes] = await Promise.all([
    getPurchaseOrder(id),
    getSession(),
    getSuppliers(),
    getIncoterms(),
    getWarehouses(),
    getModes(),
  ]);

  if (!po || po.error) notFound();

  return (
    <OrderDetail
      po={po}
      suppliers={Array.isArray(suppliers) ? suppliers : []}
      incoterms={Array.isArray(incoterms) ? incoterms : []}
      warehouses={Array.isArray(warehouses) ? warehouses : []}
      modes={Array.isArray(modes) ? modes : []}
      user={session}
    />
  );
}
