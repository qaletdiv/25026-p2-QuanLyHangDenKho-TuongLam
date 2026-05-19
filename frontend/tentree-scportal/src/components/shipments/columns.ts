export interface ColumnDef {
  id: string;
  label: string;
  sortable?: boolean;
}

export const ALL_COLUMNS: ColumnDef[] = [
  { id: 'season',               label: 'Season',       sortable: true },
  { id: 'trn_number',           label: 'TRN No.',      sortable: true },
  { id: 'po_number',            label: 'PO',           sortable: true },
  { id: 'lot_number',           label: 'Lot',          sortable: true },
  { id: 'supplier',             label: 'Supplier',     sortable: true },
  { id: 'mode',                 label: 'Mode',         sortable: true },
  { id: 'courier',              label: 'Courier',      sortable: true },
  { id: 'incoterm',             label: 'Incoterm',     sortable: true },
  { id: 'tracking_number',      label: 'Tracking #',   sortable: true },
  { id: 'booked_qty',           label: 'Booked Qty',   sortable: true },
  { id: 'expected_quantity',    label: 'Expected Qty', sortable: true },
  { id: 'destination_warehouse',label: 'Recv WH',      sortable: true },
  { id: 'etd',                  label: 'ETD',          sortable: true },
  { id: 'eta',                  label: 'ETA',          sortable: true },
  { id: 'status',               label: 'Status',       sortable: true },
  { id: 'booking',              label: 'Booking #',    sortable: false },
  { id: 'ci',                   label: 'CI',           sortable: false },
  { id: 'asn',                  label: 'ASN',          sortable: false },
];

export const NON_SORTABLE = new Set(['booking', 'ci', 'asn']);

export const DEFAULT_VISIBLE_COLUMNS = ALL_COLUMNS.map(c => c.id);
