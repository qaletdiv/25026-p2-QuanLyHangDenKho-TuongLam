// Mainline module types — mirror the normalized backend responses (/po, /mainline/*).
// SMS is a separate module; these types carry NO `type` discriminator and no
// courier/tracking fields. See backend/database.dbml + SCHEMA_REDESIGN.md.

export type MainlineLifecycle = 'forecast' | 'split' | 'partial';

// GET /po  (list rows)
export interface PoMasterSummary {
  trn_number: string;
  supplier_id: string | null;
  supplier?: string | null;   // resolved supplier name (detail/getOne)
  season?: string | null;     // resolved season code (detail/getOne)
  season_id: string | null;
  main_shoulder: string | null;
  netsuite_id: string | null;
  order_count: number;
  leg_count: number;
  total_ordered_qty: number;
  lifecycle_state: MainlineLifecycle;
  bookable: boolean;
}

export interface PoOrderLine {
  id: string;
  po_number: string;
  sku_code: string;
  ordered_qty: number;
  unit_price: number | null;
}

export interface PoLegLine {
  id: string;
  leg_id: string;
  sku_code: string;
  allocated_qty: number;
}

export interface MainlineLeg {
  id: string;
  po_number: string;
  mode_id: string | null;
  mode?: string | null;
  incoterm_id: string | null;
  crd: string | null;
  etd_pol: string | null;
  e_del: string | null;
  leg_lines?: PoLegLine[];
  expected_qty?: number;
}

export interface PoOrderDetail {
  po_number: string;
  trn_number: string | null;
  netsuite_id: string | null;             // NetSuite PO internal id (component grain)
  facility_id: string | null;
  allocation_channel_id: string | null;
  destination_facility: string | null;   // physical facility name (NRI US, …)
  allocation_channel: string | null;      // Reserved / First
  order_lines: PoOrderLine[];
  legs: MainlineLeg[];
  lifecycle_state: 'forecast' | 'split';
}

// GET /po/legs/:id — one PO leg + the SKU line items the vendor must produce.
export interface PoLegLineItem {
  sku_code: string;
  allocated_qty: number;
  item_name: string | null;
  style_color: string | null;
  colorway: string | null;
  size: string | null;
  description: string | null;
  unit_price: number | null;
}
export interface PoReconcile {
  po_number: string;
  sku_count: number;
  totals: { ordered_qty: number; allocated_qty: number; shipped_qty: number; received_qty: number };
  fulfillment: FulfillmentRow[];
}

// GET /mainline/legs/:legId/shipments — the consignments carrying one PO leg.
// Quantities are the SHIPPED actuals from the shipping-data upload (null until it
// is uploaded), not the booked expected_quantity.
export interface LegShipment {
  shipment_id: string;
  shipment_number: string | null;
  lot_number: number | null;
  carrier_shipment_number: string | null;   // the forwarder's own ref; blank if unset
  crd_actual: string | null;                // per-shipment cargo-ready; ≠ the leg's CRD target
  shipped_qty: number | null;
  shipped_cartons: number | null;
  status: string | null;
}

export interface PoLegDetail {
  id: string;
  po_number: string;
  netsuite_id: string | null;            // component-PO NetSuite internal id
  trn_number: string | null;
  supplier_id: string | null;
  supplier: string | null;
  season: string | null;
  main_shoulder: string | null;
  mode_id: string | null;
  mode: string | null;
  incoterm: string | null;
  destination_facility: string | null;
  facility_id: string | null;
  allocation_channel: string | null;
  coo: string | null;
  crd: string | null;
  etd_pol: string | null;
  e_del: string | null;
  expected_qty: number;
  sku_count: number;
  line_items: PoLegLineItem[];
}

// GET /po/:trn
export interface PoMasterDetail extends PoMasterSummary {
  orders: PoOrderDetail[];
}

