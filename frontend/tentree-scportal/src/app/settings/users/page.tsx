import React from 'react';
import { UserCog } from 'lucide-react';
import { SettingsHeader } from '@/components/settings/SettingsHeader';
import { UserSettings } from '@/components/settings/UserSettings';

export default function UsersPage() {
  return (
    <div>
      <SettingsHeader
        title="User Management"
        description="Create accounts and manage role-based access for your team."
        icon={<UserCog className="w-6 h-6 text-primary" />}
      />
      <UserSettings />
    </div>
  );
}
