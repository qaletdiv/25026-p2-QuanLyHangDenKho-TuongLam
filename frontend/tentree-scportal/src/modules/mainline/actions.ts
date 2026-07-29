'use server';

// Mainline module server actions — wired to the normalized backend endpoints
// (/po, /mainline/*). Mirrors the conventions in src/app/actions/* (fetchApi +
// revalidatePath + Array.isArray guards). SMS has its own module later.

import { fetchApi } from '@/lib/api';
import { revalidatePath } from 'next/cache';
import type {
  PoMasterSummary, PoMasterDetail, PoLegDetail, OrderIntent, PoLegRow,
  MainlineBooking, MainlineShipment, CommercialInvoice, Fulfillment, PoReconcile, PackingSummary, PackingByPo,
  PortOption, ContainerTypeOption, MainlineReportRow, TransitTimesReport,
} from './types';

// ─── Season KPI report (PO-leg-grained, full order book) ─────────────────────
export async function getMainlineReport(): Promise<MainlineReportRow[]> {
  const data = await fetchApi('/reports/mainline');
  return Array.isArray(data) ? data : [];
}

// Actual vs standard transit durations per mode + per-shipment breakdown.
export async function getMainlineTransitTimes(): Promise<TransitTimesReport | null> {
  const data = await fetchApi('/reports/mainline/transit-times');
  return data && !data.error && Array.isArray(data.segments) ? data : null;
}

// ─── Shipment master data (ports / container types) ──────────────────────────
export async function getPorts(): Promise<PortOption[]> {
  const data = await fetchApi('/master-data/ports');
  return Array.isArray(data) ? data : [];
}
export async function getContainerTypes(): Promise<ContainerTypeOption[]> {
  const data = await fetchApi('/master-data/container-types');
  return Array.isArray(data) ? data : [];
}

// ─── Purchase Orders (shared hierarchy) ──────────────────────────────────────
export async function getPoMasters(): Promise<PoMasterSummary[]> {
  const data = await fetchApi('/po');
  return Array.isArray(data) ? data : [];
}

// Flat per-leg (PO-split) list — the familiar PO# / mode / warehouse view.
export async function getPoLegs(): Promise<PoLegRow[]> {
  const data = await fetchApi('/po/legs');
  return Array.isArray(data) ? data : [];
}

// All SKU allocations across every leg — for the PO "item lines" download.
export async function getPoLegLines(): Promise<Record<string, unknown>[]> {
  const data = await fetchApi('/po/leg-lines');
  return Array.isArray(data) ? data : [];
}

export async function getPoMaster(trn: string): Promise<PoMasterDetail | null> {
  const data = await fetchApi(`/po/${encodeURIComponent(trn)}`);
  if (!data || data.error) return null;
  return data;
}

// One PO leg + the SKU line items the vendor must produce for it.
export async function getPoLeg(legId: string): Promise<PoLegDetail | null> {
  const data = await fetchApi(`/po/legs/${encodeURIComponent(legId)}`);
  if (!data || data.error) return null;
  return data;
}

export async function getOrderIntent(trn: string): Promise<OrderIntent | null> {
  const data = await fetchApi(`/po/${encodeURIComponent(trn)}/order-intent`);
  if (!data || data.error) return null;
  return data;
}

export async function syncNetSuite() {
  const result = await fetchApi('/po/sync/netsuite', { method: 'POST' });
  revalidatePath('/mainline/purchase-orders');
  return result;
}

export async function importWip(file: File) {
  const formData = new FormData();
  formData.append('file', file);
  const result = await fetchApi('/mainline/wip-import', { method: 'POST', body: formData });
  revalidatePath('/mainline/purchase-orders');
  return result;
}

// ─── Bookings ────────────────────────────────────────────────────────────────
export async function getMainlineBookings(): Promise<MainlineBooking[]> {
  const data = await fetchApi('/mainline/bookings');
  return Array.isArray(data) ? data : [];
}

export async function getMainlineBooking(id: string): Promise<MainlineBooking | null> {
  const data = await fetchApi(`/mainline/bookings/${id}`);
  if (!data || data.error) return null;
  return data;
}

export async function createMainlineBooking(data: {
  supplier_id: string;
  po_legs: Array<{ leg_id: string; units?: number; cartons?: number; weight_kg?: number; cbm?: number }>;
  incoterm_id?: string;
  cargo_ready_date?: string;
  booking_date?: string;
  force_overbook?: boolean;
}) {
  const result = await fetchApi('/mainline/bookings', { method: 'POST', body: JSON.stringify(data) });
  // 409 overbook warning surfaces as { error: 'Conflict: {...overbook_warning...}' }
  if (result?.error && result.error.includes('overbook_warning')) {
    try { return JSON.parse(result.error.replace(/^Conflict:\s*/, '')); } catch { /* fall through */ }
  }
  revalidatePath('/mainline/bookings');
  return result;
}

