import ShipmentsClient from '../ShipmentsClient';

// History is loaded lazily inside ShipmentsClient when activeTab === 'history'
export default function HistoryShipmentsPage() {
  return <ShipmentsClient initialShipments={[]} activeTab="history" />;
}
