/** All defined permission keys */
export const ALL_PERMISSIONS = [
  // Pages
  'purchase_orders', 'bookings', 'shipments',
  'reports', 'forecast', 'contacts', 'settings', 'freight', 'landed_costs',
  // Booking actions
  'booking_create_mainline', 'booking_create_sms', 'booking_approve', 'booking_delete',
  // Shipment actions
  'shipment_update_status', 'shipment_delete', 'shipment_import_export',
  // PO actions
  'po_edit',
  // Admin actions
  'settings_edit', 'user_manage',
] as const;

export type Permission = typeof ALL_PERMISSIONS[number];

/**
 * Does this session hold a permission key?
 *
 * `permissions[]` is re-resolved per render from GET /me (see the root layout), so
 * a granted or revoked key follows without a re-login. It decides what to DRAW only
 * — every action it guards is enforced again server-side by requirePermission,
 * which is the real control; a stale page can still POST.
 *
 * Fails CLOSED with no session. A LEGACY session predating permissions[] falls back
 * to the role name, or an admin holding an old cookie would lose every action button.
 */
export function hasPermission(
  user: { role?: string; permissions?: string[] } | null | undefined,
  permission: Permission | string,
): boolean {
  if (!user) return false;
  if (!user.permissions) return user.role === 'Admin';
  return user.permissions.includes(permission);
}

/** Hover text on an Approve button the caller may look at but not press. */
export const APPROVE_DENIED_HINT =
  'You do not have permission to approve bookings — this is with logistics.';

/** Grouped manifest used to render the permission matrix UI */
export const PERMISSION_MANIFEST: { category: string; items: { key: Permission; label: string }[] }[] = [
  {
    category: 'Pages',
    items: [
      { key: 'purchase_orders', label: 'Purchase Orders' },
      { key: 'bookings',        label: 'Bookings' },
      { key: 'shipments',       label: 'Shipments' },
      { key: 'reports',         label: 'Reports' },
      { key: 'forecast',        label: 'Forecast' },
      { key: 'contacts',        label: 'Contacts' },
      { key: 'settings',        label: 'Settings' },
      { key: 'freight',         label: 'Freight Rates' },
      { key: 'landed_costs',    label: 'Landed Costs' },
    ],
  },
  {
    category: 'Bookings',
    items: [
      { key: 'booking_create_mainline', label: 'Create Mainline Booking' },
      { key: 'booking_create_sms',      label: 'Create SMS Booking' },
      { key: 'booking_approve',         label: 'Approve Booking' },
      { key: 'booking_delete',          label: 'Delete Booking' },
    ],
  },
  {
    category: 'Shipments',
    items: [
      { key: 'shipment_update_status',   label: 'Update Status' },
      { key: 'shipment_delete',          label: 'Delete Shipment' },
      { key: 'shipment_import_export',   label: 'Import / Export' },
    ],
  },
  {
    category: 'Purchase Orders',
    items: [
      { key: 'po_edit', label: 'Edit / Delete POs' },
    ],
  },
  {
    category: 'Administration',
    items: [
      { key: 'settings_edit', label: 'Edit Master Data' },
      { key: 'user_manage',   label: 'Manage Users & Roles' },
    ],
  },
];
