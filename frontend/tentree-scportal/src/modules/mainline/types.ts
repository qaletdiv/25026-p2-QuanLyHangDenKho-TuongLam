// Mainline module types — mirror the normalized backend responses (/po, /mainline/*).
// SMS is a separate module; these types carry NO `type` discriminator and no
// courier/tracking fields. See backend/database.dbml + SCHEMA_REDESIGN.md.

// null = v2 (SS27+). The sync builds one leg per PO, so there is no air/sea
// "split" to report — see poController.lifecycleOf. Renders BLANK, not "Split".
export type MainlineLifecycle = 'forecast' | 'split' | 'partial' | null;

// GET /po  (list rows)
export interface PoMasterSummary {
  trnNumber: string;
  supplierId: string | null;
  supplier?: string | null;   // resolved supplier name (detail/getOne)
  season?: string | null;     // resolved season code (detail/getOne)
  seasonId: string | null;
  mainShoulder: string | null;
  netsuiteId: string | null;
  orderCount: number;
  legCount: number;
  totalOrderedQty: number;
  lifecycleState: MainlineLifecycle;
  bookable: boolean;
}

export interface PoOrderLine {
  id: string;
  poNumber: string;
  skuCode: string;
  orderedQty: number;
  unitPrice: number | null;
}

export interface PoLegLine {
  id: string;
  legId: string;
  skuCode: string;
  allocatedQty: number;
}

export interface MainlineLeg {
  id: string;
  poNumber: string;
  modeId: string | null;
  mode?: string | null;
  incotermId: string | null;
  crd: string | null;
  etdPol: string | null;
  eDel: string | null;
  leg_lines?: PoLegLine[];
  expectedQty?: number;
}

export interface PoOrderDetail {
  poNumber: string;
  trnNumber: string | null;
  netsuiteId: string | null;             // NetSuite PO internal id (component grain)
  facilityId: string | null;
  allocationChannelId: string | null;
  destinationFacility: string | null;   // physical facility name (NRI US, …)
  allocationChannel: string | null;      // Reserved / First
  order_lines: PoOrderLine[];
  legs: MainlineLeg[];
  lifecycleState: MainlineLifecycle;
  approvalStatus?: PoApprovalStatus;   // NetSuite sign-off (badge on the TRN detail)
}

// GET /po/legs/:id — one PO leg + the SKU line items the vendor must produce.
export interface PoLegLineItem {
  skuCode: string;
  allocatedQty: number;
  itemName: string | null;
  styleColor: string | null;
  colorway: string | null;
  size: string | null;
  description: string | null;
  unitPrice: number | null;
}
export interface PoReconcile {
  poNumber: string;
  skuCount: number;
  totals: { orderedQty: number; allocatedQty: number; shippedQty: number; receivedQty: number };
  fulfillment: FulfillmentRow[];
}

// GET /mainline/legs/:legId/shipments — the consignments carrying one PO leg.
// Quantities are the SHIPPED actuals from the shipping-data upload (null until it
// is uploaded), not the booked expectedQuantity.
export interface LegShipment {
  shipmentId: string;
  shipmentNumber: string | null;
  lotNumber: number | null;
  carrier_shipment_number: string | null;   // the forwarder's own ref; blank if unset
  crd_actual: string | null;                // per-shipment cargo-ready; ≠ the leg's CRD target
  shippedQty: number | null;
  shippedCartons: number | null;
  // Received against THIS lot, from the shared IR attribution (same resolver as the
  // ATA and the landed-cost push). NULL — not 0 — when no receipt is attributed:
  // "not received yet" and "received nothing" are different answers.
  receivedQty: number | null;
  received_ir: string | null;               // IR document number, e.g. IR65720
  receivedDate: string | null;
  receivedConfirmed: boolean;              // false = the match is only a suggestion
  status: string | null;
}

export interface PoLegDetail {
  id: string;
  poNumber: string;
  netsuiteId: string | null;            // component-PO NetSuite internal id
  trnNumber: string | null;
  supplierId: string | null;
  supplier: string | null;
  season: string | null;
  mainShoulder: string | null;
  modeId: string | null;
  mode: string | null;
  incoterm: string | null;
  destinationFacility: string | null;
  facilityId: string | null;
  allocationChannel: string | null;
  coo: string | null;
  approvalStatus?: PoApprovalStatus;   // NetSuite sign-off (badge on the leg detail)
  crd: string | null;
  hod: string | null;                    // hand-over to the forwarder (custbody8); v2 only
  etdPol: string | null;
  eDel: string | null;
  expectedQty: number;
  skuCount: number;
  line_items: PoLegLineItem[];
}

