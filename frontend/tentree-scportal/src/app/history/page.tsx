import HistoryClient from './HistoryClient';
import { getHistoryShipments } from '@/app/actions/history';

export default async function HistoryPage() {
  let shipments = [];
  try {
    shipments = await getHistoryShipments() || [];
  } catch {
    // render with empty state
  }

  return <HistoryClient initialShipments={shipments || []} />;
}
