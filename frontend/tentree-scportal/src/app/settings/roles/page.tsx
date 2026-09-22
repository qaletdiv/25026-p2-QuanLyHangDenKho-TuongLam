import React from 'react';
import { ShieldCheck } from 'lucide-react';
import { SettingsHeader } from '@/components/settings/SettingsHeader';
import { RoleSettings } from '@/components/settings/RoleSettings';

export default function RolesPage() {
  return (
    <div>
      <SettingsHeader
        title="Role Management"
        description="Define what each role can access. Tick the permissions, then Save — changes apply within seconds."
        icon={<ShieldCheck className="w-6 h-6 text-primary" />}
      />
      <RoleSettings />
    </div>
  );
}
