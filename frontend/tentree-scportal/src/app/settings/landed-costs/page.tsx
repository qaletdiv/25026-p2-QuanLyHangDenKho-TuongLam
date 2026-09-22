import React from 'react';
import { Percent } from 'lucide-react';
import { SettingsHeader } from '@/components/settings/SettingsHeader';
import { LandedCostSettings } from '@/components/settings/LandedCostSettings';
import { CommissionRatesSettings } from '@/components/settings/CommissionRatesSettings';

export default function LandedCostRatesPage() {
  return (
    <div className="space-y-6">
      <SettingsHeader
        title="Landed Cost Rates"
        description="Freight and duty percentages applied to the commercial-invoice value when estimating landed costs."
        icon={<Percent className="w-6 h-6 text-primary" />}
      />
      <LandedCostSettings />
      <CommissionRatesSettings />
    </div>
  );
}