export async function updateMainlineBooking(id: string, data: Record<string, unknown>) {
  const result = await fetchApi(`/mainline/bookings/${id}`, { method: 'PUT', body: JSON.stringify(data) });
  revalidatePath('/mainline/bookings');
  return result;
}

export async function approveMainlineBooking(id: string) {
  const result = await fetchApi(`/mainline/bookings/${id}/approve`, { method: 'POST' });
  revalidatePath('/mainline/bookings');
  revalidatePath('/mainline/shipments');
  return result;
}

export async function deleteMainlineBooking(id: string) {
  const result = await fetchApi(`/mainline/bookings/${id}`, { method: 'DELETE' });
  revalidatePath('/mainline/bookings');
  revalidatePath('/mainline/shipments');
  return result;
}

// ─── Shipments ───────────────────────────────────────────────────────────────
export async function getMainlineShipments(): Promise<MainlineShipment[]> {
  const data = await fetchApi('/mainline/shipments');
  return Array.isArray(data) ? data : [];
}

export async function getMainlineShipment(id: string): Promise<MainlineShipment | null> {
  const data = await fetchApi(`/mainline/shipments/${id}`);
  if (!data || data.error) return null;
  return data;
}

export async function updateMainlineShipment(id: string, data: Record<string, unknown>) {
  const result = await fetchApi(`/mainline/shipments/${id}`, { method: 'PUT', body: JSON.stringify(data) });
  revalidatePath('/mainline/shipments');
  return result;
}

export async function bulkUpdateMainlineShipmentStatus(ids: string[], status: string) {
  const result = await fetchApi('/mainline/shipments/bulk-status', { method: 'PUT', body: JSON.stringify({ ids, status }) });
  revalidatePath('/mainline/shipments');
  return result;
}

// ─── CI / packing / fulfillment / ASN ─────────────────────────────────────────
// Single-source upload: shipment-data Excel → CI + packing slip generated.
export async function uploadShipmentData(bookingId: string, file: File) {
  const formData = new FormData();
  formData.append('file', file);
  const result = await fetchApi(`/mainline/bookings/${bookingId}/shipment-data`, { method: 'POST', body: formData });
  revalidatePath('/mainline/bookings');
  return result;
}

export async function getMainlineDocuments(bookingId: string) {
  const data = await fetchApi(`/mainline/bookings/${bookingId}/documents`);
  return Array.isArray(data) ? data : [];
}

export async function getMainlineCi(bookingId: string): Promise<CommercialInvoice | null> {
  const data = await fetchApi(`/mainline/bookings/${bookingId}/ci`);
  if (!data || data.error) return null;
  return data;
}

// CI line items are derived from the packing cartons; the CI is populated by the
// shipment-data upload (uploadShipmentData). There is no manual CI upsert action.

export async function confirmMainlineCi(bookingId: string) {
  const result = await fetchApi(`/mainline/bookings/${bookingId}/ci/confirm`, { method: 'POST' });
  revalidatePath('/mainline/bookings');
  return result;
}

export async function getMainlinePacking(bookingId: string): Promise<{ booking_id: string; cartons: unknown[]; summary: PackingSummary; by_po: PackingByPo[] } | null> {
  const data = await fetchApi(`/mainline/bookings/${bookingId}/packing`);
  if (!data || data.error) return null;
  return data;
}

export async function getMainlineFulfillment(trn: string): Promise<Fulfillment | null> {
  const data = await fetchApi(`/mainline/fulfillment/${encodeURIComponent(trn)}`);
  if (!data || data.error) return null;
  return data;
}

// Component-PO reconcile (ordered/shipped/received/remaining/variance per SKU).
export async function getMainlinePoReconcile(poNumber: string): Promise<PoReconcile | null> {
  const data = await fetchApi(`/mainline/fulfillment/po/${encodeURIComponent(poNumber)}`);
  if (!data || data.error) return null;
  return data;
}

// PO-leg reconcile (one air/sea split): allocated/shipped/received scoped to the leg,
// with NetSuite receipts split across the PO's legs by shipping method.
export async function getMainlineLegReconcile(legId: string): Promise<PoReconcile | null> {
  const data = await fetchApi(`/mainline/fulfillment/leg/${encodeURIComponent(legId)}`);
  if (!data || data.error) return null;
  return data;
}

// ASN is shipment-scoped (arrival notice for a physical shipment).
export async function generateMainlineAsn(shipmentId: string) {
  const result = await fetchApi(`/mainline/shipments/${shipmentId}/asn`, { method: 'POST' });
  revalidatePath('/mainline/shipments');
  return result;
}

export async function getMainlineAsn(shipmentId: string) {
  const data = await fetchApi(`/mainline/shipments/${shipmentId}/asn`);
  if (!data || data.error) return null;
  return data;
}
