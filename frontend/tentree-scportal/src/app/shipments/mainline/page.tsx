import ShipmentsClient from '../ShipmentsClient';
import { getShipments } from '@/app/actions/shipments';
import { getPurchaseOrders } from '@/app/actions/purchase-orders';
import { mergeShipmentsAndPOs } from '../mergeShipments';

export default async function MainlineShipmentsPage() {
  let merged: any[] = [];
  try {
    const [shipmentData, poData] = await Promise.all([getShipments(), getPurchaseOrders()]);
    merged = mergeShipmentsAndPOs(shipmentData, poData);
  } catch {
    // render with empty state
  }

  return <ShipmentsClient initialShipments={merged} activeTab="mainline" />;
}
