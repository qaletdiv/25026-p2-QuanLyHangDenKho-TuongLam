'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Ship, Truck, Archive } from 'lucide-react';
import { cn } from '@/lib/utils';

const tabs = [
  { label: 'Mainline Tracker', href: '/shipments/mainline', icon: Ship },
  { label: 'SMS Tracker', href: '/shipments/sms', icon: Truck },
  { label: 'History', href: '/shipments/history', icon: Archive },
];

export default function ShipmentsSubNav() {
  const pathname = usePathname();

  return (
    <div className="border-b border-border px-6 py-4 bg-card">
      <h1 className="text-xl font-semibold font-inter mb-3">Shipments</h1>
      <div className="flex gap-1">
        {tabs.map(({ label, href, icon: Icon }) => {
          const active = pathname === href;
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                'flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium transition-all',
                active
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground'
              )}
            >
              <Icon className="w-3.5 h-3.5" />
              {label}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
