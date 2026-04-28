'use client';

import React from 'react';
import { Database } from 'lucide-react';

interface SettingsHeaderProps {
  title: string;
  description: string;
  icon?: React.ReactNode;
}

export function SettingsHeader({ title, description, icon }: SettingsHeaderProps) {
  return (
    <div className="flex items-center justify-between border-b pb-6 mb-8">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          {icon || <Database className="w-6 h-6 text-primary" />}
          {title}
        </h1>
        <p className="text-muted-foreground mt-1">{description}</p>
      </div>
    </div>
  );
}
