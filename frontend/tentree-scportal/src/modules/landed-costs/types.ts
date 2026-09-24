// Landed Costs module — freight & duty (Phase 1: SMS estimates).
// Everything except the posted snapshot is DERIVED server-side per request.

export interface LandedCostRate {
  id: string;
  module: 'sms' | 'mainline';
  freightPct: number;
  dutyPct: number;
}

// Per-supplier commission rate (% of CI value, e.g. Pratibha 1.5%). SMS and
// mainline each keep their OWN table — no sharing.
export interface LandedCostCommission {
  id: string;
  supplierId: string;
  commissionPct: number;
}

// The posted snapshot (row in landed_costs). null until a shipment is posted.
export interface LandedCostPosted {
  id: string;
  module: string;
  shipmentId: string;
  invoiceValue: number;
  freightPct: number;
  dutyPct: number;
  freight: number;
  duty: number;
  commission?: number;   // frozen commission total (per-supplier %, e.g. Pratibha)
  postedBy: string | null;
  postedAt: string | null;
  // set when the post was pushed to NetSuite (SMS Post = commit to NetSuite).
  // The pushed IR per PO is derived at read from the matched receipts, not stored.
  netsuitePushedAt?: string | null;
}

// Per-PO Item Receipt match — the target of the landed-cost push.
export interface LandedCostMatch {
  poNumber: string;
  receiptId: string | null;          // sms_item_receipts.id (needed to confirm)
  netsuiteIrId: string | null;      // NetSuite internal id (PATCH push target)
  netsuiteIrTranid: string | null;  // IR document number (e.g. IR65377) — for display/reconcile
  receiptDate: string | null;        // IR date (helps reconcile in NetSuite)
  receiptQty: number | null;         // qty received on that IR
  shippedPcs: number | null;         // qty this shipment shipped for the PO
  method: 'confirmed' | 'quantity' | 'sequence' | 'unmatched';
  confidence: 'high' | 'medium' | 'low';
  confirmed: boolean;                 // human-confirmed (matchedShipmentId set)
}

export interface LandedCostSplit {
  poNumber: string;
  ciValue: number;
  freight: number;
  duty: number;
  commission: number;   // per-PO commission (0 unless the PO's supplier has a rate)
}

// One SMS shipment's landed-cost view (GET /landed-costs/sms → rows[]).
export interface SmsLandedCostRow {
  module: 'sms';
  shipmentId: string;
  trackingNumber: string | null;
  shipDate: string | null;
  shipMonth: string | null;          // YYYY-MM (for month-end grouping)
  supplier: string | null;            // derived (PO → supplier)
  season: string | null;
  facility: string | null;
  courier: string | null;             // joined (FedEx / DHL / Ceva)
  // The shipment's mode, and what the NetSuite push sends as the shipping method
  // (custbody16). NULL on an unbooked parcel, which posts as Courier.
  mode: string | null;
  pos: string[];
  hasShippingData: boolean;
  ciValue: number;                   // commercial-invoice value (Σ pcs × unitPrice)
  // BASIS (2026-08-07). A BOOKED SMS consignment behaves like mainline: freight and
  // duty are ACTUALS off the broker bill, typed on the shipment — no rate. Unbooked
  // (vendor-entered) consignments keep the CI × rate estimate.
  isBooked: boolean;
  bookingId: string | null;
  basis: 'actual' | 'estimate';
  actual: { freight: number | null; duty: number | null } | null;   // null when unbooked
  hasActuals: boolean;
  awaitingActual: boolean;           // booked, bill not entered → not postable
  customsEntryNumber: string | null;
  estimate: { freightPct: number; dutyPct: number; freight: number; duty: number; commission?: number };
  commission: number;                 // effective commission total (posted snapshot or estimate)
  posted: LandedCostPosted | null;
  split: LandedCostSplit[];           // per-PO split of the EFFECTIVE amounts
  match: LandedCostMatch[];           // per-PO Item Receipt match (confirm before posting)
  irResolved: boolean;               // every PO has a target IR
  matched: boolean;                   // every PO's IR match is confirmed
  pushEnabled: boolean;              // server arm switch (LANDED_COST_NS_PUSH)
  pushAllowed: boolean;              // this shipment is on the push allowlist
}

export interface SmsLandedCostResponse {
  rate: LandedCostRate | null;
  rows: SmsLandedCostRow[];
}

// ── Mainline ──────────────────────────────────────────────────────────────────
// Freight/duty are entered on the shipment; split per PO by CI value; matched to
// each PO's Item Receipt. The Landed Cost page is read-only for amounts.
export interface MainlineLandedCostMatch {
  poNumber: string;
  receiptId: string | null;
  netsuiteIrId: string | null;
  netsuiteIrTranid: string | null;   // IR document number (e.g. IR65377)
  receiptDate: string | null;
  receiptQty: number | null;
  method: 'confirmed' | 'auto' | 'unmatched';
  confidence: 'high' | 'medium' | 'low';
  confirmed: boolean;
  ambiguous: boolean;                   // PO has >1 IR and none confirmed
}

// per-PO split for mainline — each PO carries its own posted state (posting is per PO)
export interface MainlineLandedCostSplit {
  poNumber: string;
  ciValue: number;
  freight: number;
  duty: number;
  commission: number;   // per-PO commission (0 unless the PO's supplier has a rate)
  posted: { id: string; postedAt: string | null; netsuitePushedAt?: string | null } | null;
}

export interface MainlineLandedCostRow {
  module: 'mainline';
  shipmentId: string;
  shipmentNumber: string | null;
  shipDate: string | null;
  shipMonth: string | null;
  mode: string | null;
  facility: string | null;
  customsEntryNumber: string | null;
  // BASIS (2026-08-24), DERIVED from the carrier — never stored. Shipped with
  // FedEx/DHL, finance gets no separate freight & duty invoice, so the landed cost
  // is ESTIMATED as CI × landed_cost_rates(mainline); with a forwarder it is the
  // ACTUAL typed off those invoices. No carrier → 'actual' (historical rows).
  courier: string | null;
  courierId: string | null;
  carrierReference: string | null;
  basis: 'actual' | 'estimate';
  isEstimate: boolean;
  estimate: { freightPct: number; dutyPct: number; freight: number; duty: number };
  awaitingActual: boolean;             // forwarder shipment, invoices not in → not postable
  pos: string[];
  hasShippingData: boolean;
  ciValue: number;
  enteredFreight: number | null;       // total on the shipment (null = not entered)
  enteredDuty: number | null;
  hasAmounts: boolean;
  freight: number;                      // effective total (entered or posted)
  duty: number;
  commission: number;                   // effective commission total (per-supplier %)
  postedCount: number;                 // # of POs posted on this shipment
  allPosted: boolean;
  split: MainlineLandedCostSplit[];     // per-PO split (each carries its own posted state)
  match: MainlineLandedCostMatch[];     // per-PO IR match
  irResolved: boolean;
  matched: boolean;
  pushEnabled: boolean;
  pushAllowed: boolean;
}