// GET /po/:trn
export interface PoMasterDetail extends PoMasterSummary {
  orders: PoOrderDetail[];
}

// GET /po/legs — flat per-leg (PO-split) row, enriched with names
export interface PoLegRow {
  id: string;
  poNumber: string;
  trnNumber: string | null;
  supplier: string | null;
  season: string | null;
  mainShoulder: string | null;
  mode: string | null;
  incoterm: string | null;
  receivingWarehouse: string | null;   // physical facility (NRI US, …)
  allocationChannel: string | null;    // Reserved / First
  coo: string | null;                    // country of origin
  crd: string | null;
  hod: string | null;                    // hand-over to the forwarder (custbody8); v2 only
  etdPol: string | null;
  eDel: string | null;
  expectedQty: number;
  skuCount: number;
  lifecycle: MainlineLifecycle;          // 'forecast' = synced, unsplit (v1); null = v2
  approvalStatus: PoApprovalStatus;
  bookable: boolean;
}

/**
 * NetSuite's sign-off state for a PO, straight off `approvalstatus`.
 * `null` = NetSuite has no value (older closed POs) — treated as "no claim", not
 * as pending. 'Rejected' can no longer reach the portal (R4 in the sync refuses it
 * and the prune removes it), but the type admits it so a stale row is displayable
 * rather than silently blank.
 */
export type PoApprovalStatus = 'Pending Approval' | 'Approved' | 'Rejected' | null;

// GET /po/:trn/order-intent
export interface OrderIntent {
  trnNumber: string;
  skuCount: number;
  total_qty: number;
  totals: Array<{ skuCode: string; orderedQty: number }>;
}

// Junction row on a booking (enriched with poNumber + leg mode)
export interface BookingLeg {
  id: string;
  bookingId: string;
  legId: string;
  poNumber: string | null;
  mode: string | null;          // Air / Sea (from the leg)
  units: number | null;
  cartons: number | null;
  weightKg: number | null;
  cbm: number | null;
}

export type MainlineBookingStatus =
  | 'No Booking' | 'Booking Pending' | 'Booking Approved' | 'Cancelled' | 'Rejected';

// GET /mainline/bookings (enriched)
export interface MainlineBooking {
  id: string;
  bookingNumber: string;
  supplierId: string | null;
  supplierName: string | null;
  incotermId: string | null;
  cargoReadyDate: string | null;
  // PLANNED carrier — "book with FedEx/DHL, or book with a freight forwarder".
  // Copied onto the shipment at approve; the SHIPMENT's carrier is the one that
  // drives the landed-cost basis, so this is the plan, not the outcome.
  courierId: string | null;
  courier: string | null;       // joined
  mode: string | null;          // Air / Sea — one per booking (G3); for the forwarder
  season: string | null;        // derived (leg → PO → master); for the season filter
  bookingStatus: MainlineBookingStatus | null;
  bookingStatusId: string | null;
  submittedAt: string | null;
  approvedAt: string | null;
  poLegs: BookingLeg[];
  overbooked?: boolean;
}

// Stored PROGRESS pipeline. "In Transit" renders as "On Air"/"On the Water" by mode.
// The timeliness axis (On Time/At Risk/Late) is derived in reports, not stored here.
export type MainlineShipmentStatus = 'Ready to Ship' | 'In Transit' | 'At Port' | 'Delivered' | 'Received' | 'Cancelled';

// One PO leg carried by a physical shipment (mainline_shipment_legs junction, enriched).
export interface MainlineShipmentLeg {
  legId: string;
  poNumber: string | null;
  netsuiteId: string | null;           // component-PO NetSuite internal id
  trnNumber: string | null;
  modeId: string | null;
  mode: string | null;
  allocationChannel: string | null;   // Reserved / First (internal bucket)
  coo: string | null;                   // country of origin (from the leg's order)
  crd: string | null;                   // cargo ready date (from the leg)
  lotNumber: number | null;
  cartons: number | null;               // booking's per-leg actual carton count
  invoiceValue: number | null;         // Σ totalUsd from the packing list (CI upload)
  expectedQuantity: number;
  supplierName: string | null;
}

