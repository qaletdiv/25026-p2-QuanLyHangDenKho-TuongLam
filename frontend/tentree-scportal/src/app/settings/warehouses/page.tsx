
import React from 'react';
import { Warehouse } from 'lucide-react';
import { SettingsHeader } from '@/components/settings/SettingsHeader';
import { WarehouseSettings } from '@/components/settings/WarehouseSettings';

export default function WarehousesPage() {
  return (
    <div className="p-8 max-w-4xl mx-auto pb-20">
      <SettingsHeader
        title="Warehouse Management"
        description="Configure receiving warehouses available for bookings and shipments."
        icon={<Warehouse className="w-6 h-6 text-primary" />}
      />
      <WarehouseSettings />
    </div>
  );
}
