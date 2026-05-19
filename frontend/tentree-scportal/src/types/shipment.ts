export type ShipmentType = 'mainline' | 'sms' | 'SMS';

export type MainlineStatus =
  | 'No Booking'
  | 'Booking'
  | 'Booking Approved'
  | 'Customs Clearance'
  | 'In-Transit'
  | 'Delivered';

export type SmsStatus =
  | 'Ready to Ship'
  | 'Pending'
  | 'In-Transit'
  | 'Customs Issue'
  | 'Delivered';

export interface Shipment {
  id: string;
  po_number: string;
  booking_number?: string;
  booking_status?: string;
  lot_number?: number | null;
  season?: string;
  trn_number?: string;
  type?: ShipmentType;
  supplier?: string;
  mode?: string;
  incoterm?: string;
  courier?: string;
  tracking_number?: string;
  expected_quantity?: string | number;
  received_quantity?: string | number;
  destination_warehouse?: string;
  etd?: string;
  eta?: string;
  actual_receive_date?: string;
  status?: string;
  asn_sent?: boolean;
  asn_file_url?: string;
  commercial_invoice_url?: string;
  invoice_value?: string | number;
  freight?: string | number;
  duty?: string | number;
}
