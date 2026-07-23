// Landed Costs module — freight & duty (Phase 1: SMS estimates).
// Everything except the posted snapshot is DERIVED server-side per request.

export interface LandedCostRate {
  id: string;
  module: 'sms' | 'mainline';
  freight_pct: number;
  duty_pct: number;
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
  pos: string[];
  has_shipping_data: boolean;
  ci_value: number;                   // commercial-invoice value (Σ pcs × unit_price)
  estimate: { freight_pct: number; duty_pct: number; freight: number; duty: number };
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
