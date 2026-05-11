
import React from 'react';
import { Ship } from 'lucide-react';
import { SettingsHeader } from '@/components/settings/SettingsHeader';
import { ModeSettings } from '@/components/settings/ModeSettings';

export default function ModesPage() {
  return (
    <div className="p-8 max-w-4xl mx-auto pb-20">
      <SettingsHeader
        title="Transport Mode Management"
        description="Configure transport modes available for bookings and shipments."
        icon={<Ship className="w-6 h-6 text-primary" />}
      />
      <ModeSettings />
    </div>
  );
}
