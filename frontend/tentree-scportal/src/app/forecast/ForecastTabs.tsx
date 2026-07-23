'use client';

// Mainline | SMS switcher for the forecast pages. Mirrors the reports tab strip.
// Mainline is the root /forecast (the existing inbound-pipeline forecast); SMS is
// /forecast/sms. Exact-match the root so it isn't highlighted on the SMS route.

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';

const TABS = [
  { href: '/forecast', label: 'Mainline', exact: true },
  { href: '/forecast/sms', label: 'SMS', exact: false },
];

export default function ForecastTabs() {
  const pathname = usePathname();
  return (
    <div className="flex gap-1 border-b border-border">
      {TABS.map((t) => {
        const active = t.exact ? pathname === t.href : pathname.startsWith(t.href);
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
