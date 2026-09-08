// SMS module types — mirror the normalized backend responses (/sms/*).
// SMS is a fully separate dataset from mainline (own sms_pos tables); the only
// overlap is shared master data. No booking concept: vendors ship directly via
// courier, one PO ships as 2–3 lots, status comes from courier tracking.

export type SmsFulfillment = 'not_shipped' | 'partially_shipped' | 'fully_shipped' | 'received';

// GET /sms/pos (list row, enriched + derived rollups)
export interface SmsPo {
  po_number: string;
  trn_number: string | null;
  supplier_id: string | null;
  supplier: string | null;
  season_id: string | null;
  season: string | null;
  hod: string | null;                  // handover date (the SMS "CRD")
  expected_received_date: string | null;  // NS Due Date — the forecast arrival anchor
  ship_method: string | null;          // raw NS value (custbody16)
  approval_status: string | null;
  facility_id: string | null;
  facility: string | null;
  allocation_channel_id: string | null;
  allocation_channel: string | null;   // Reserved / First (null e.g. Direct tentree)
  netsuite_id: string | null;
  ordered_qty: number;
  shipped_qty: number;
  received_qty: number;
  remaining_qty: number;
  lot_count: number;
  fulfillment: SmsFulfillment;
}

export interface SmsPoLine {
  id: string;
  po_number: string;
  sku_code: string;
  ordered_qty: number;
  unit_price: number | null;
  item_name: string | null;
  size: string | null;
}

// One consignment carrying (part of) this PO, as listed on the PO detail
export interface SmsConsignmentRef {
  shipment_id: string;
  lot_number: number;
  units: number;
  cartons: number | null;
  tracking_number: string | null;
  courier_id: string | null;
  ship_date: string | null;
  status_id: string | null;
  status: string | null;
  status_source: 'courier' | 'manual' | 'netsuite';   // netsuite = Received (Item Receipt)
  received_date: string | null;                        // IR date, once received in NetSuite
}

export interface SmsReconciliationSku {
  sku_code: string;
  ordered_qty: number;
  shipped_qty: number;         // from uploaded shipping data (0 until uploaded)
  received_qty: number;
  variance: number;
  item_name: string | null;    // SKU master; populated even for shipped-not-ordered SKUs
  unit_price: number | null;   // PO line price, else shipped carton price, else SKU list
}
export interface SmsReconciliation {
  po_number: string;
  ordered_total: number;
  shipped_total: number;
  received_total: number;
  has_shipping_data: boolean;  // shipped_total/by_sku from packing when true, else declared PO totals
  remaining_to_ship: number;
  shipped_vs_received_variance: number;
  by_sku: SmsReconciliationSku[];
}

export interface SmsPackingSummary {
  total_pcs: number;
  total_cartons: number;
  total_value: number;
  total_net_weight: number;
  total_gross_weight: number;
  total_cbm: number;
}

// GET /sms/shipments/:id/documents — generated CI + packing-list files
export interface SmsDocument {
  id: string;
  shipment_id: string;
  po_number: string | null;    // null = combined (all POs)
  doc_type: 'commercial_invoice' | 'packing_list';
  file_url: string;
  invoice_number: string;
  generated_at: string;
  scope: string;               // 'Combined (all POs)' | po_number
}

// GET /sms/pos/:poNumber
export interface SmsPoDetail extends SmsPo {
  lines: SmsPoLine[];
  consignments: SmsConsignmentRef[];
  reconciliation: SmsReconciliation;
}

// Junction row on a shipment (which PO-lots the box carries)
export interface SmsShipmentPo {
  po_number: string;
  lot_number: number;
  units: number;
  booked_units: number | null;          // derived from the booking junction; null when unbooked
  cartons: number | null;
  trn_number: string | null;
  supplier_id: string | null;
  supplier: string | null;              // derived (supplier_id → suppliers.name)
}

// ─── SMS bookings (OPTIONAL authorization step, added 2026-08-07) ─────────────
// Courier consignments reserve no space, so most shipments are still entered
// straight by the vendor with NO booking. A booking gates approval and marks the
// consignment as one that clears customs formally (actual freight/duty on the
// resulting shipment, mainline-style).

// Junction row on a booking (which PO-lots are authorized)
export interface SmsBookingPo {
  id: string;
  booking_id: string;
  po_number: string;
  lot_number: number;
  units: number;                        // BOOKED qty
  cartons: number | null;
  weight_kg: number | null;
  cbm: number | null;
  supplier: string | null;              // joined
  shipped_units: number | null;         // derived from the shipment junction (null = not shipped yet)
}

// A consignment produced by approving the booking (draft until it has tracking)
export interface SmsBookingShipmentRef {
  id: string;
  tracking_number: string | null;
  courier_id: string | null;
  mode_id: string | null;
  facility_id: string | null;
  ship_date: string | null;
  is_draft: boolean;                    // derived: approved but not yet shipped
}

export interface SmsBooking {
  id: string;
  booking_number: string;               // SMS-B-N
  supplier_id: string | null;
  supplier_name: string | null;         // joined
  incoterm_id: string | null;
  incoterm: string | null;              // joined
  // Planned carrier + mode, both REQUIRED on a new booking and copied onto the
  // draft consignment at approve. Independent (Ceva runs sea AND air), and the
  // mode is what the landed-cost push sends to NetSuite as the shipping method.
  // Null on bookings made before 2026-08-24, when approve hardcoded FedEx.
  courier_id: string | null;
  courier: string | null;               // joined
  mode_id: string | null;
  mode: string | null;                  // joined: Sea | Air | Courier
  cargo_ready_date: string | null;      // the SMS CRD (HOD-aligned)
  booking_status_id: string | null;
  booking_status: string | null;        // joined: Booking Pending | Booking Approved | Rejected | Cancelled
  submitted_at: string | null;
  approved_at: string | null;
  season: string | null;                // derived (PO → season)
  destination: string | null;           // derived (PO → facility); G3 keeps it to one
  pos: SmsBookingPo[];
  total_units: number;                  // derived Σ junction
  total_cartons: number;
  total_weight_kg: number;              // derived Σ junction (gross estimate, 2dp)
  shipments: SmsBookingShipmentRef[];
}

