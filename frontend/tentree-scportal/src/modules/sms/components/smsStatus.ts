// SMS status vocabulary (statuses.json module='sms') + shared badge styling.
// Displayed status is DERIVED server-side: latest courier tracking event via
// courier_status_map, falling back to the manually entered status — then one step
// further, Delivered → Received once NetSuite has an Item Receipt for every PO in
// the box. Delivered = the courier dropped it off; Received = the warehouse booked
// it in. See backend modules/sms/smsService.deriveStatus.

export const SMS_STATUSES = ['Label Created', 'Picked Up', 'In Transit', 'Out for Delivery', 'Delivered', 'Received', 'Exception'] as const;

// What a human may set by hand. 'Received' is excluded on purpose (the server
// rejects it too): it means "there is an Item Receipt", which only NetSuite knows.
export const SMS_MANUAL_STATUSES = SMS_STATUSES.filter((s) => s !== 'Received');

// Where a displayed status came from, as a short tag next to the badge.
export const SMS_SOURCE_LABELS: Record<string, string> = {
  courier:  'from courier tracking',
  manual:   'manual',
  netsuite: 'from NetSuite',
};

export const SMS_STATUS_STYLES: Record<string, string> = {
  'Label Created':    'bg-slate-500/10 text-slate-600 border-slate-500/20',
  'Picked Up':        'bg-blue-500/10 text-blue-600 border-blue-500/20',
  'In Transit':       'bg-violet-500/10 text-violet-600 border-violet-500/20',
  'Out for Delivery': 'bg-cyan-500/10 text-cyan-600 border-cyan-500/20',
  'Delivered':        'bg-emerald-500/10 text-emerald-600 border-emerald-500/20',
  // Solid deep green — the only filled badge in the set. Received is the terminal
  // state (courier delivered AND NetSuite booked it in), and a tint one step off
  // Delivered was too easy to miss at a glance in a column of pale badges. Solid
  // also keeps its contrast in both the light and dark themes, where a darker
  // TEXT colour would have gone muddy on the dark background.
  'Received':         'bg-emerald-700 text-white border-emerald-700',
  'Exception':        'bg-red-500/10 text-red-600 border-red-500/20',
};

export const FULFILLMENT_STYLES: Record<string, string> = {
  not_shipped:       'bg-slate-500/10 text-slate-600 border-slate-500/20',
  partially_shipped: 'bg-amber-500/10 text-amber-600 border-amber-500/20',
  fully_shipped:     'bg-blue-500/10 text-blue-600 border-blue-500/20',
  received:          'bg-emerald-500/10 text-emerald-600 border-emerald-500/20',
};
export const FULFILLMENT_LABELS: Record<string, string> = {
  not_shipped: 'Not Shipped',
  partially_shipped: 'Partially Shipped',
  fully_shipped: 'Fully Shipped',
  received: 'Received',
};

// Display-only facility relabel (data stays "Direct tentree"). The NetSuite
// "Direct Shipment : Ten Tree" location means ship to tentree's office — distinct
// from Direct US / Direct CAN (ship direct to customers) — so show "Head Office".
export function facilityLabel(name: string | null): string | null {
  if (!name) return name;
  return name === 'Direct tentree' ? 'Head Office' : name;
}

// "SS27" → sortable number (year, then SS before FW within a year)
export function seasonRank(code: string | null): number {
  const m = String(code || '').match(/^([A-Za-z]+)\s*(\d+)$/);
  if (!m) return -1;
  const half = m[1].toUpperCase() === 'FW' ? 1 : 0;
  return Number(m[2]) * 2 + half;
}
