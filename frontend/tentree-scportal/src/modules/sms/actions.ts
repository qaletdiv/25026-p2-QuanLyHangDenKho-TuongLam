'use server';

// SMS module server actions — wired to the /sms/* backend (own dataset). Same
// conventions as the mainline module: fetchApi + revalidatePath + Array.isArray
// guards. Master-data reads (couriers, facilities) are the only shared surface.

import { fetchApi } from '@/lib/api';
import { revalidatePath } from 'next/cache';
import type { SmsPo, SmsPoDetail, SmsShipment, SmsBooking, SmsDocument, FacilityOption, CourierOption, IncotermOption, ModeOption, SmsReportRow, SmsForecastRow } from './types';

const revalidateSms = () => revalidatePath('/sms', 'layout');

// 409 guard responses (overship) surface via fetchApi as { error: 'Conflict: {json}' } —
// recover the structured payload so the form can show the warning dialog.
function parse409(result: any, marker: string) {
  if (result?.error && String(result.error).includes(marker)) {
    try { return JSON.parse(String(result.error).replace(/^[^{]*/, '')); } catch { /* fall through */ }
  }
  return null;
}

// ─── Season KPI report (PO-grained, full SMS order book) ─────────────────────
export async function getSmsReport(): Promise<SmsReportRow[]> {
  const data = await fetchApi('/reports/sms');
  return Array.isArray(data) ? data : [];
}

// ─── Incoming-quantity forecast (PO-grained; client buckets by week × facility) ─
export async function getSmsForecast(): Promise<SmsForecastRow[]> {
  const data = await fetchApi('/reports/sms/forecast');
  return Array.isArray(data) ? data : [];
}

// ─── Purchase orders (read-only — the SMS NetSuite sync owns writes) ─────────
export async function getSmsPos(): Promise<SmsPo[]> {
  const data = await fetchApi('/sms/pos');
  return Array.isArray(data) ? data : [];
}
export async function getSmsPo(poNumber: string): Promise<SmsPoDetail | null> {
  const data = await fetchApi(`/sms/pos/${encodeURIComponent(poNumber)}`);
  if (!data || data.error) return null;
  return data;
}
// All SKU order lines across every SMS PO — for the "item lines" download.
export async function getSmsPoLines(): Promise<Record<string, unknown>[]> {
  const data = await fetchApi('/sms/po-lines');
  return Array.isArray(data) ? data : [];
}

// ─── The SMS-only NetSuite sync (unrelated to the deactivated mainline one) ──
export async function syncSmsNetsuite() {
  const result = await fetchApi('/sms/sync/netsuite', { method: 'POST', body: '{}' });
  revalidateSms();
  return result;
}

// ─── Bookings (OPTIONAL authorization step) ─────────────────────────────────
// Vendor submits → Logistics approves → approval creates draft shipment(s). Most
// SMS consignments still skip this entirely (vendor enters the shipment directly).
export async function getSmsBookings(): Promise<SmsBooking[]> {
  const data = await fetchApi('/sms/bookings');
  return Array.isArray(data) ? data : [];
}
export async function getSmsBooking(id: string): Promise<SmsBooking | null> {
  const data = await fetchApi(`/sms/bookings/${encodeURIComponent(id)}`);
  if (!data || data.error) return null;
  return data;
}
export async function createSmsBooking(data: {
  supplier_id: string;
  incoterm_id?: string | null;
  // Both REQUIRED by the server: approve copies them onto the draft consignment,
  // and the mode is what reaches NetSuite as the shipping method.
  courier_id: string;
  mode_id: string;
  cargo_ready_date?: string | null;
  pos: Array<{ po_number: string; lot_number?: number | null; units: number; cartons?: number | null; weight_kg?: number | null; cbm?: number | null }>;
  force_overbook?: boolean;
}) {
  const result = await fetchApi('/sms/bookings', { method: 'POST', body: JSON.stringify(data) });
  const overbook = parse409(result, 'overbook_warning');   // soft — the dialog offers to force
  if (overbook) return overbook;
  revalidateSms();
  return result;
}
export async function updateSmsBooking(id: string, data: Record<string, unknown>) {
  const result = await fetchApi(`/sms/bookings/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(data) });
  const overbook = parse409(result, 'overbook_warning');
  if (overbook) return overbook;
  revalidateSms();
  return result;
}
// Approve creates one DRAFT shipment per destination facility (no tracking yet).
export async function approveSmsBooking(id: string) {
  const result = await fetchApi(`/sms/bookings/${encodeURIComponent(id)}/approve`, { method: 'POST', body: '{}' });
  revalidateSms();
  return result;
}
export async function rejectSmsBooking(id: string) {
  const result = await fetchApi(`/sms/bookings/${encodeURIComponent(id)}/reject`, { method: 'POST', body: '{}' });
  revalidateSms();
  return result;
}
// Cancel is the way out of an APPROVED booking: deletes its untracked drafts.
// Blocked (409) once anything under it has actually shipped.
export async function cancelSmsBooking(id: string) {
  const result = await fetchApi(`/sms/bookings/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: '{}' });
  revalidateSms();
  return result;
}
export async function deleteSmsBooking(id: string) {
  const result = await fetchApi(`/sms/bookings/${encodeURIComponent(id)}`, { method: 'DELETE' });
  revalidateSms();
  return result;
}

