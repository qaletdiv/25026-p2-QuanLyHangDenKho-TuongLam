import React from 'react';
import { ShieldCheck } from 'lucide-react';
import { SettingsHeader } from '@/components/settings/SettingsHeader';
import { RoleSettings } from '@/components/settings/RoleSettings';

export default function RolesPage() {
  return (
    <div className="p-4 md:p-8 max-w-6xl mx-auto pb-20">
      <SettingsHeader
        title="Role Management"
        description="Define what each role can access. Changes take effect on the user's next login."
        icon={<ShieldCheck className="w-6 h-6 text-primary" />}
      />
      <RoleSettings />
    </div>
  );
}
