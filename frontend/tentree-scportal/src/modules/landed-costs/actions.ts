'use server';

import { fetchApi } from '@/lib/api';
import { revalidatePath } from 'next/cache';
import type { LandedCostRate, SmsLandedCostResponse } from './types';

const revalidateLandedCosts = () => revalidatePath('/landed-costs', 'layout');

// ─── Rates (editable master data) ────────────────────────────────────────────
export async function getLandedCostRates(): Promise<LandedCostRate[]> {
  const data = await fetchApi('/landed-costs/rates');
  return Array.isArray(data) ? data : [];
}

export async function updateLandedCostRates(rates: LandedCostRate[]) {
  const res = await fetchApi('/landed-costs/rates', { method: 'PUT', body: JSON.stringify(rates) });
  if (res?.error) return { error: res.error as string };
  revalidateLandedCosts();
  return { success: true as const };
}

// ─── SMS landed-cost read model + posting ────────────────────────────────────
export async function getSmsLandedCosts(): Promise<SmsLandedCostResponse> {
  const data = await fetchApi('/landed-costs/sms');
  if (!data || data.error || !Array.isArray(data.rows)) return { rate: null, rows: [] };
  return data;
}

export async function postSmsLandedCost(shipmentId: string) {
  const res = await fetchApi(`/landed-costs/sms/${encodeURIComponent(shipmentId)}/post`, { method: 'POST', body: '{}' });
  if (res?.error) return { error: res.error as string };
  revalidateLandedCosts();
  return res;
}

// Preview the NetSuite Item-Receipt payload(s) — READ ONLY, sends nothing.
export async function previewNetsuiteLandedCost(shipmentId: string) {
  const data = await fetchApi(`/landed-costs/sms/${encodeURIComponent(shipmentId)}/netsuite-preview`);
  if (!data || data.error) return { error: (data && data.error) || 'Preview failed' };
  return data;
}

export async function unpostLandedCost(id: string) {
  const res = await fetchApi(`/landed-costs/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (res?.error) return { error: res.error as string };
  revalidateLandedCosts();
  return { success: true as const };
}

// ─── Item Receipt match (confirm which IR a shipment's landed cost posts to) ──
// Writes sms_item_receipts.matched_shipment_id via the SMS module (SMS owns it).
export async function confirmReceiptMatch(receiptId: string, shipmentId: string) {
  const res = await fetchApi(`/sms/receipts/${encodeURIComponent(receiptId)}/match`, {
    method: 'POST', body: JSON.stringify({ shipment_id: shipmentId }),
  });
  if (res?.error) return { error: res.error as string };
  revalidateLandedCosts();
  return { success: true as const };
}

export async function clearReceiptMatch(receiptId: string) {
  const res = await fetchApi(`/sms/receipts/${encodeURIComponent(receiptId)}/match`, { method: 'DELETE' });
  if (res?.error) return { error: res.error as string };
  revalidateLandedCosts();
  return { success: true as const };
}

// Manually match a PO to an Item Receipt by typing its document number (IR65377)
// when the auto-matcher found none. Backend resolves it (synced row or NetSuite lookup).
export async function manualMatchReceipt(shipmentId: string, poNumber: string, irTranid: string) {
  const res = await fetchApi('/sms/receipts/manual-match', {
    method: 'POST', body: JSON.stringify({ shipment_id: shipmentId, po_number: poNumber, ir_tranid: irTranid }),
  });
  if (res?.error) return { error: res.error as string };
  revalidateLandedCosts();
  return { success: true as const };
}
