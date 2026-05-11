'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Plus, Clock, FileText, History, Send } from 'lucide-react';
import { cn } from '@/lib/utils';

const tabs = [
  { label: 'Pending', href: '/bookings/pending', icon: Clock },
  { label: 'Active Bookings', href: '/bookings/active', icon: FileText },
  { label: 'History', href: '/bookings/history', icon: History },
  { label: 'Submit Booking', href: '/bookings/submit', icon: Send },
];

export default function BookingsSubNav() {
  const pathname = usePathname();
  const router = useRouter();
  const isActive = pathname === '/bookings/active';

  return (
    <div className="border-b border-border px-6 py-4 bg-card">
      <div className="flex items-center justify-between mb-3">
        <h1 className="text-xl font-semibold font-inter">Bookings</h1>
        {isActive && (
          <Button onClick={() => router.push('/bookings/submit')}>
            <Plus className="w-4 h-4 mr-1.5" /> New Booking
          </Button>
        )}
      </div>
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
