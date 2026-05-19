export type OrderStatus =
  | 'No Booking'
  | 'Booking'
  | 'Booking Pending'
  | 'Booking Approved'
  | 'Customs Clearance'
  | 'In-Transit'
  | 'ASN Sent'
  | 'Delivered'
  | 'Cancelled'
  | 'Rejected';

export type OrderType = 'mainline' | 'sms';

export interface LineItem {
  id?: string;
  sku_code: string;
  description: string;
  color: string;
  size: string;
  expected_qty: number;
  unit_price?: number;
}

export interface Order {
  id: string;
  po_number: string;
  season: string;
  trn_number: string;
  type: OrderType;
  supplier: string;
  mode: string;
  incoterm: string;
  expected_qty: number;
  /** Computed by backend: sum of received_quantity across linked shipments */
  received_qty: number;
  /** Computed by backend: sum of booked units across active bookings */
  booked_qty: number;
  receiving_warehouse: string;
  /** Cargo Ready Date */
  etd: string;
  /** Expected Receive Date */
  eta: string;
  /** Computed by backend: latest actual_receive_date across linked shipments */
  actual_receive_date: string;
  booking_status: OrderStatus;
  booking_number: string | null;
  line_items: LineItem[];
}
