import { getMainlineShipments } from '@/modules/mainline/actions';
import ShipmentsTable from '@/modules/mainline/components/ShipmentsTable';
import ModuleTabs, { SHIPMENT_TABS } from '@/components/layout/ModuleTabs';

// Mainline shipments (Phase 5b) — tracking list + status updates. No courier/tracking.
export default async function MainlineShipmentsPage() {
  const shipments = await getMainlineShipments();
  return (
    <div>
      <div className="px-6 pt-6"><ModuleTabs tabs={SHIPMENT_TABS} /></div>
      <ShipmentsTable shipments={shipments} />
    </div>
  );
}
