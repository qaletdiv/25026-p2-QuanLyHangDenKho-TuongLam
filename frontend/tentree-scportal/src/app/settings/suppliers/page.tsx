
import React from 'react';
import { Users } from 'lucide-react';
import { SettingsHeader } from '@/components/settings/SettingsHeader';
import { SupplierSettings } from '@/components/settings/SupplierSettings';

export default function SuppliersPage() {
  return (
    <div>
      <SettingsHeader 
        title="Supplier Management" 
        description="Configure your global list of factories and suppliers."
        icon={<Users className="w-6 h-6 text-primary" />}
      />
      <SupplierSettings />
    </div>
  );
}
