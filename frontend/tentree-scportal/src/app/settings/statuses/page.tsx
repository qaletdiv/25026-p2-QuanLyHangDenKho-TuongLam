
import React from 'react';
import { Palette } from 'lucide-react';
import { SettingsHeader } from '@/components/settings/SettingsHeader';
import { StatusSettings } from '@/components/settings/StatusSettings';

export default function StatusesPage() {
  return (
    <div className="p-4 md:p-8 max-w-4xl mx-auto pb-20">
      <SettingsHeader 
        title="Status Management" 
        description="Configure shipment tracking statuses and badge aesthetics."
        icon={<Palette className="w-6 h-6 text-primary" />}
      />
      <StatusSettings />
    </div>
  );
}
