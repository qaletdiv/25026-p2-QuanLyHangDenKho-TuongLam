// SMS module types — mirror the normalized backend responses (/sms/*).
// SMS is a fully separate dataset from mainline (own sms_pos tables); the only
// overlap is shared master data. No booking concept: vendors ship directly via
// courier, one PO ships as 2–3 lots, status comes from courier tracking.

export type SmsFulfillment = 'not_shipped' | 'partially_shipped' | 'fully_shipped' | 'received';

// GET /sms/pos (list row, enriched + derived rollups)
export interface SmsPo {
  poNumber: string;
  trnNumber: string | null;
  supplierId: string | null;
  supplier: string | null;
  seasonId: string | null;
  season: string | null;
  hod: string | null;                  // handover date (the SMS "CRD")
  expectedReceivedDate: string | null;  // NS Due Date — the forecast arrival anchor
  shipMethod: string | null;          // raw NS value (custbody16)
  approvalStatus: string | null;
  facilityId: string | null;
  facility: string | null;
  allocationChannelId: string | null;
  allocationChannel: string | null;   // Reserved / First (null e.g. Direct tentree)
  netsuiteId: string | null;
  orderedQty: number;
  shippedQty: number;
  receivedQty: number;
  remainingQty: number;
  lotCount: number;
  fulfillment: SmsFulfillment;
}

export interface SmsPoLine {
  id: string;
  poNumber: string;
  skuCode: string;
  orderedQty: number;
  unitPrice: number | null;
  itemName: string | null;
  size: string | null;
}

// One consignment carrying (part of) this PO, as listed on the PO detail
export interface SmsConsignmentRef {
  shipmentId: string;
  lotNumber: number;
  units: number;
  cartons: number | null;
  trackingNumber: string | null;
  courierId: string | null;
  shipDate: string | null;
  statusId: string | null;
  status: string | null;
  statusSource: 'courier' | 'manual' | 'netsuite';   // netsuite = Received (Item Receipt)
  receivedDate: string | null;                        // IR date, once received in NetSuite
}

export interface SmsReconciliationSku {
  skuCode: string;
  orderedQty: number;
  shippedQty: number;         // from uploaded shipping data (0 until uploaded)
  receivedQty: number;
  variance: number;
  itemName: string | null;    // SKU master; populated even for shipped-not-ordered SKUs
  unitPrice: number | null;   // PO line price, else shipped carton price, else SKU list
}
export interface SmsReconciliation {
  poNumber: string;
  ordered_total: number;
  shipped_total: number;
  received_total: number;
  hasShippingData: boolean;  // shipped_total/by_sku from packing when true, else declared PO totals
  remaining_to_ship: number;
  shipped_vs_received_variance: number;
  by_sku: SmsReconciliationSku[];
}

export interface SmsPackingSummary {
  totalPcs: number;
  totalCartons: number;
  totalValue: number;
  totalNetWeight: number;
  totalGrossWeight: number;
  totalCbm: number;
}

// GET /sms/shipments/:id/documents — generated CI + packing-list files
export interface SmsDocument {
  id: string;
  shipmentId: string;
  poNumber: string | null;    // null = combined (all POs)
  docType: 'commercial_invoice' | 'packing_list';
  fileUrl: string;
  invoiceNumber: string;
  generatedAt: string;
  scope: string;               // 'Combined (all POs)' | poNumber
}

// GET /sms/pos/:poNumber
export interface SmsPoDetail extends SmsPo {
  lines: SmsPoLine[];
  consignments: SmsConsignmentRef[];
  reconciliation: SmsReconciliation;
}

// Junction row on a shipment (which PO-lots the box carries)
export interface SmsShipmentPo {
  poNumber: string;
  lotNumber: number;
  units: number;
  bookedUnits: number | null;          // derived from the booking junction; null when unbooked
  cartons: number | null;
  trnNumber: string | null;
  supplierId: string | null;
  supplier: string | null;              // derived (supplierId → suppliers.name)
}

// ─── SMS bookings (OPTIONAL authorization step, added 2026-08-07) ─────────────
// Courier consignments reserve no space, so most shipments are still entered
// straight by the vendor with NO booking. A booking gates approval and marks the
// consignment as one that clears customs formally (actual freight/duty on the
// resulting shipment, mainline-style).

// Junction row on a booking (which PO-lots are authorized)
export interface SmsBookingPo {
  id: string;
  bookingId: string;
  poNumber: string;
  lotNumber: number;
  units: number;                        // BOOKED qty
  cartons: number | null;
  weightKg: number | null;
  cbm: number | null;
  supplier: string | null;              // joined
  shippedUnits: number | null;         // derived from the shipment junction (null = not shipped yet)
}

// A consignment produced by approving the booking (draft until it has tracking)
export interface SmsBookingShipmentRef {
  id: string;
  trackingNumber: string | null;
  courierId: string | null;
  modeId: string | null;
  facilityId: string | null;
  shipDate: string | null;
  isDraft: boolean;                    // derived: approved but not yet shipped
}

