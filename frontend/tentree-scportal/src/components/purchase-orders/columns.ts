import type { Order } from '@/types/order';

export interface ColumnDef {
  id: keyof Order;
  label: string;
  /** Right-align numeric columns in the table header and cells */
  align?: 'right';
}

export const COLUMNS: ColumnDef[] = [
  { id: 'season',               label: 'Season' },
  { id: 'trn_number',           label: 'TRN No.' },
  { id: 'type',                 label: 'Type' },
  { id: 'po_number',            label: 'PO#' },
  { id: 'supplier',             label: 'Supplier' },
  { id: 'mode',                 label: 'Mode' },
  { id: 'incoterm',             label: 'Incoterm' },
  { id: 'expected_qty',         label: 'Exp. Qty',        align: 'right' },
  { id: 'received_qty',         label: 'Rcv. Qty',        align: 'right' },
  { id: 'receiving_warehouse',  label: 'Warehouse' },
  { id: 'etd',                  label: 'CRD' },
  { id: 'eta',                  label: 'Exp. Recv Date' },
  { id: 'actual_receive_date',  label: 'Actual Recv Date' },
  { id: 'booking_status',       label: 'Booking Status' },
  { id: 'booking_number',       label: 'Booking #' },
];

export const DEFAULT_VISIBLE_COLUMNS: Array<keyof Order> = [
  'season', 'trn_number', 'type', 'po_number', 'supplier', 'mode', 'incoterm',
  'expected_qty', 'received_qty', 'receiving_warehouse', 'etd', 'eta',
  'actual_receive_date', 'booking_status', 'booking_number',
];
