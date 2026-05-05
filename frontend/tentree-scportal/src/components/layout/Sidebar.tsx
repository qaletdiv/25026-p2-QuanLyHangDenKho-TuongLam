'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LayoutDashboard, Package, FileText, CalendarCheck, Users, Settings, LogOut, BarChart3, LineChart, ClipboardList, Truck, FileCode, Palette, Sun, Flame } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useEffect, useState } from 'react';
import { logout } from '@/app/actions/auth';
import { useSession } from '@/components/providers/SessionProvider';

const navItems = [
  { name: 'Dashboard', href: '/', icon: LayoutDashboard },
  { name: 'Purchase Orders', href: '/purchase-orders', icon: ClipboardList },
  { name: 'Shipments', href: '/shipments', icon: Package },
  { name: 'Bookings', href: '/bookings', icon: FileText },
  { name: 'Reports', href: '/reports', icon: BarChart3 },
  { name: 'Forecast', href: '/forecast', icon: LineChart },
  { name: 'EoM Progress', href: '/eom', icon: CalendarCheck },
  { name: 'Contacts', href: '/contacts', icon: Users },
];

const masterDataItems = [
  { name: 'Suppliers', href: '/settings/suppliers', icon: Users },
  { name: 'Couriers', href: '/settings/couriers', icon: Truck },
  { name: 'Incoterms', href: '/settings/incoterms', icon: FileCode },
  { name: 'Statuses', href: '/settings/statuses', icon: Palette },
];

export default function Sidebar() {
  const pathname = usePathname();
  const { user } = useSession();
  const [isSummer, setIsSummer] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem('portal-theme');
    if (saved === 'summer') {
      document.documentElement.classList.add('theme-summer');
      setIsSummer(true);
    }
  }, []);

  const toggleTheme = () => {
    const next = !isSummer;
    setIsSummer(next);
    localStorage.setItem('portal-theme', next ? 'summer' : 'red');
    document.documentElement.classList.toggle('theme-summer', next);
  };

  if (pathname === '/login') return null;

  const filteredItems = navItems.filter(item => {
    if (!user) return true;
    if (user.role === 'Vendor') return ['Bookings', 'Shipments'].includes(item.name);
    if (user.role === 'Production') return ['Shipments', 'Dashboard', 'Reports', 'Forecast'].includes(item.name);
    return true;
  });

  const showMasterData = !user || ['Admin', 'Logistics Coordinator'].includes(user.role);

  const NavLink = ({ item }: { item: any }) => {
    const isActive = pathname === item.href || (item.href !== '/' && pathname.startsWith(item.href));
    const Icon = item.icon;
    return (
      <Link
        href={item.href}
        className={cn(
          "flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-all duration-200 group",
          isActive
            ? "bg-primary text-primary-foreground shadow-md shadow-primary/20"
            : "text-muted-foreground hover:bg-muted hover:text-foreground"
        )}
      >
        <Icon className={cn("w-4 h-4", isActive ? "" : "group-hover:text-foreground")} />
        {item.name}
      </Link>
    );
  };

  return (
    <div className="flex flex-col w-64 h-screen bg-card border-r border-border text-card-foreground shadow-sm z-10 sticky top-0">
      {/* Logo Area */}
      <div className="h-16 flex items-center px-6 border-b border-border bg-card transition-colors duration-300">
        <Link href="/" className="flex items-center gap-3 group">
          <img
            src={isSummer ? "/tentree_black.png" : "/tentree_white.png"}
            alt="Tentree Logo"
            className="h-8 w-auto object-contain transition-all duration-300 group-hover:scale-110"
          />
          <span className={cn(
            "text-[11px] font-black uppercase tracking-[0.2em] leading-none transition-colors duration-300",
            isSummer ? "text-[#1a1a1a]" : "text-white/80"
          )}>
            Supply Chain
          </span>
        </Link>
      </div>

      {/* Navigation */}
      <div className="flex-1 overflow-y-auto py-6 px-4 space-y-8">
        <div>
          <h3 className="px-3 text-[10px] font-bold uppercase tracking-wider text-muted-foreground/60 mb-2">Main Menu</h3>
          <nav className="space-y-1">
            {filteredItems.map((item) => <NavLink key={item.name} item={item} />)}
          </nav>
        </div>

        {showMasterData && (
          <div>
            <h3 className="px-3 text-[10px] font-bold uppercase tracking-wider text-muted-foreground/60 mb-2">Master Data</h3>
            <nav className="space-y-1">
              {masterDataItems.map((item) => <NavLink key={item.name} item={item} />)}
            </nav>
          </div>
        )}
      </div>

      {/* Bottom Actions */}
      <div className="p-4 border-t border-border bg-card/50 space-y-1">
        <button
          className="flex w-full items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground transition-all"
          onClick={toggleTheme}
        >
          {isSummer ? <Flame className="w-4 h-4 text-red-500" /> : <Sun className="w-4 h-4 text-yellow-400" />}
          {isSummer ? 'Classic Red' : 'Summer'}
        </button>
        <button
          className={cn(
            "flex w-full items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-all",
            isSummer ? "text-black hover:bg-primary/30" : "text-destructive hover:bg-destructive/10"
          )}
          onClick={() => logout()}
        >
          <LogOut className="w-4 h-4" />
          Log out
        </button>
        <div className="pt-4 pb-2 text-center">
          <p className="text-[10px] font-medium text-muted-foreground/40 uppercase tracking-[0.2em]">
            Developed by <span className="text-primary/60 font-bold italic">lampossible</span>
          </p>
        </div>
      </div>
    </div>
  );
}