export interface SmsBooking {
  id: string;
  bookingNumber: string;               // SMS-B-N
  supplierId: string | null;
  supplierName: string | null;         // joined
  incotermId: string | null;
  incoterm: string | null;              // joined
  // Planned carrier + mode, both REQUIRED on a new booking and copied onto the
  // draft consignment at approve. Independent (Ceva runs sea AND air), and the
  // mode is what the landed-cost push sends to NetSuite as the shipping method.
  // Null on bookings made before 2026-08-24, when approve hardcoded FedEx.
  courierId: string | null;
  courier: string | null;               // joined
  modeId: string | null;
  mode: string | null;                  // joined: Sea | Air | Courier
  cargoReadyDate: string | null;      // the SMS CRD (HOD-aligned)
  bookingStatusId: string | null;
  bookingStatus: string | null;        // joined: Booking Pending | Booking Approved | Rejected | Cancelled
  submittedAt: string | null;
  approvedAt: string | null;
  season: string | null;                // derived (PO → season)
  destination: string | null;           // derived (PO → facility); G3 keeps it to one
  pos: SmsBookingPo[];
  totalUnits: number;                  // derived Σ junction
  totalCartons: number;
  totalWeightKg: number;              // derived Σ junction (gross estimate, 2dp)
  shipments: SmsBookingShipmentRef[];
}

export interface SmsTrackingEvent {
  id: string;
  shipmentId: string;
  eventTime: string;
  courierCode: string;
  description: string | null;
  location: string | null;
}

// GET /sms/shipments (one physical consignment = one tracking number)
export interface SmsShipment {
  id: string;
  courierId: string | null;
  courier: string | null;
  // Shipping mode. Normally NULL — a vendor-entered parcel is a courier movement
  // by definition and the NS push falls back to COURIER. Set on a booked
  // consignment (copied from the booking), where the box may be Ceva sea/air.
  modeId: string | null;
  mode: string | null;                 // joined: Sea | Air | Courier
  trackingNumber: string | null;
  shipDate: string | null;
  facilityId: string | null;
  facility: string | null;
  supplier: string | null;             // derived (PO → supplier); normally one
  season: string | null;               // derived (PO → season); for the season filter
  manualStatusId: string | null;
  statusId: string | null;
  // DERIVED: latest courier event, else manual — then Delivered → 'Received' when
  // NetSuite holds an Item Receipt for every PO in the box (statusSource
  // 'netsuite'). Delivered = courier dropped it off; Received = booked into stock.
  status: string | null;
  statusSource: 'courier' | 'manual' | 'netsuite';
  receivedDate: string | null;        // latest attributed IR date, else null
  receivedIrs: string[];              // IR document numbers (e.g. ["IR65377"])
  receivedConfirmed: boolean;         // human-confirmed matches vs auto-suggested
  createdBy: string | null;
  createdAt: string | null;
  // ── booking (optional). bookingId null = vendor-entered, the original flow.
  bookingId: string | null;
  bookingNumber: string | null;       // joined
  isBooked: boolean;                  // DERIVED: !!bookingId
  isDraft: boolean;                   // DERIVED: booked but no tracking number yet
  // ── booked-consignment financials: ACTUALS off the broker bill (no rate).
  //    Null on an unbooked shipment, which uses the derived CI × rate estimate.
  customsEntryNumber: string | null;
  freight: number | null;
  duty: number | null;
  pos: SmsShipmentPo[];
  totalUnits: number;                 // derived Σ junction (declared)
  totalCartons: number;
  hasShippingData: boolean;          // vendor uploaded the packing Excel
  packingSummary: SmsPackingSummary | null;   // derived from shipping data
  trackingEvents: SmsTrackingEvent[];
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
  poNumber: string;
  trnNumber: string | null;
  supplier: string | null;
  season: string | null;
  facility: string | null;             // destination (relabel via facilityLabel)
  channel: string | null;              // Reserved / First / null
  hod: string | null;                  // handover-by date (the SMS time anchor)
  shipMethod: string | null;
  orderedQty: number;
  shippedQty: number;                 // floored at received — see shippedFor (backend)
  shippedRecordedQty?: number;       // the portal's own shipping record, unfloored
  hasShipmentRecord?: boolean;       // false = received in NetSuite, no consignment entered here
  receivedQty: number;
  remainingQty: number;
  // mutually-exclusive UNIT split — WHERE this PO's units are. Sums to orderedQty
  // per PO (both ends capped at ordered), so pivots over these reconcile. Distinct
  // from kpiStatus, which is a PO-level state.
  unitsReceived: number;              // booked in by NetSuite
  unitsInTransit: number;            // shipped, no Item Receipt yet
  unitsOverdue: number;               // not shipped, HOD passed
  unitsToShip: number;               // not shipped, still inside HOD
  lotCount: number;
  earliestShipDate: string | null;
  fulfillment: SmsFulfillment;
  hodTimeliness: 'On Time' | 'Late' | 'On Track' | 'Overdue' | 'Unknown';
  kpiStatus: 'Received' | 'Fully Shipped' | 'Partially Shipped' | 'Overdue' | 'Not Shipped';
}

// ─── SMS incoming-quantity forecast (PO-grained) ─────────────────────────────
// One row per sms_po. incomingQty = ordered − received (units still to arrive);
// the client buckets by ISO week of expectedReceivedDate and by facility.
export interface SmsForecastRow {
  poNumber: string;
  supplier: string | null;
  season: string | null;
  facility: string | null;
  channel: string | null;
  expectedReceivedDate: string | null;   // real NS Due Date (null until synced)
  hod: string | null;                       // handover date — projected fallback
  forecastDate: string | null;            // expectedReceivedDate, else hod
  dateBasis: 'expected' | 'projected' | null;
  orderedQty: number;
  receivedQty: number;
  incomingQty: number;                     // projected units still to arrive
}
