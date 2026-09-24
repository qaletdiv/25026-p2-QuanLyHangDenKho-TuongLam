'use server';

import { fetchApi } from '@/lib/api';
import { revalidatePath } from 'next/cache';
import type {
  Reconcile, LoadedInvoice, InvoiceDetail, ChargeCode, RateCardRow, CostSummary, InvoiceSource,
} from './types';

const revalidate = () => revalidatePath('/invoices', 'layout');

// ─── Warehouses (the tabs) ───────────────────────────────────────────────────
export async function getInvoiceSources(): Promise<InvoiceSource[]> {
  const data = await fetchApi('/nri-invoices/sources');
  return Array.isArray(data) ? data : [];
}

/** Register another invoicing warehouse. It arrives as a shell — uploads stay off
 *  until its detail-file layout is mapped (the server refuses to accept a parser
 *  flag over HTTP for exactly that reason). */
export async function addInvoiceSource(input: { label: string; code?: string; entity?: string; facilityId?: string | null }) {
  const res = await fetchApi('/nri-invoices/sources', { method: 'POST', body: JSON.stringify(input) });
  if (res?.error) return { error: res.error as string };
  revalidate();
  return res as InvoiceSource;
}

export async function deleteInvoiceSource(code: string) {
  const res = await fetchApi(`/nri-invoices/sources/${encodeURIComponent(code)}`, { method: 'DELETE' });
  if (res?.error) return { error: res.error as string };
  revalidate();
  return res;
}

// ─── Master data: the two validators ─────────────────────────────────────────
export async function getChargeCodes(): Promise<ChargeCode[]> {
  const data = await fetchApi('/nri-invoices/charge-codes');
  return Array.isArray(data) ? data : [];
}

export async function getRateCard(): Promise<RateCardRow[]> {
  const data = await fetchApi('/nri-invoices/rate-card');
  return Array.isArray(data) ? data : [];
}

/**
 * Adopt a coding legend — the basis for every GL on every line.
 *
 * `formData` may carry `legend` (an uploaded .xlsx) and `dryRun`. With no file it
 * falls back to the shared-drive path, which is how it worked before the legend
 * was configurable from the UI. A dry run reports the file's defects (duplicate
 * services, trailing-space keys, blank classes, missing GLs) WITHOUT adopting it.
 */
export async function syncChargeCodes(formData: FormData) {
  const res = await fetchApi('/nri-invoices/charge-codes/sync', { method: 'POST', body: formData });
  if (res?.error) return { error: res.error as string };
  if (formData.get('dryRun') !== 'true') revalidate();
  return res;
}

// ─── Order data: the channel + country source ────────────────────────────────
export async function getOrderData(warehouse = 'nri-us') {
  const data = await fetchApi(`/nri-invoices/order-data?warehouse=${encodeURIComponent(warehouse)}`);
  return (data && !data.error ? data : null) as {
    entity: string; orders: number; storedRows: number;
    covers: { from: string; to: string } | null;
    sources: { label: string; rows?: number; added?: number; error?: string }[];
  } | null;
}

/** Upload the `NRI Order data` sheet or a period CSV. Upserts by order number. */
export async function uploadOrderData(formData: FormData) {
  const res = await fetchApi('/nri-invoices/order-data', { method: 'POST', body: formData });
  if (res?.error) return { error: res.error as string };
  revalidate();
  return res;
}

// ─── Invoices ────────────────────────────────────────────────────────────────
// `warehouse` is the tab's URL code ('nri-us'); the server also still accepts a
// bare entity ('US') for existing callers.
export async function getInvoices(warehouse = 'nri-us'): Promise<LoadedInvoice[]> {
  const data = await fetchApi(`/nri-invoices?warehouse=${encodeURIComponent(warehouse)}`);
  return Array.isArray(data) ? data : [];
}

export async function getInvoice(id: string): Promise<InvoiceDetail | null> {
  const data = await fetchApi(`/nri-invoices/${encodeURIComponent(id)}`);
  if (!data || data.error) return null;
  return data as InvoiceDetail;
}

export async function getCostSummary(warehouse = 'nri-us'): Promise<CostSummary | null> {
  const data = await fetchApi(`/nri-invoices/summary?warehouse=${encodeURIComponent(warehouse)}`);
  if (!data || data.error) return null;
  return data as CostSummary;
}

/**
 * Reconcile WITHOUT saving. `formData` carries `detail` (the xlsx) and optionally
 * `invoice` (the PDF). Without the PDF there is no invoice number and no control
 * total, so the result comes back `noSummary` — loadable but unproven.
 */
export async function previewInvoice(formData: FormData): Promise<Reconcile | { error: string }> {
  const res = await fetchApi('/nri-invoices/preview', { method: 'POST', body: formData });
  if (!res || res.error) return { error: (res?.error as string) || 'Preview failed.' };
  return res as Reconcile;
}

export async function commitInvoice(formData: FormData) {
  const res = await fetchApi('/nri-invoices', { method: 'POST', body: formData });
  if (res?.error) return { error: res.error as string, message: res.message as string | undefined, tieOut: res.tieOut };
  revalidate();
  return res;
}

/** Record a human coding decision for one line. Keyed on (invoiceNo, seq). */
export async function setLineOverride(
  invoiceNo: string, seq: number, patch: { gl?: number | null; class?: string | null; note?: string | null },
) {
  const res = await fetchApi(`/nri-invoices/${encodeURIComponent(invoiceNo)}/lines/${seq}`, {
    method: 'PUT', body: JSON.stringify(patch),
  });
  if (res?.error) return { error: res.error as string };
  revalidate();
  return res;
}

export async function clearLineOverride(invoiceNo: string, seq: number) {
  return setLineOverride(invoiceNo, seq, { gl: null, class: null, note: null });
}

export async function submitInvoice(id: string) {
  const res = await fetchApi(`/nri-invoices/${encodeURIComponent(id)}/submit`, { method: 'POST', body: '{}' });
  if (res?.error) return { error: res.error as string, message: res.message as string | undefined, lines: res.lines };
  revalidate();
  return res;
}

export async function deleteInvoice(id: string) {
  const res = await fetchApi(`/nri-invoices/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (res?.error) return { error: res.error as string };
  revalidate();
  return res;
}
