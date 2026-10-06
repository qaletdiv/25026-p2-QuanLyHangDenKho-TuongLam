'use client';

// The All Invoices section, as the team works it: the RESULT (cost per GL by
// channel) first, then where the data comes from (uploads), then what it is
// checked against (rate cards). Same strip styling as the Mainline | SMS tabs.

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';

const TABS = [
  { href: '/invoices/results', label: 'Cost per GL' },
  { href: '/invoices/uploads', label: 'Uploads' },
  { href: '/invoices/rules', label: 'Rules' },
  { href: '/invoices/gl-codes', label: 'GL Codes' },
  { href: '/invoices/rate-cards', label: 'Rate Cards' },
];

export default function BillingNav() {
  const pathname = usePathname();
  return (
    <nav className="flex flex-wrap items-center gap-1 border-b border-border">
      {TABS.map((t) => {
        const active = pathname === t.href || pathname.startsWith(`${t.href}/`);
        return (
          <Link
            key={t.href}
            href={t.href}
            className={cn(
              '-mb-px inline-flex items-center border-b-2 px-4 py-2 text-sm font-semibold transition-colors',
              active ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