// GET /mainline/shipments (enriched). A shipment is ONE physical movement, grained
// on (booking, facility): shared logistics dates/status live here and are edited once;
// the PO legs it carries (incl. multiple allocation channels to the same facility) are
// in `legs`.
export interface MainlineShipment {
  id: string;
  shipmentNumber: string;
  bookingId: string;
  bookingNumber: string | null;
  facilityId: string | null;
  destinationFacility: string | null;   // physical destination (NRI US, NRI CA, …)
  modeId: string | null;
  mode: string | null;                    // grain includes mode (one conveyance)
  season: string | null;                  // derived (leg → PO → master); for the season filter
  supplierName: string | null;
  trnNumber: string | null;
  status: MainlineShipmentStatus | null;
  // shared logistics facts (header-level — edited once for all legs):
  blNo: string | null;                   // ocean bill of lading number
  // ACTUAL carrier for this conveyance. Drives landedCostBasis: a carrier that
  // does not invoice freight & duty separately (FedEx/DHL) makes the landed cost an
  // estimate off the CI value. Null (pre-2026-08-24 rows) reads as 'actual'.
  courierId: string | null;
  courier: string | null;                 // joined
  landedCostBasis: 'actual' | 'estimate';   // DERIVED from the carrier, never stored
  // The carrier's OWN reference for this shipment (was `ceva_shipment_number`, which
  // hardcoded one carrier's name). NOT `shipmentNumber` — that is the portal's SHP-N.
  carrierReference: string | null;       // manually entered
  customsEntryNumber: string | null;    // customs entry # — landed-cost push (custbody_tt_customs_entry_number)
  containerTypeId: string | null;
  containerType: string | null;          // FCL / LCL
  polPortId: string | null;
  polPort: string | null;                // departure port (POL)
  podPortId: string | null;
  podPort: string | null;                // arrival port (POD)
  etdPol: string | null;
  etaPod: string | null;
  eDel: string | null;
  cargoReceivedDate: string | null;     // received at port
  ata: string | null;                     // ACTUAL receipt date; derived from NetSuite Item Receipts, manual fallback
  ataSource: 'netsuite' | 'manual' | null; // where `ata` came from
  expectedAta: string | null;            // derived = eDel + 5 (never stored)
  netsuiteId: string | null;
  invoiceValue: number | null;
  duty: number | null;
  freight: number | null;
  // joined / derived:
  coo: string[];                          // distinct countries of origin across legs
  crd: string | null;                     // earliest cargo-ready across legs
  // contents:
  legs: MainlineShipmentLeg[];
  poNumbers: string[];
  totalExpectedQuantity: number;
}

export interface PortOption { id: string; code?: string; name: string; country?: string; role?: string }
export interface ContainerTypeOption { id: string; name: string }
// Carriers: parcel couriers (FedEx, DHL) AND freight forwarders (Ceva).
// `providesCostInvoices: false` ⇒ no traceable freight & duty invoice, so the
// mainline landed cost is estimated from the commercial-invoice value.
export interface CourierOption { id: string; name: string; providesCostInvoices?: boolean }

// One row of the season KPI report (GET /reports/mainline) — PO-LEG grained, full
// order book. A leg's qty is split across mutually-exclusive rows (shipment rows,
// pending-booking rows, an Awaiting Booking remainder) so totals reconcile.
// Three orthogonal axes: stage (WHERE the qty is — the "why"), timeliness (graded
// on actual or projected E-DEL), and the flattened kpiStatus cascade the tables
// pivot on. WS = Reserved (wholesale), EC = First (ecomm).
export interface MainlineReportRow {
  rowId: string;                         // unique per row (leg × stage × shipment/booking)
  legId: string;
  poNumber: string | null;
  trnNumber: string | null;
  supplier: string | null;
  season: string | null;
  facility: string | null;
  channel: string | null;                 // Reserved / First
  segment: 'WS' | 'EC' | null;
  modeId: string | null;
  mode: string | null;
  crd: string | null;
  qty: number;
  shipmentId: string | null;
  shipmentNumber: string | null;
  bookingId: string | null;
  bookingNumber: string | null;
  stage: string | null;                   // Awaiting Booking / Booking Pending / Ready to Ship … Received
  progressStatus: string | null;         // shipment pipeline state (null pre-shipment)
  dateBasis: 'actual' | 'projected';     // whose E-DEL was graded (shipment vs WIP/transit projection)
  eDel: string | null;                   // best-known E-DEL (graded)
  expectedAta: string | null;            // derived = E-DEL + 5
  ata: string | null;                     // actual receipt date (derived from Item Receipts, else typed)
  ataSource?: 'netsuite' | 'manual' | null;
  timeliness: string;                     // On Time / At Risk / Late / Unknown
  kpiStatus: string;                     // Received / Delivered / On Time / At Risk / Late / Unknown
  reason: string;                         // human-readable grade explanation
}