// GET /po/legs — flat per-leg (PO-split) row, enriched with names
export interface PoLegRow {
  id: string;
  po_number: string;
  trn_number: string | null;
  supplier: string | null;
  season: string | null;
  main_shoulder: string | null;
  mode: string | null;
  incoterm: string | null;
  receiving_warehouse: string | null;   // physical facility (NRI US, …)
  allocation_channel: string | null;    // Reserved / First
  coo: string | null;                    // country of origin
  crd: string | null;
  etd_pol: string | null;
  e_del: string | null;
  expected_qty: number;
  sku_count: number;
  lifecycle: 'split' | 'forecast';       // 'forecast' = synced PO, not yet air/sea split
  bookable: boolean;
}

// GET /po/:trn/order-intent
export interface OrderIntent {
  trn_number: string;
  sku_count: number;
  total_qty: number;
  totals: Array<{ sku_code: string; ordered_qty: number }>;
}

// Junction row on a booking (enriched with po_number + leg mode)
export interface BookingLeg {
  id: string;
  booking_id: string;
  leg_id: string;
  po_number: string | null;
  mode: string | null;          // Air / Sea (from the leg)
  units: number | null;
  cartons: number | null;
  weight_kg: number | null;
  cbm: number | null;
}

export type MainlineBookingStatus =
  | 'No Booking' | 'Booking Pending' | 'Booking Approved' | 'Cancelled' | 'Rejected';

// GET /mainline/bookings (enriched)
export interface MainlineBooking {
  id: string;
  booking_number: string;
  supplier_id: string | null;
  supplier_name: string | null;
  incoterm_id: string | null;
  cargo_ready_date: string | null;
  // PLANNED carrier — "book with FedEx/DHL, or book with a freight forwarder".
  // Copied onto the shipment at approve; the SHIPMENT's carrier is the one that
  // drives the landed-cost basis, so this is the plan, not the outcome.
  courier_id: string | null;
  courier: string | null;       // joined
  mode: string | null;          // Air / Sea — one per booking (G3); for the forwarder
  season: string | null;        // derived (leg → PO → master); for the season filter
  booking_status: MainlineBookingStatus | null;
  booking_status_id: string | null;
  submitted_at: string | null;
  approved_at: string | null;
  po_legs: BookingLeg[];
  overbooked?: boolean;
}

// Stored PROGRESS pipeline. "In Transit" renders as "On Air"/"On the Water" by mode.
// The timeliness axis (On Time/At Risk/Late) is derived in reports, not stored here.
export type MainlineShipmentStatus = 'Ready to Ship' | 'In Transit' | 'At Port' | 'Delivered' | 'Received' | 'Cancelled';

// One PO leg carried by a physical shipment (mainline_shipment_legs junction, enriched).
export interface MainlineShipmentLeg {
  leg_id: string;
  po_number: string | null;
  netsuite_id: string | null;           // component-PO NetSuite internal id
  trn_number: string | null;
  mode_id: string | null;
  mode: string | null;
  allocation_channel: string | null;   // Reserved / First (internal bucket)
  coo: string | null;                   // country of origin (from the leg's order)
  crd: string | null;                   // cargo ready date (from the leg)
  lot_number: number | null;
  cartons: number | null;               // booking's per-leg actual carton count
  invoice_value: number | null;         // Σ total_usd from the packing list (CI upload)
  expected_quantity: number;
  supplier_name: string | null;
}

