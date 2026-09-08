'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Package, FileText, Users, ShieldCheck, LogOut, BarChart3, LineChart, ClipboardList, Truck, FileCode, Palette, Sun, Flame, Warehouse, Ship, UserCog, Globe, CalendarClock, Coins, Percent, ReceiptText } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useEffect, useState } from 'react';
import { logout } from '@/app/actions/auth';
import { useSession } from '@/components/providers/SessionProvider';

const navItems = [
  // Mainline is now served by the normalized module (/mainline + /po). Legacy
  // /purchase-orders, /bookings, /shipments remain mounted ONLY for SMS until the
  // SMS module is migrated (Phase 6 = promote mainline, keep legacy for SMS).
  { name: 'Purchase Orders', href: '/mainline/purchase-orders', icon: ClipboardList, permission: 'purchase_orders', matchPrefix: ['/mainline/purchase-orders', '/sms/purchase-orders'] },
  { name: 'Bookings',        href: '/mainline/bookings',        icon: FileText,        permission: 'bookings',   matchPrefix: ['/mainline/bookings', '/sms/bookings'] },
  { name: 'Shipments',       href: '/mainline/shipments',       icon: Package,         permission: 'shipments',  matchPrefix: ['/mainline/shipments', '/sms/shipments'] },
  // SMS shares the Purchase Orders / Bookings / Shipments entries above via a
  // Mainline | SMS tab strip on each list page (ModuleTabs) — the two modules are
  // separate datasets, unified in navigation only. SMS bookings are OPTIONAL
  // (added 2026-08-07): a courier consignment reserves no space, so most SMS
  // shipments are still entered directly with no booking; a booking is used when
  // the consignment is authorized up front and clears customs formally.
  // Receiving screen removed 2026-07-03 — receipts sync from NetSuite into the PO
  // reconciliation.
  { name: 'Reports',         href: '/reports/mainline',   icon: BarChart3,       permission: 'reports', matchPrefix: '/reports' },
  { name: 'Forecast',        href: '/forecast',           icon: LineChart,       permission: 'forecast' },

  { name: 'Contacts',        href: '/contacts',           icon: Users,           permission: 'contacts' },
  { name: 'Freight Rates',   href: '/freights',           icon: Globe,           permission: 'freight' },
  { name: 'Landed Costs',    href: '/landed-costs/sms',   icon: Coins,           permission: 'landed_costs', matchPrefix: '/landed-costs' },
  // 3PL invoice verification. Reuses `landed_costs` (Admin + Logistics) rather
  // than adding a permission key — same finance audience, no roles.json edit.
  { name: 'NRI Invoices',    href: '/nri-invoices',       icon: ReceiptText,     permission: 'landed_costs', matchPrefix: '/nri-invoices' },
];

const masterDataItems = [
  { name: 'Suppliers', href: '/settings/suppliers', icon: Users },
  { name: 'Couriers', href: '/settings/couriers', icon: Truck },
  { name: 'Incoterms', href: '/settings/incoterms', icon: FileCode },
  { name: 'Statuses', href: '/settings/statuses', icon: Palette },
  { name: 'Warehouses', href: '/settings/warehouses', icon: Warehouse },
  { name: 'Transport Modes', href: '/settings/modes', icon: Ship },
  { name: 'Production Schedule', href: '/settings/production-schedules', icon: CalendarClock },
  { name: 'Landed Cost Rates', href: '/settings/landed-costs', icon: Percent },
  // icon matches the Role Management page header (settings/roles/page.tsx)
  { name: 'Roles', href: '/settings/roles', icon: ShieldCheck, adminOnly: true },
  { name: 'Users', href: '/settings/users', icon: UserCog, adminOnly: true },
];

export default function Sidebar({ mobileOpen = false, onClose }: { mobileOpen?: boolean; onClose?: () => void } = {}) {
  const pathname = usePathname();
  const { user } = useSession();
  const [isSummer, setIsSummer] = useState(false);

  useEffect(() => {
    // The theme class is already applied server-side (from the cookie). Sync the
    // toggle's state, and backfill the cookie for users who set the theme before
    // it was cookie-backed — so their NEXT reload also renders flash-free.
    const isS = localStorage.getItem('portal-theme') === 'summer'
      || document.documentElement.classList.contains('theme-summer');
    setIsSummer(isS);
    document.documentElement.classList.toggle('theme-summer', isS);
    if (isS && !/(?:^|;\s*)portal-theme=/.test(document.cookie)) {
      document.cookie = 'portal-theme=summer; path=/; max-age=31536000; samesite=lax';
    }
  }, []);

  const toggleTheme = () => {
    const next = !isSummer;
    setIsSummer(next);
    const val = next ? 'summer' : 'red';
    localStorage.setItem('portal-theme', val);
    document.cookie = `portal-theme=${val}; path=/; max-age=31536000; samesite=lax`;   // server reads this on reload
    document.documentElement.classList.toggle('theme-summer', next);
  };

  if (pathname === '/login') return null;

  const can = (permission: string) => {
    if (!user) return true; // unauthenticated: let server guard redirect
    if (!user.permissions) return user.role === 'Admin'; // legacy session: admin sees all
    return user.permissions.includes(permission);
  };

  const filteredItems = navItems.filter(item => can(item.permission));
  const showMasterData = can('settings');

  const NavLink = ({ item }: { item: any }) => {
    const prefixes = Array.isArray(item.matchPrefix)
      ? item.matchPrefix
      : item.matchPrefix ? [item.matchPrefix] : [];
    const isActive =
      pathname === item.href ||
      (prefixes.length
        ? prefixes.some((p: string) => pathname.startsWith(p))
        : (item.href !== '/' && pathname.startsWith(item.href)));
    const Icon = item.icon;
    return (
      <Link
        href={item.href}
        onClick={() => onClose?.()}
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
    <>
      {/* Mobile backdrop */}
      <div
        className={cn(
          "fixed inset-0 bg-black/40 z-40 lg:hidden transition-opacity",
          mobileOpen ? "opacity-100" : "opacity-0 pointer-events-none"
        )}
        onClick={() => onClose?.()}
        aria-hidden="true"
      />
      <div
        className={cn(
          "flex flex-col w-64 h-screen bg-card border-r border-border text-card-foreground shadow-sm",
          // Desktop: static in-flow sidebar. Mobile: off-canvas drawer.
          "fixed inset-y-0 left-0 z-50 transition-transform duration-300 lg:static lg:z-10 lg:translate-x-0",
          mobileOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0"
        )}
      >
      {/* Logo Area */}
      <div className="h-16 flex items-center px-6 border-b border-border bg-card transition-colors duration-300">
        <Link href="/mainline/purchase-orders" className="flex items-center gap-3 group">
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
              {masterDataItems
                .filter(item => !item.adminOnly || can('user_manage'))
                .map((item) => <NavLink key={item.name} item={item} />)}
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
    </>
  );
}
