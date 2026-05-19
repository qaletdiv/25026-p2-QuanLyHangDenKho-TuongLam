export type BookingStatus =
  | 'No Booking' | 'Booking' | 'Booking Pending' | 'Booking Approved'
  | 'Customs Clearance' | 'In-Transit' | 'ASN Sent' | 'Delivered'
  | 'Cancelled' | 'Rejected' | 'Declined' | 'Draft' | 'Ready to Ship';

export interface PODetail {
  po_number: string;
  cartons: string | number;
  units: string | number;
  cbm: string | number;
  weight: string | number;
}

export interface CILineItem {
  sku_code: string;
  description: string;
  qty: number;
  weight_kg: number;
  cbm: number;
  match_status: 'matched' | 'unmatched';
  po_expected_qty: number | null;
}

export interface CommercialInvoice {
  invoice_number?: string;
  invoice_date?: string;
  total_value?: number;
  po_summary?: Array<{ po_number: string; shipped_qty: number; cartons: number; weight_kg: number; cbm: number }>;
  line_items?: CILineItem[];
  status?: 'confirmed' | 'pending';
  confirmed_at?: string;
  file_url?: string;
  unmatched_sku_count?: number;
}

export interface Booking {
  id: string;
  booking_number: string;
  booking_status: BookingStatus;
  vendor_name: string;
  tentree_po_number: string;
  season: string;
  trn_number: string;
  type: 'mainline' | 'sms';
  receiving_warehouse: string;
  number_of_cartons: number;
  cargo_ready_date: string;
  mode: string;
  incoterm: string;
  courier?: string;
  freight_forwarder?: string;
  tracking_number?: string;
  po_details: PODetail[];
  commercial_invoice?: CommercialInvoice;
  submitted_at: string;
  approved_at?: string;
  overbooked?: boolean;
  decline_reason?: string;
  shipment_status?: string;
}
