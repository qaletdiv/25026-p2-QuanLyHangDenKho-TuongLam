'use client';

import React from 'react';
import { usePathname } from 'next/navigation';
import { Search, User, LogOut, ChevronDown, Menu } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { logout } from '@/app/actions/auth';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useSession } from '@/components/providers/SessionProvider';
import NotificationBell from './NotificationBell';

export default function Header({ onMenuClick }: { onMenuClick?: () => void } = {}) {
  const pathname = usePathname();
  const { user } = useSession();

  // Hide header on login page
  if (pathname === '/login') return null;

  // Determine title based on pathname
  let title = 'Portal';
  if (pathname.includes('/purchase-orders')) title = 'Purchase Orders';
  if (pathname.includes('/shipments')) title = 'Shipments';
  if (pathname.includes('/bookings')) title = 'Bookings';
  if (pathname.includes('/reports')) title = 'Reports';
  if (pathname.includes('/forecast')) title = 'Forecast';

  if (pathname.includes('/contacts')) title = 'Contacts';
  if (pathname.includes('/history')) title = 'History';
  if (pathname.includes('/settings')) title = 'Settings';

  return (
    <header className="h-16 flex items-center justify-between px-4 md:px-6 border-b border-border bg-background sticky top-0 z-10 shadow-sm">
      <div className="flex items-center gap-2 md:gap-4 min-w-0">
        <Button
          variant="ghost"
          size="icon"
          className="lg:hidden text-muted-foreground hover:bg-muted/50 -ml-1 flex-shrink-0"
          onClick={() => onMenuClick?.()}
          aria-label="Open menu"
        >
          <Menu className="w-5 h-5" />
        </Button>
        <h1 className="text-lg md:text-xl font-bold text-foreground tracking-tight truncate">{title}</h1>
      </div>

      <div className="flex items-center gap-2 md:gap-4">
        <div className="relative hidden md:flex w-48 lg:w-64">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input 
            type="search" 
            placeholder="Global search..." 
            className="pl-9 h-9 bg-muted/30 border-0 focus-visible:ring-1 rounded-full"
          />
        </div>

        <NotificationBell />

        {user && (
          <Popover>
            <PopoverTrigger asChild>
              <div className="flex items-center gap-3 pl-2 cursor-pointer hover:opacity-80 transition-opacity">
                <div className="flex flex-col items-end hidden sm:flex">
                  <span className="text-sm font-semibold text-foreground leading-none">{user.name}</span>
                  <span className="text-[10px] font-bold text-primary uppercase tracking-tighter mt-1">{user.role}</span>
                </div>
                <div className="w-9 h-9 rounded-xl bg-primary shadow-lg shadow-primary/20 flex items-center justify-center text-white">
                  <User className="w-5 h-5" />
                </div>
                <ChevronDown className="w-4 h-4 text-muted-foreground" />
              </div>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-56 p-2 mt-2 rounded-2xl shadow-2xl border-slate-100">
              <div className="p-3 mb-1 bg-slate-50 rounded-xl">
                <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-1">Signed in as</p>
                <p className="text-sm font-semibold text-slate-900 truncate">{user.email}</p>
              </div>
              <Button 
                variant="ghost" 
                className="w-full justify-start gap-2 text-destructive hover:text-destructive hover:bg-destructive/5 rounded-xl h-10"
                onClick={() => logout()}
              >
                <LogOut className="w-4 h-4" />
                Sign Out
              </Button>
            </PopoverContent>
          </Popover>
        )}
      </div>
    </header>
  );
}
