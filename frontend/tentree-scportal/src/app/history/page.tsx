import HistoryClient from './HistoryClient';
import { getHistoryShipments } from '@/app/actions/history';

export default async function HistoryPage() {
  let shipments = [];
  try {
    shipments = await getHistoryShipments() || [];
  } catch (e) {
    console.error('Failed to fetch history shipments:', e);
  }

  return <HistoryClient initialShipments={shipments || []} />;
}
