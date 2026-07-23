/**
 * Single source of truth for whether an ASN (packing list) can be sent for a
 * shipment / booking. Used by the Shipments table and both shipment detail
 * pages so the gating rule can never drift between surfaces.
 *
 * Rule (per product spec): the ASN button is enabled when
 *   1. shipment data is available — i.e. the booking has a confirmed
 *      commercial_invoice (uploading shipment data sets this automatically,
 *      deleting it removes it), AND
 *   2. an estimated delivery date (E-DEL) exists on every shipment row in
 *      scope. Mainline rows carry `e_del`; SMS/courier rows use `eta` as their
 *      delivery estimate, so either satisfies the requirement.
 *
 * The backend ASN endpoint enforces the same two conditions.
 */

export interface AsnGateResult {
  /** True when the Send ASN action should be enabled. */
  enabled: boolean;
  /** True when an ASN has already been sent for any row in scope. */
  alreadySent: boolean;
  /** Human-readable reason the button is disabled (for tooltips / hints). */
  reason?: string;
}

interface AsnRow {
  e_del?: string | null;
  eta?: string | null;
  asn_sent?: boolean;
}

interface AsnBooking {
  commercial_invoice?: { status?: string } | null;
}

interface AsnGateInput {
  /** The booking linked to these rows — source of the confirmed CI. */
  booking?: AsnBooking | null;
  /** Shipment rows in scope: a single row → `[row]`; a multi-PO group → all rows. */
  rows: AsnRow[];
}

/** Returns whether a row has an estimated delivery date (E-DEL, or ETA for SMS). */
function hasEstimatedDelivery(row: AsnRow): boolean {
  return Boolean(row.e_del || row.eta);
}

export function canSendAsn({ booking, rows }: AsnGateInput): AsnGateResult {
  const list = (rows || []).filter(Boolean);
  const alreadySent = list.some(r => r.asn_sent);

  const ciConfirmed = booking?.commercial_invoice?.status === 'confirmed';
  if (!ciConfirmed) {
    return { enabled: false, alreadySent, reason: 'Upload shipment data to enable ASN' };
  }

  const allHaveEdel = list.length > 0 && list.every(hasEstimatedDelivery);
  if (!allHaveEdel) {
    return { enabled: false, alreadySent, reason: 'Estimated delivery (E-DEL) required before sending ASN' };
  }

  return { enabled: true, alreadySent };
}
