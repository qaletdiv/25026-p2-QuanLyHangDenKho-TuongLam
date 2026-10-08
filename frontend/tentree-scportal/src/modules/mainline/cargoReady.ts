// The three Cargo Ready dates of a mainline PO → booking → shipment, named the
// same on every screen, each with a hover hint saying where it comes from. One
// file so the wording can't drift between pages.
//
//   (PO)        mainline_po_legs.crd            NetSuite custbody46, read-only
//   (revised)   mainline_bookings.cargoReadyDate the vendor's date on the booking
//   (forwarder) mainline_shipments.cargoReadyDate the forwarder's date on the shipment

export const CARGO_READY = {
  po: {
    label: 'Cargo Ready (PO)',
    hint: 'From the PO in NetSuite (CRD). Read-only here — it changes only when NetSuite does.',
  },
  revised: {
    label: 'Cargo Ready (revised)',
    hint: "The booking's date, set by the vendor when booking. Defaults to the latest PO CRD of the booked POs; editable until the booking is approved (then Admin / Logistics only).",
  },
  forwarder: {
    label: 'Cargo Ready (forwarder)',
    hint: "The forwarder's working date for this shipment. Starts as the booking's Cargo Ready (revised) when the booking is approved, then kept current by the forwarder.",
  },
} as const;
