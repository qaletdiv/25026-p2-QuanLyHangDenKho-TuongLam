'use client';

import React, { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { Bell, Search, User, LogOut, ChevronDown } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { logout } from '@/app/actions/auth';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

export default function Header() {
  const pathname = usePathname();
  const [user, setUser] = useState<any>(null);

  useEffect(() => {
    // Try to get user from cookie directly or a global state
    // For now, we'll parse it from the cookie if possible, but let's just 
    // rely on a safer method.
    try {
      const cookies = document.cookie.split('; ');
      const sessionCookie = cookies.find(row => row.startsWith('session='));
      if (sessionCookie) {
        const value = decodeURIComponent(sessionCookie.split('=')[1]);
        setUser(JSON.parse(value));
      }
    } catch (e) {
      console.error('Failed to parse user session', e);
    }
  }, [pathname]);

  // Hide header on login page
  if (pathname === '/login') return null;

  // Determine title based on pathname
  let title = 'Dashboard';
  if (pathname.includes('/shipments')) title = 'Shipments';
  if (pathname.includes('/bookings')) title = 'Bookings';

  if (pathname.includes('/eom')) title = 'End of Month';
  if (pathname.includes('/contacts')) title = 'Contacts';
  if (pathname.includes('/history')) title = 'History';

  return (
    <header className="h-16 flex items-center justify-between px-6 border-b border-border bg-background sticky top-0 z-10 shadow-sm">
      <div className="flex items-center gap-4">
        <h1 className="text-xl font-bold text-foreground tracking-tight">{title}</h1>
      </div>

      <div className="flex items-center gap-4">
        <div className="relative hidden md:flex w-64">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input 
            type="search" 
            placeholder="Global search..." 
            className="pl-9 h-9 bg-muted/30 border-0 focus-visible:ring-1 rounded-full"
          />
        </div>

        <Button variant="ghost" size="icon" className="relative text-muted-foreground hover:bg-muted/50 rounded-full">
          <Bell className="w-5 h-5" />
          <span className="absolute top-2 right-2.5 w-2 h-2 bg-destructive rounded-full border-2 border-background"></span>
        </Button>

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
