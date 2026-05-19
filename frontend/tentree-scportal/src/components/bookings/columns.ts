import type { Booking } from '@/types/booking';

export interface ColumnDef {
  id: keyof Booking | 'commercial_invoice';
  label: string;
  align?: 'right';
}

export const COLUMNS: ColumnDef[] = [
  { id: 'booking_number', label: 'Booking #' },
  { id: 'vendor_name', label: 'Vendor' },
  { id: 'season', label: 'Season' },
  { id: 'trn_number', label: 'TRN #' },
  { id: 'type', label: 'Type' },
  { id: 'tentree_po_number', label: 'PO Number' },
  { id: 'mode', label: 'Mode' },
  { id: 'incoterm', label: 'Incoterm' },
  { id: 'receiving_warehouse', label: 'Warehouse' },
  { id: 'number_of_cartons', label: 'Cartons', align: 'right' },
  { id: 'cargo_ready_date', label: 'Cargo Ready' },
  { id: 'freight_forwarder', label: 'Forwarder' },
  { id: 'booking_status', label: 'Status' },
  { id: 'commercial_invoice', label: 'CI File' },
  { id: 'submitted_at', label: 'Submitted' },
];

export const DEFAULT_VISIBLE_COLUMNS = COLUMNS.map(c => c.id);
