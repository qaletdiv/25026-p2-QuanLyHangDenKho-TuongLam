
import React from 'react';
import { Warehouse } from 'lucide-react';
import { SettingsHeader } from '@/components/settings/SettingsHeader';
import { WarehouseSettings } from '@/components/settings/WarehouseSettings';
import { WarehouseFacilitySettings } from '@/components/settings/WarehouseFacilitySettings';
import { NotifyPartySettings } from '@/components/settings/NotifyPartySettings';

// Three blocks, and the order is deliberate: Destinations (warehouse_facilities) is
// what every normalized record joins on and what the CI / Packing List print as the
// consignee, so it leads; Notify Party is one record beside it because it is always
// tentree. Warehouses is the older warehouse×channel list kept for the screens that
// still read it — its address/port fields were removed because no document ever read
// them, which made them look maintained while the documents stayed blank.
export default function WarehousesPage() {
  return (
    <div className="space-y-6">
      <SettingsHeader
        title="Warehouse Management"
        description="Configure receiving destinations and the warehouse list available for bookings and shipments."
        icon={<Warehouse className="w-6 h-6 text-primary" />}
      />
      <WarehouseFacilitySettings />
      <NotifyPartySettings />
      <WarehouseSettings />
    </div>
  );
}
