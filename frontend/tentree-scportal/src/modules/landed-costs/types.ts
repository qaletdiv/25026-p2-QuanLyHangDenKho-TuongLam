// Landed Costs module — freight & duty (Phase 1: SMS estimates).
// Everything except the posted snapshot is DERIVED server-side per request.

export interface LandedCostRate {
  id: string;
  module: 'sms' | 'mainline';
  freight_pct: number;
  duty_pct: number;
}

// Per-supplier commission rate (% of CI value, e.g. Pratibha 1.5%). SMS and
// mainline each keep their OWN table — no sharing.
export interface LandedCostCommission {
  id: string;
  supplier_id: string;
  commission_pct: number;
}

// The posted snapshot (row in landed_costs). null until a shipment is posted.
export interface LandedCostPosted {
  id: string;
  module: string;
  shipment_id: string;
  invoice_value: number;
  freight_pct: number;
  duty_pct: number;
  freight: number;
  duty: number;
  commission?: number;   // frozen commission total (per-supplier %, e.g. Pratibha)
  posted_by: string | null;
  posted_at: string | null;
  // set when the post was pushed to NetSuite (SMS Post = commit to NetSuite).
  // The pushed IR per PO is derived at read from the matched receipts, not stored.
  netsuite_pushed_at?: string | null;
}

// Per-PO Item Receipt match — the target of the landed-cost push.
export interface LandedCostMatch {
  po_number: string;
  receipt_id: string | null;          // sms_item_receipts.id (needed to confirm)
  netsuite_ir_id: string | null;      // NetSuite internal id (PATCH push target)
  netsuite_ir_tranid: string | null;  // IR document number (e.g. IR65377) — for display/reconcile
  receipt_date: string | null;        // IR date (helps reconcile in NetSuite)
  receipt_qty: number | null;         // qty received on that IR
  shipped_pcs: number | null;         // qty this shipment shipped for the PO
  method: 'confirmed' | 'quantity' | 'sequence' | 'unmatched';
  confidence: 'high' | 'medium' | 'low';
  confirmed: boolean;                 // human-confirmed (matched_shipment_id set)
}

export interface LandedCostSplit {
  po_number: string;
  ci_value: number;
  freight: number;
  duty: number;
  commission: number;   // per-PO commission (0 unless the PO's supplier has a rate)
}

// One SMS shipment's landed-cost view (GET /landed-costs/sms → rows[]).
export interface SmsLandedCostRow {
  module: 'sms';
  shipment_id: string;
  tracking_number: string | null;
  ship_date: string | null;
  ship_month: string | null;          // YYYY-MM (for month-end grouping)
  supplier: string | null;            // derived (PO → supplier)
  season: string | null;
  facility: string | null;
  courier: string | null;             // joined (FedEx / DHL / Ceva)
  // The shipment's mode, and what the NetSuite push sends as the shipping method
  // (custbody16). NULL on an unbooked parcel, which posts as Courier.
  mode: string | null;
  pos: string[];
  has_shipping_data: boolean;
  ci_value: number;                   // commercial-invoice value (Σ pcs × unit_price)
  // BASIS (2026-08-07). A BOOKED SMS consignment behaves like mainline: freight and
  // duty are ACTUALS off the broker bill, typed on the shipment — no rate. Unbooked
  // (vendor-entered) consignments keep the CI × rate estimate.
  is_booked: boolean;
  booking_id: string | null;
  basis: 'actual' | 'estimate';
  actual: { freight: number | null; duty: number | null } | null;   // null when unbooked
  has_actuals: boolean;
  awaiting_actual: boolean;           // booked, bill not entered → not postable
  customs_entry_number: string | null;
  estimate: { freight_pct: number; duty_pct: number; freight: number; duty: number; commission?: number };
  commission: number;                 // effective commission total (posted snapshot or estimate)
  posted: LandedCostPosted | null;
  split: LandedCostSplit[];           // per-PO split of the EFFECTIVE amounts
  match: LandedCostMatch[];           // per-PO Item Receipt match (confirm before posting)
  ir_resolved: boolean;               // every PO has a target IR
  matched: boolean;                   // every PO's IR match is confirmed
  push_enabled: boolean;              // server arm switch (LANDED_COST_NS_PUSH)
  push_allowed: boolean;              // this shipment is on the push allowlist
}

export interface SmsLandedCostResponse {
  rate: LandedCostRate | null;
  rows: SmsLandedCostRow[];
}

// ── Mainline ──────────────────────────────────────────────────────────────────
// Freight/duty are entered on the shipment; split per PO by CI value; matched to
// each PO's Item Receipt. The Landed Cost page is read-only for amounts.
export interface MainlineLandedCostMatch {
  po_number: string;
  receipt_id: string | null;
  netsuite_ir_id: string | null;
  netsuite_ir_tranid: string | null;   // IR document number (e.g. IR65377)
  receipt_date: string | null;
  receipt_qty: number | null;
  method: 'confirmed' | 'auto' | 'unmatched';
  confidence: 'high' | 'medium' | 'low';
  confirmed: boolean;
  ambiguous: boolean;                   // PO has >1 IR and none confirmed
}

// per-PO split for mainline — each PO carries its own posted state (posting is per PO)
export interface MainlineLandedCostSplit {
  po_number: string;
  ci_value: number;
  freight: number;
  duty: number;
  commission: number;   // per-PO commission (0 unless the PO's supplier has a rate)
  posted: { id: string; posted_at: string | null; netsuite_pushed_at?: string | null } | null;
}

export interface MainlineLandedCostRow {
  module: 'mainline';
  shipment_id: string;
  shipment_number: string | null;
  ship_date: string | null;
  ship_month: string | null;
  mode: string | null;
  facility: string | null;
  customs_entry_number: string | null;
  // BASIS (2026-08-24), DERIVED from the carrier — never stored. Shipped with
  // FedEx/DHL, finance gets no separate freight & duty invoice, so the landed cost
  // is ESTIMATED as CI × landed_cost_rates(mainline); with a forwarder it is the
  // ACTUAL typed off those invoices. No carrier → 'actual' (historical rows).
  courier: string | null;
  courier_id: string | null;
  carrier_reference: string | null;
  basis: 'actual' | 'estimate';
  is_estimate: boolean;
  estimate: { freight_pct: number; duty_pct: number; freight: number; duty: number };
  awaiting_actual: boolean;             // forwarder shipment, invoices not in → not postable
  pos: string[];
  has_shipping_data: boolean;
  ci_value: number;
  entered_freight: number | null;       // total on the shipment (null = not entered)
  entered_duty: number | null;
  has_amounts: boolean;
  freight: number;                      // effective total (entered or posted)
  duty: number;
  commission: number;                   // effective commission total (per-supplier %)
  posted_count: number;                 // # of POs posted on this shipment
  all_posted: boolean;
  split: MainlineLandedCostSplit[];     // per-PO split (each carries its own posted state)
  match: MainlineLandedCostMatch[];     // per-PO IR match
  ir_resolved: boolean;
  matched: boolean;
  push_enabled: boolean;
  push_allowed: boolean;
}