// GET /mainline/shipments (enriched). A shipment is ONE physical movement, grained
// on (booking, facility): shared logistics dates/status live here and are edited once;
// the PO legs it carries (incl. multiple allocation channels to the same facility) are
// in `legs`.
export interface MainlineShipment {
  id: string;
  shipment_number: string;
  booking_id: string;
  booking_number: string | null;
  facility_id: string | null;
  destination_facility: string | null;   // physical destination (NRI US, NRI CA, …)
  mode_id: string | null;
  mode: string | null;                    // grain includes mode (one conveyance)
  season: string | null;                  // derived (leg → PO → master); for the season filter
  supplier_name: string | null;
  trn_number: string | null;
  status: MainlineShipmentStatus | null;
  // shared logistics facts (header-level — edited once for all legs):
  bl_no: string | null;                   // ocean bill of lading number
  // ACTUAL carrier for this conveyance. Drives landed_cost_basis: a carrier that
  // does not invoice freight & duty separately (FedEx/DHL) makes the landed cost an
  // estimate off the CI value. Null (pre-2026-08-24 rows) reads as 'actual'.
  courier_id: string | null;
  courier: string | null;                 // joined
  landed_cost_basis: 'actual' | 'estimate';   // DERIVED from the carrier, never stored
  // The carrier's OWN reference for this shipment (was `ceva_shipment_number`, which
  // hardcoded one carrier's name). NOT `shipment_number` — that is the portal's SHP-N.
  carrier_reference: string | null;       // manually entered
  customs_entry_number: string | null;    // customs entry # — landed-cost push (custbody_tt_customs_entry_number)
  container_type_id: string | null;
  container_type: string | null;          // FCL / LCL
  pol_port_id: string | null;
  pol_port: string | null;                // departure port (POL)
  pod_port_id: string | null;
  pod_port: string | null;                // arrival port (POD)
  etd_pol: string | null;
  eta_pod: string | null;
  e_del: string | null;
  cargo_received_date: string | null;     // received at port
  ata: string | null;                     // ACTUAL receipt date; derived from NetSuite Item Receipts, manual fallback
  ata_source: 'netsuite' | 'manual' | null; // where `ata` came from
  expected_ata: string | null;            // derived = e_del + 5 (never stored)
  netsuite_id: string | null;
  invoice_value: number | null;
  duty: number | null;
  freight: number | null;
  // joined / derived:
  coo: string[];                          // distinct countries of origin across legs
  crd: string | null;                     // earliest cargo-ready across legs
  // contents:
  legs: MainlineShipmentLeg[];
  po_numbers: string[];
  total_expected_quantity: number;
}

export interface PortOption { id: string; code?: string; name: string; country?: string; role?: string }
export interface ContainerTypeOption { id: string; name: string }
// Carriers: parcel couriers (FedEx, DHL) AND freight forwarders (Ceva).
// `provides_cost_invoices: false` ⇒ no traceable freight & duty invoice, so the
// mainline landed cost is estimated from the commercial-invoice value.
export interface CourierOption { id: string; name: string; provides_cost_invoices?: boolean }

// One row of the season KPI report (GET /reports/mainline) — PO-LEG grained, full
// order book. A leg's qty is split across mutually-exclusive rows (shipment rows,
// pending-booking rows, an Awaiting Booking remainder) so totals reconcile.
// Three orthogonal axes: stage (WHERE the qty is — the "why"), timeliness (graded
// on actual or projected E-DEL), and the flattened kpi_status cascade the tables
// pivot on. WS = Reserved (wholesale), EC = First (ecomm).
export interface MainlineReportRow {
  row_id: string;                         // unique per row (leg × stage × shipment/booking)
  leg_id: string;
  po_number: string | null;
  trn_number: string | null;
  supplier: string | null;
  season: string | null;
  facility: string | null;
  channel: string | null;                 // Reserved / First
  segment: 'WS' | 'EC' | null;
  mode_id: string | null;
  mode: string | null;
  crd: string | null;
  qty: number;
  shipment_id: string | null;
  shipment_number: string | null;
  booking_id: string | null;
  booking_number: string | null;
  stage: string | null;                   // Awaiting Booking / Booking Pending / Ready to Ship … Received
  progress_status: string | null;         // shipment pipeline state (null pre-shipment)
  date_basis: 'actual' | 'projected';     // whose E-DEL was graded (shipment vs WIP/transit projection)
  e_del: string | null;                   // best-known E-DEL (graded)
  expected_ata: string | null;            // derived = E-DEL + 5
  ata: string | null;                     // actual receipt date (derived from Item Receipts, else typed)
  ata_source?: 'netsuite' | 'manual' | null;
  timeliness: string;                     // On Time / At Risk / Late / Unknown
  kpi_status: string;                     // Received / Delivered / On Time / At Risk / Late / Unknown
  reason: string;                         // human-readable grade explanation
}

