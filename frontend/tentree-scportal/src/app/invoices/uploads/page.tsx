import { getBillingFiles, getOrderDataStatus } from '@/modules/nri-billing/actions';
import UploadsView from '@/modules/nri-billing/components/UploadsView';

export default async function UploadsPage() {
  const [CA, US, caOrders, usOrders] = await Promise.all([
    getBillingFiles('CA'), getBillingFiles('US'), getOrderDataStatus('CA'), getOrderDataStatus('US'),
  ]);
  return <UploadsView initial={{ CA, US }} orderData={{ CA: caOrders, US: usOrders }} />;
}
