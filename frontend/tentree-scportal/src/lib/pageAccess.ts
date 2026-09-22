// WHICH PERMISSION OPENS WHICH PAGE — one table, used by both the sidebar and
// the route gate.
//
// The bug this fixes: the nav keys (purchase_orders, bookings, …) are documented
// as "page visibility", but the ONLY thing reading them was Sidebar's `can()`,
// which hides a link. Typing /mainline/purchase-orders still rendered the page,
// because src/proxy.ts checked authentication only and the backend leaves the
// transactional reads (/po, /mainline/*, /sms/*) auth-only on purpose — the
// Bookings page fetches /po + /po/legs, so gating those on `purchase_orders`
// would break Production and Freight Forwarder.
//
// So page visibility has to be enforced where pages are served, and the nav and
// the gate must not be able to disagree: they read the SAME rows below. Add a
// page here and it is gated and navigable in one edit; add it only to the
// sidebar and it would be a hole (which is exactly how this one appeared).

import type { Permission } from './permissions';

export type NavPage = {
  /** stable id — the Sidebar maps it to an icon */
  key: string;
  name: string;
  /** where the sidebar link points */
  href: string;
  /** NAV permission required to open ANY of `prefixes` */
  permission: Permission;
  /** every route this page owns: used for the gate AND the nav active state */
  prefixes: string[];
};

// Mainline and SMS share one sidebar entry each; the module tab strip switches
// between them, so both routes ride the same permission.
export const NAV_PAGES: NavPage[] = [
  { key: 'purchase_orders', name: 'Purchase Orders', href: '/mainline/purchase-orders', permission: 'purchase_orders', prefixes: ['/mainline/purchase-orders', '/sms/purchase-orders'] },
  { key: 'bookings',        name: 'Bookings',        href: '/mainline/bookings',        permission: 'bookings',        prefixes: ['/mainline/bookings', '/sms/bookings'] },
  { key: 'shipments',       name: 'Shipments',       href: '/mainline/shipments',       permission: 'shipments',       prefixes: ['/mainline/shipments', '/sms/shipments'] },
  { key: 'reports',         name: 'Reports',         href: '/reports/mainline',         permission: 'reports',         prefixes: ['/reports'] },
  { key: 'forecast',        name: 'Forecast',        href: '/forecast',                 permission: 'forecast',        prefixes: ['/forecast'] },
  { key: 'contacts',        name: 'Contacts',        href: '/contacts',                 permission: 'contacts',       prefixes: ['/contacts'] },
  { key: 'freight',         name: 'Freight Rates',   href: '/freights',                 permission: 'freight',         prefixes: ['/freights'] },
  { key: 'landed_costs',    name: 'Landed Costs',    href: '/landed-costs/sms',         permission: 'landed_costs',    prefixes: ['/landed-costs'] },
  // 3PL invoice verification reuses `landed_costs` (same finance audience).
  // One tab per invoicing warehouse under /invoices; /nri-invoices still resolves
  // (it redirects), so it stays in `prefixes` or the gate would bounce the
  // redirect itself and old links would land on /no-access.
  { key: 'all_invoices',    name: 'All Invoices',    href: '/invoices',                 permission: 'landed_costs',    prefixes: ['/invoices', '/nri-invoices'] },
];

/**
 * Route prefix → required permission, most specific first.
 * `/settings/*` is master data (`settings`), except Roles and Users, which are
 * the account-administration screens and take `user_manage` — matching what the
 * Sidebar shows and what /users + /roles enforce server-side.
 */
type RoutePermission = { prefix: string; permission: Permission };

const SETTINGS_ROUTES: RoutePermission[] = [
  { prefix: '/settings/roles', permission: 'user_manage' },
  { prefix: '/settings/users', permission: 'user_manage' },
  { prefix: '/settings', permission: 'settings' },
];

export const ROUTE_PERMISSIONS: RoutePermission[] = [
  ...SETTINGS_ROUTES,
  ...NAV_PAGES.flatMap((p) => p.prefixes.map((prefix) => ({ prefix, permission: p.permission }))),
].sort((a, b) => b.prefix.length - a.prefix.length);

/** The permission a path needs, or null when the path is open to any signed-in user. */
export function requiredPermissionFor(pathname: string): Permission | null {
  const hit = ROUTE_PERMISSIONS.find(
    (r) => pathname === r.prefix || pathname.startsWith(`${r.prefix}/`),
  );
  return hit ? hit.permission : null;
}

/**
 * Where to send someone who has no business on the page they asked for (and
 * where `/` should land): their first visible nav page, or the no-access screen
 * if they hold no page permission at all. Never returns a page they can't open,
 * so it cannot bounce the gate in a loop.
 */
export function firstAllowedPath(permissions: string[] | null | undefined): string {
  const held = new Set(permissions ?? []);
  const page = NAV_PAGES.find((p) => held.has(p.permission));
  if (page) return page.href;
  if (held.has('settings')) return '/settings/suppliers';
  return '/no-access';
}
