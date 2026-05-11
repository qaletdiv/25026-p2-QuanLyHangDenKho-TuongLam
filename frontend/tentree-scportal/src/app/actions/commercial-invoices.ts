'use server';

import { fetchApi } from '@/lib/api';

export interface CILineItem {
  sku_code: string;
  description: string;
  qty: number;
  unit_price: number;
  total: number;
  match_status: 'matched' | 'unmatched' | 'pending';
  matched_po: string | null;
  po_expected_qty: number | null;
  weight_kg: number;
  cbm: number;
}

export interface CIPOSummaryRow {
  po_number: string;
  shipped_qty: number;
  cartons: number;
  weight_kg: number;
  cbm: number;
}

export interface CIParseResult {
  header: {
    invoice_number: string | null;
    invoice_date: string | null;
    total_value: number;
  };
  poSummary: CIPOSummaryRow[];
  lineItems: CILineItem[];
  summary: {
    total_items: number;
    matched: number;
    unmatched: number;
    total_qty: number;
  };
}

/**
 * Upload a CI Excel file to the backend for parsing and SKU auto-matching.
 * Returns the parsed preview — nothing is saved to bookings.json yet.
 *
 * @param file       - The Excel file the vendor selected
 * @param poNumbers  - PO numbers associated with this booking (for SKU matching)
 * @param config     - Optional column-mapping overrides for non-standard templates
 */
export async function parseCIFile(
  file: File,
  poNumbers: string[],
  config?: Record<string, unknown>
): Promise<CIParseResult> {
  const form = new FormData();
  form.append('file', file);
  form.append('po_numbers', JSON.stringify(poNumbers));
  if (config) {
    form.append('config', JSON.stringify(config));
  }

  const result = await fetchApi('/commercial-invoices/parse', {
    method: 'POST',
    body: form,
  });

  if (!result) {
    throw new Error('CI parse failed — no response from server');
  }

  return result as CIParseResult;
}

/**
 * Fetch the confirmed commercial invoice for a booking.
 * Returns null if the booking has no CI (404) or on any network error.
 */
export async function getBookingCommercialInvoice(bookingId: string): Promise<Record<string, unknown> | null> {
  // fetchApi already returns null on non-2xx (including 404) and network errors
  const data = await fetchApi(`/bookings/${bookingId}/commercial-invoice`);
  return (data as Record<string, unknown>) ?? null;
}

export async function confirmCommercialInvoice(bookingId: string) {
  const result = await fetchApi(`/bookings/${bookingId}/commercial-invoice/confirm`, {
    method: 'POST',
  });
  return result;
}
