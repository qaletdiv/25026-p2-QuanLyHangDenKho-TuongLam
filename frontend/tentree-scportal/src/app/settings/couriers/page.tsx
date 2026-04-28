'use client';

import React from 'react';
import { Truck } from 'lucide-react';
import { SettingsHeader } from '@/components/settings/SettingsHeader';
import { CourierSettings } from '@/components/settings/CourierSettings';

export default function CouriersPage() {
  return (
    <div className="p-8 max-w-4xl mx-auto pb-20">
      <SettingsHeader 
        title="Courier Management" 
        description="Configure available shipping carriers and couriers."
        icon={<Truck className="w-6 h-6 text-primary" />}
      />
      <CourierSettings />
    </div>
  );
}
