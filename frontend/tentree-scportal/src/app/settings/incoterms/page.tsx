
import React from 'react';
import { FileText } from 'lucide-react';
import { SettingsHeader } from '@/components/settings/SettingsHeader';
import { IncotermSettings } from '@/components/settings/IncotermSettings';

export default function IncotermsPage() {
  return (
    <div>
      <SettingsHeader 
        title="Incoterm Management" 
        description="Configure commercial trade terms (DDP, FOB, etc)."
        icon={<FileText className="w-6 h-6 text-primary" />}
      />
      <IncotermSettings />
    </div>
  );
}
