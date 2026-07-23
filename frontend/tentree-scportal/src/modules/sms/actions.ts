'use server';

// SMS module server actions — wired to the /sms/* backend (own dataset). Same
// conventions as the mainline module: fetchApi + revalidatePath + Array.isArray
// guards. Master-data reads (couriers, facilities) are the only shared surface.

import { fetchApi } from '@/lib/api';
import { revalidatePath } from 'next/cache';
import type { SmsPo, SmsPoDetail, SmsShipment, SmsDocument, FacilityOption, CourierOption, SmsReportRow, SmsForecastRow } from './types';

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
