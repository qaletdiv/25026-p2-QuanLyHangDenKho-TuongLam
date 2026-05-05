
import React from 'react';
import { FileText } from 'lucide-react';
import { SettingsHeader } from '@/components/settings/SettingsHeader';
import { IncotermSettings } from '@/components/settings/IncotermSettings';

export default function IncotermsPage() {
  return (
    <div className="p-8 max-w-4xl mx-auto pb-20">
      <SettingsHeader 
        title="Incoterm Management" 
        description="Configure commercial trade terms (DDP, FOB, etc)."
        icon={<FileText className="w-6 h-6 text-primary" />}
      />
      <IncotermSettings />
    </div>
  );
}
