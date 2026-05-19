/** All defined permission keys */
export const ALL_PERMISSIONS = [
  // Pages
  'dashboard', 'purchase_orders', 'bookings', 'shipments',
  'reports', 'forecast', 'eom', 'contacts', 'settings', 'freight',
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

/** Grouped manifest used to render the permission matrix UI */
export const PERMISSION_MANIFEST: { category: string; items: { key: Permission; label: string }[] }[] = [
  {
    category: 'Pages',
    items: [
      { key: 'dashboard',       label: 'Dashboard' },
      { key: 'purchase_orders', label: 'Purchase Orders' },
      { key: 'bookings',        label: 'Bookings' },
      { key: 'shipments',       label: 'Shipments' },
      { key: 'reports',         label: 'Reports' },
      { key: 'forecast',        label: 'Forecast' },
      { key: 'eom',             label: 'EoM Progress' },
      { key: 'contacts',        label: 'Contacts' },
      { key: 'settings',        label: 'Settings' },
      { key: 'freight',         label: 'Freight Rates' },
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
