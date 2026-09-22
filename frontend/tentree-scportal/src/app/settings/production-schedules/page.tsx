
import React from 'react';
import { CalendarClock } from 'lucide-react';
import { SettingsHeader } from '@/components/settings/SettingsHeader';
import { ProductionScheduleSettings } from '@/components/settings/ProductionScheduleSettings';

export default function ProductionSchedulesPage() {
  return (
    <div>
      <SettingsHeader
        title="Production Schedule"
        description="Set the per-season delivery cutoffs that grade the KPI report (On Time / At Risk / Late)."
        icon={<CalendarClock className="w-6 h-6 text-primary" />}
      />
      <ProductionScheduleSettings />
    </div>
  );
}