export interface SmsTrackingEvent {
  id: string;
  shipment_id: string;
  event_time: string;
  courier_code: string;
  description: string | null;
  location: string | null;
}

// GET /sms/shipments (one physical consignment = one tracking number)
export interface SmsShipment {
  id: string;
  courier_id: string | null;
  courier: string | null;
  // Shipping mode. Normally NULL — a vendor-entered parcel is a courier movement
  // by definition and the NS push falls back to COURIER. Set on a booked
  // consignment (copied from the booking), where the box may be Ceva sea/air.
  mode_id: string | null;
  mode: string | null;                 // joined: Sea | Air | Courier
  tracking_number: string | null;
  ship_date: string | null;
  facility_id: string | null;
  facility: string | null;
  supplier: string | null;             // derived (PO → supplier); normally one
  season: string | null;               // derived (PO → season); for the season filter
  manual_status_id: string | null;
  status_id: string | null;
  // DERIVED: latest courier event, else manual — then Delivered → 'Received' when
  // NetSuite holds an Item Receipt for every PO in the box (status_source
  // 'netsuite'). Delivered = courier dropped it off; Received = booked into stock.
  status: string | null;
  status_source: 'courier' | 'manual' | 'netsuite';
  received_date: string | null;        // latest attributed IR date, else null
  received_irs: string[];              // IR document numbers (e.g. ["IR65377"])
  received_confirmed: boolean;         // human-confirmed matches vs auto-suggested
  created_by: string | null;
  created_at: string | null;
  // ── booking (optional). booking_id null = vendor-entered, the original flow.
  booking_id: string | null;
  booking_number: string | null;       // joined
  is_booked: boolean;                  // DERIVED: !!booking_id
  is_draft: boolean;                   // DERIVED: booked but no tracking number yet
  // ── booked-consignment financials: ACTUALS off the broker bill (no rate).
  //    Null on an unbooked shipment, which uses the derived CI × rate estimate.
  customs_entry_number: string | null;
  freight: number | null;
  duty: number | null;
  pos: SmsShipmentPo[];
  total_units: number;                 // derived Σ junction (declared)
  total_cartons: number;
  has_shipping_data: boolean;          // vendor uploaded the packing Excel
  packing_summary: SmsPackingSummary | null;   // derived from shipping data
  tracking_events: SmsTrackingEvent[];
}

// NOTE: Item Receipts (sms_item_receipts) are synced from NetSuite and feed the
// PO detail's received/reconciliation figures server-side (SmsReconciliation
// above). There is no receiving UI — the receipt/confirmation types were removed
// with the receiving page (2026-07-03).

export interface FacilityOption { id: string; name: string }
export interface CourierOption { id: string; name: string }
export interface IncotermOption { id: string; name: string }
export interface ModeOption { id: string; name: string }      // Sea / Air / Courier

// ─── SMS season KPI report (PO-grained, full SMS order book) ─────────────────
// One row per sms_po. All figures derived server-side; the client filters by
// season and builds the funnel / donuts / pivots.
export interface SmsReportRow {
  po_number: string;
  trn_number: string | null;
  supplier: string | null;
  season: string | null;
  facility: string | null;             // destination (relabel via facilityLabel)
  channel: string | null;              // Reserved / First / null
  hod: string | null;                  // handover-by date (the SMS time anchor)
  ship_method: string | null;
  ordered_qty: number;
  shipped_qty: number;                 // floored at received — see shippedFor (backend)
  shipped_recorded_qty?: number;       // the portal's own shipping record, unfloored
  has_shipment_record?: boolean;       // false = received in NetSuite, no consignment entered here
  received_qty: number;
  remaining_qty: number;
  // mutually-exclusive UNIT split — WHERE this PO's units are. Sums to ordered_qty
  // per PO (both ends capped at ordered), so pivots over these reconcile. Distinct
  // from kpi_status, which is a PO-level state.
  units_received: number;              // booked in by NetSuite
  units_in_transit: number;            // shipped, no Item Receipt yet
  units_overdue: number;               // not shipped, HOD passed
  units_to_ship: number;               // not shipped, still inside HOD
  lot_count: number;
  earliest_ship_date: string | null;
  fulfillment: SmsFulfillment;
  hod_timeliness: 'On Time' | 'Late' | 'On Track' | 'Overdue' | 'Unknown';
  kpi_status: 'Received' | 'Fully Shipped' | 'Partially Shipped' | 'Overdue' | 'Not Shipped';
}

// ─── SMS incoming-quantity forecast (PO-grained) ─────────────────────────────
// One row per sms_po. incoming_qty = ordered − received (units still to arrive);
// the client buckets by ISO week of expected_received_date and by facility.
export interface SmsForecastRow {
  po_number: string;
  supplier: string | null;
  season: string | null;
  facility: string | null;
  channel: string | null;
  expected_received_date: string | null;   // real NS Due Date (null until synced)
  hod: string | null;                       // handover date — projected fallback
  forecast_date: string | null;            // expected_received_date, else hod
  date_basis: 'expected' | 'projected' | null;
  ordered_qty: number;
  received_qty: number;
  incoming_qty: number;                     // projected units still to arrive
}
