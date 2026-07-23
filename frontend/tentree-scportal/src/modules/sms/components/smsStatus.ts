// SMS status vocabulary (statuses.json module='sms') + shared badge styling.
// Displayed status is DERIVED server-side: latest courier tracking event via
// courier_status_map, falling back to the manually entered status.

export const SMS_STATUSES = ['Label Created', 'Picked Up', 'In Transit', 'Out for Delivery', 'Delivered', 'Exception'] as const;

export const SMS_STATUS_STYLES: Record<string, string> = {
  'Label Created':    'bg-slate-500/10 text-slate-600 border-slate-500/20',
  'Picked Up':        'bg-blue-500/10 text-blue-600 border-blue-500/20',
  'In Transit':       'bg-violet-500/10 text-violet-600 border-violet-500/20',
  'Out for Delivery': 'bg-cyan-500/10 text-cyan-600 border-cyan-500/20',
  'Delivered':        'bg-emerald-500/10 text-emerald-600 border-emerald-500/20',
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
