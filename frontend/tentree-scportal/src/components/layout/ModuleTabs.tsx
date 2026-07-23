'use client';

// Mainline | SMS switcher shown atop the shared list surfaces (Purchase Orders,
// Shipments). The two modules are fully separate datasets at different grains —
// this is navigation only, no merged tables. Same visual as the reports/forecast
// tab strips. Rendered on the LIST pages only (detail routes have no tabs).

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';

export interface ModuleTab {
  href: string;
  label: string;
  matchPrefix?: string;   // active when the path starts with this (defaults to href)
}

export default function ModuleTabs({ tabs }: { tabs: ModuleTab[] }) {
  const pathname = usePathname();
  return (
    <div className="flex gap-1 border-b border-border">
      {tabs.map((t) => {
        const active = pathname.startsWith(t.matchPrefix ?? t.href);
        return (
          <Link
            key={t.href}
            href={t.href}
            className={cn(
              'px-4 py-2 text-sm font-semibold border-b-2 -mb-px transition-colors',
              active
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {t.label}
          </Link>
        );
      })}
    </div>
  );
}

export const PO_TABS: ModuleTab[] = [
  { href: '/mainline/purchase-orders', label: 'Mainline' },
  { href: '/sms/purchase-orders', label: 'SMS' },
];

export const SHIPMENT_TABS: ModuleTab[] = [
  { href: '/mainline/shipments', label: 'Mainline' },
  { href: '/sms/shipments', label: 'SMS' },
];