// GET /reports/mainline/transit-times — actual vs standard segment durations.
export interface TransitSegmentMeta { key: string; label: string }
export interface TransitActualStat { avg: number; min: number; max: number; n: number }
export interface TransitModeRow {
  mode_id: string;
  mode: string;
  sample_count: number;
  standard: Record<string, number>;                     // segment key → standard days
  standard_pre_delivery_days: number | null;            // Σ CRD → E-DEL
  actual: Record<string, TransitActualStat | null>;     // segment key → observed stats
  actual_pre_delivery_avg: number | null;
}
export interface TransitSlippedSegment { segment: string; label: string; actual: number; standard: number; over: number }
export interface TransitShipmentRow {
  shipment_id: string;
  shipment_number: string | null;
  booking_number: string | null;
  supplier_name: string | null;
  coo: string | null;                                   // distinct origin countries, joined
  pol_port: string | null;                              // departure port
  mode_id: string | null;
  mode: string | null;
  crd: string | null;
  cargo_received_date: string | null;
  etd_pol: string | null;
  eta_pod: string | null;
  e_del: string | null;
  ata: string | null;
  ata_source: 'netsuite' | 'manual' | null;             // attributed Item Receipt vs typed on the header
  durations: Record<string, number | null>;
  total_days: number | null;                            // end-to-end CRD → ATA
  slipped: TransitSlippedSegment[];
}
// One lane = supplier × country of origin × departure port × mode.
export interface TransitLaneRow {
  supplier_name: string | null;
  coo: string | null;
  pol_port: string | null;
  mode_id: string | null;
  mode: string | null;
  sample_count: number;
  segments: Record<string, TransitActualStat | null>;   // segment key → observed stats (negatives excluded)
  total: TransitActualStat | null;                      // end-to-end CRD → ATA
  invalid_segments: string[];                           // segments (or 'total') with out-of-order dates
  standard: Record<string, number>;                     // segment key → standard days (by mode)
}
export interface TransitTimesReport {
  segments: TransitSegmentMeta[];
  lanes: TransitLaneRow[];
  modes: TransitModeRow[];
  shipments: TransitShipmentRow[];
}

// GET /master-data/production-schedules — per-season KPI gates (one row per
// season; editable in /settings/production-schedules).
export interface ProductionScheduleRow {
  season_id: string;
  season: string;              // code (FW26) — display enrichment
  ontime_by: string | null;
  atrisk_by: string | null;
}

export interface CiLineItem {
  id: string;
  invoice_id: string;
  sku_code: string;
  matched_leg_id: string | null;
  qty: number;
  weight_kg: number | null;
  cbm: number | null;
  match_status: 'matched' | 'unmatched';
}

export interface CommercialInvoice {
  id: string;
  booking_id: string;
  invoice_number: string | null;
  invoice_date: string | null;
  source: string | null;
  status: 'draft' | 'confirmed';
  file_url: string | null;     // uploaded source shipment-data Excel
  ci_url?: string | null;      // generated commercial invoice
  pl_url?: string | null;      // generated packing slip
  confirmed_at?: string;
  unmatched_sku_count?: number;
  total_matched_qty?: number;
  total_unmatched_qty?: number;
  line_items: CiLineItem[];
}

// GET /mainline/fulfillment/:trn
export interface FulfillmentRow {
  sku_code: string;
  ordered_qty: number;
  allocated_qty: number;
  shipped_qty: number;
  received_qty: number;
  remaining_qty: number;
  variance: number;
}
export interface Fulfillment {
  trn_number: string;
  sku_count: number;
  totals: { ordered_qty: number; allocated_qty: number; shipped_qty: number; received_qty: number };
  fulfillment: FulfillmentRow[];
}

// GET /mainline/bookings/:id/documents
export interface MainlineDocument {
  id: string;
  booking_id: string;
  leg_id: string | null;        // null = combined (all POs)
  doc_type: 'commercial_invoice' | 'packing_list';
  file_url: string;
  invoice_number: string;
  generated_at: string;
  po_number: string | null;
  scope: string;                // 'Combined (all POs)' | po_number
}

export interface PackingSummary {
  total_pcs: number;
  total_cartons: number;
  total_value: number;
  total_net_weight: number;
  total_gross_weight: number;
  total_cbm: number;
}

// per-PO actual rollup from the uploaded shipment data
export interface PackingByPo {
  leg_id: string | null;
  po_number: string | null;
  total_pcs: number;
  total_cartons: number;
  total_value: number;
  total_net_weight: number;
  total_gross_weight: number;
  total_cbm: number;
}
