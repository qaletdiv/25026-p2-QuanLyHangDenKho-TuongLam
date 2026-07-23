import React from 'react';
import { Percent } from 'lucide-react';
import { SettingsHeader } from '@/components/settings/SettingsHeader';
import { LandedCostSettings } from '@/components/settings/LandedCostSettings';

export default function LandedCostRatesPage() {
  return (
    <div className="p-4 md:p-8 max-w-4xl mx-auto pb-20">
      <SettingsHeader
        title="Landed Cost Rates"
        description="Freight and duty percentages applied to the commercial-invoice value when estimating landed costs."
        icon={<Percent className="w-6 h-6 text-primary" />}
      />
      <LandedCostSettings />
    </div>
  );
}