// GET /reports/mainline/transit-times — actual vs standard segment durations.
export interface TransitSegmentMeta { key: string; label: string }
export interface TransitActualStat { avg: number; min: number; max: number; n: number }
export interface TransitModeRow {
  modeId: string;
  mode: string;
  sampleCount: number;
  standard: Record<string, number>;                     // segment key → standard days
  standardPreDeliveryDays: number | null;            // Σ CRD → E-DEL
  actual: Record<string, TransitActualStat | null>;     // segment key → observed stats
  actualPreDeliveryAvg: number | null;
}
export interface TransitSlippedSegment { segment: string; label: string; actual: number; standard: number; over: number }
export interface TransitShipmentRow {
  shipmentId: string;
  shipmentNumber: string | null;
  bookingNumber: string | null;
  supplierName: string | null;
  coo: string | null;                                   // distinct origin countries, joined
  polPort: string | null;                              // departure port
  modeId: string | null;
  mode: string | null;
  crd: string | null;
  cargoReceivedDate: string | null;
  etdPol: string | null;
  etaPod: string | null;
  eDel: string | null;
  ata: string | null;
  ataSource: 'netsuite' | 'manual' | null;             // attributed Item Receipt vs typed on the header
  durations: Record<string, number | null>;
  totalDays: number | null;                            // end-to-end CRD → ATA
  slipped: TransitSlippedSegment[];
}
// One lane = supplier × country of origin × departure port × mode.
export interface TransitLaneRow {
  supplierName: string | null;
  coo: string | null;
  polPort: string | null;
  modeId: string | null;
  mode: string | null;
  sampleCount: number;
  segments: Record<string, TransitActualStat | null>;   // segment key → observed stats (negatives excluded)
  total: TransitActualStat | null;                      // end-to-end CRD → ATA
  invalidSegments: string[];                           // segments (or 'total') with out-of-order dates
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
  seasonId: string;
  season: string;              // code (FW26) — display enrichment
  ontimeBy: string | null;
  atriskBy: string | null;
}

export interface CiLineItem {
  id: string;
  invoice_id: string;
  skuCode: string;
  matched_leg_id: string | null;
  qty: number;
  weightKg: number | null;
  cbm: number | null;
  match_status: 'matched' | 'unmatched';
}

export interface CommercialInvoice {
  id: string;
  bookingId: string;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  source: string | null;
  status: 'draft' | 'confirmed';
  fileUrl: string | null;     // uploaded source shipment-data Excel
  ci_url?: string | null;      // generated commercial invoice
  pl_url?: string | null;      // generated packing slip
  confirmedAt?: string;
  unmatched_sku_count?: number;
  total_matched_qty?: number;
  total_unmatched_qty?: number;
  line_items: CiLineItem[];
}

// GET /mainline/fulfillment/:trn
export interface FulfillmentRow {
  skuCode: string;
  orderedQty: number;
  allocatedQty: number;
  shippedQty: number;
  receivedQty: number;
  remainingQty: number;
  variance: number;
}
export interface Fulfillment {
  trnNumber: string;
  skuCount: number;
  totals: { orderedQty: number; allocatedQty: number; shippedQty: number; receivedQty: number };
  fulfillment: FulfillmentRow[];
}

// GET /mainline/bookings/:id/documents
export interface MainlineDocument {
  id: string;
  bookingId: string;
  legId: string | null;        // null = combined (all POs)
  docType: 'commercial_invoice' | 'packing_list';
  fileUrl: string;
  invoiceNumber: string;
  generatedAt: string;
  poNumber: string | null;
  scope: string;                // 'Combined (all POs)' | poNumber
}

export interface PackingSummary {
  totalPcs: number;
  totalCartons: number;
  totalValue: number;
  totalNetWeight: number;
  totalGrossWeight: number;
  totalCbm: number;
}

// per-PO actual rollup from the uploaded shipment data
export interface PackingByPo {
  legId: string | null;
  poNumber: string | null;
  totalPcs: number;
  totalCartons: number;
  totalValue: number;
  totalNetWeight: number;
  totalGrossWeight: number;
  totalCbm: number;
}