// ─── Shipments (consignments) — vendor self-service ─────────────────────────
export async function getSmsShipments(): Promise<SmsShipment[]> {
  const data = await fetchApi('/sms/shipments');
  return Array.isArray(data) ? data : [];
}
export async function getSmsShipment(id: string): Promise<SmsShipment | null> {
  const data = await fetchApi(`/sms/shipments/${encodeURIComponent(id)}`);
  if (!data || data.error) return null;
  return data;
}
export async function createSmsShipment(data: {
  courier_id: string;
  tracking_number?: string | null;
  ship_date?: string | null;
  facility_id?: string | null;
  pos: Array<{ po_number: string; units: number; cartons?: number | null }>;
  force_overship?: boolean;
}) {
  const result = await fetchApi('/sms/shipments', { method: 'POST', body: JSON.stringify(data) });
  const overship = parse409(result, 'overship_warning');
  if (overship) return overship;
  revalidateSms();
  return result;
}
export async function updateSmsShipment(id: string, data: Record<string, unknown>) {
  const result = await fetchApi(`/sms/shipments/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(data) });
  const overship = parse409(result, 'overship_warning');
  if (overship) return overship;
  revalidateSms();
  return result;
}
export async function deleteSmsShipment(id: string) {
  const result = await fetchApi(`/sms/shipments/${encodeURIComponent(id)}`, { method: 'DELETE' });
  revalidateSms();
  return result;
}

// Shipping data — vendor uploads one packing Excel per consignment → carton×SKU
// detail + generated CI/packing-list documents (combined + per-PO).
export async function uploadSmsShippingData(shipmentId: string, file: File) {
  const formData = new FormData();
  formData.append('file', file);
  const result = await fetchApi(`/sms/shipments/${encodeURIComponent(shipmentId)}/shipping-data`, { method: 'POST', body: formData });
  revalidateSms();
  return result;
}
export async function getSmsShipmentDocuments(shipmentId: string): Promise<SmsDocument[]> {
  const data = await fetchApi(`/sms/shipments/${encodeURIComponent(shipmentId)}/documents`);
  return Array.isArray(data) ? data : [];
}

// Manual trigger for the FedEx tracking poll (also runs on a 4h cron)
export async function pollSmsTracking() {
  const result = await fetchApi('/sms/tracking/poll', { method: 'POST', body: '{}' });
  revalidateSms();
  return result;
}

// Item receipts flow in from the SMS NetSuite sync and feed the PO detail's
// received/reconciliation figures directly — there is no receiving UI (removed
// 2026-07-03; the sync is the source of truth). A cross-PO short-receipt
// overview belongs in reports/sms later.

// ─── Shared master data (read-only) ──────────────────────────────────────────
export async function getSmsCouriers(): Promise<CourierOption[]> {
  const data = await fetchApi('/master-data/couriers');
  return Array.isArray(data) ? data : [];
}
export async function getSmsFacilities(): Promise<FacilityOption[]> {
  const data = await fetchApi('/master-data/warehouse-facilities');
  return Array.isArray(data) ? data : [];
}
export async function getSmsIncoterms(): Promise<IncotermOption[]> {
  const data = await fetchApi('/master-data/incoterms');
  return Array.isArray(data) ? data : [];
}
// Sea / Air / Courier — the booking's planned mode and the shipment's actual one.
// It is what the landed-cost push maps to the NetSuite shipping method (custbody16).
export async function getSmsModes(): Promise<ModeOption[]> {
  const data = await fetchApi('/master-data/modes');
  return Array.isArray(data) ? data : [];
}
