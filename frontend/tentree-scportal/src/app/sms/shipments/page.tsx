import { getSmsShipments, getSmsPos, getSmsCouriers } from '@/modules/sms/actions';
import SmsShipmentsTable from '@/modules/sms/components/SmsShipmentsTable';
import ModuleTabs, { SHIPMENT_TABS } from '@/components/layout/ModuleTabs';

// SMS shipments (consignments) — vendor self-service entry, courier-derived
// status, FedEx tracking poll. POs + couriers feed the create form (destinations
// are derived from the POs — a consignment ships to one destination).
export default async function SmsShipmentsPage() {
  const [shipments, pos, couriers] = await Promise.all([
    getSmsShipments(), getSmsPos(), getSmsCouriers(),
  ]);
  return (
    <div>
      <div className="px-6 pt-6"><ModuleTabs tabs={SHIPMENT_TABS} /></div>
      <SmsShipmentsTable shipments={shipments} pos={pos} couriers={couriers} />
    </div>
  );
}
