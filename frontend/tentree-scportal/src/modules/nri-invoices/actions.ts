'use server';

import { fetchApi } from '@/lib/api';
import { revalidatePath } from 'next/cache';
import type {
  Reconcile, LoadedInvoice, InvoiceDetail, ChargeCode, RateCardRow, CostSummary,
} from './types';

const revalidate = () => revalidatePath('/nri-invoices', 'layout');

// ─── Master data: the two validators ─────────────────────────────────────────
export async function getChargeCodes(): Promise<ChargeCode[]> {
  const data = await fetchApi('/nri-invoices/charge-codes');
  return Array.isArray(data) ? data : [];
}

export async function getRateCard(): Promise<RateCardRow[]> {
  const data = await fetchApi('/nri-invoices/rate-card');
  return Array.isArray(data) ? data : [];
}

export async function syncChargeCodes(dryRun = false) {
  const res = await fetchApi('/nri-invoices/charge-codes/sync', {
    method: 'POST', body: JSON.stringify({ dry_run: String(dryRun) }),
  });
  if (res?.error) return { error: res.error as string };
  revalidate();
  return res;
}

// ─── Invoices ────────────────────────────────────────────────────────────────
export async function getInvoices(entity = 'US'): Promise<LoadedInvoice[]> {
  const data = await fetchApi(`/nri-invoices?entity=${encodeURIComponent(entity)}`);
  return Array.isArray(data) ? data : [];
}

export async function getInvoice(id: string): Promise<InvoiceDetail | null> {
  const data = await fetchApi(`/nri-invoices/${encodeURIComponent(id)}`);
  if (!data || data.error) return null;
  return data as InvoiceDetail;
}

export async function getCostSummary(entity = 'US'): Promise<CostSummary | null> {
  const data = await fetchApi(`/nri-invoices/summary?entity=${encodeURIComponent(entity)}`);
  if (!data || data.error) return null;
  return data as CostSummary;
}

/**
 * Reconcile WITHOUT saving. `formData` carries `detail` (the xlsx) and optionally
 * `invoice` (the PDF). Without the PDF there is no invoice number and no control
 * total, so the result comes back `no_summary` — loadable but unproven.
 */
export async function previewInvoice(formData: FormData): Promise<Reconcile | { error: string }> {
  const res = await fetchApi('/nri-invoices/preview', { method: 'POST', body: formData });
  if (!res || res.error) return { error: (res?.error as string) || 'Preview failed.' };
  return res as Reconcile;
}

export async function commitInvoice(formData: FormData) {
  const res = await fetchApi('/nri-invoices', { method: 'POST', body: formData });
  if (res?.error) return { error: res.error as string, message: res.message as string | undefined, tie_out: res.tie_out };
  revalidate();
  return res;
}

/** Record a human coding decision for one line. Keyed on (invoice_no, seq). */
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
