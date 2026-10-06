'use server';

import { fetchApi } from '@/lib/api';
import { revalidatePath } from 'next/cache';
import type {
  Entity, RateCard, BillingFile, Results, LinePage, LineFilter, Scope, UploadResult, RulesPayload, ClassRule,
  OrderDataStatus, OrderSyncResult, GlCodesPayload, RuleKind, FileReview,
} from './types';

const revalidate = () => revalidatePath('/invoices', 'layout');

/**
 * fetchApi flattens a non-2xx into `{ error: "<statusText>: <body text>", status }`.
 * This module's 409s carry a meaningful JSON body (`error: 'locked' | 'duplicate'`,
 * a message, and for a duplicate the full preview), so decode it back. Returns
 * null for a success.
 */
type ApiBody = Record<string, unknown> & { error?: string; message?: string };
function apiError(res: unknown): ApiBody | null {
  if (!res || typeof res !== 'object') return { error: 'No response from the server.' };
  const r = res as ApiBody & { status?: number };
  if (!r.error) return null;
  if (r.status) {
    const text = String(r.error).replace(/^[^:{]*:\s*/, '');
    try { return JSON.parse(text) as ApiBody; } catch { return { error: text || String(r.error) }; }
  }
  return r;
}
const messageOf = (e: ApiBody) => (e.message as string) || (e.error as string) || 'Request failed.';

const scopeQuery = (s: Scope) => {
  const p = new URLSearchParams({ entity: s.entity });
  if (s.files) p.set('files', s.files);
  else if (s.month) p.set('month', s.month);
  return p;
};

// ─── Rate cards ──────────────────────────────────────────────────────────────
export async function getRateCards(): Promise<Record<Entity, RateCard> | null> {
  const data = await fetchApi('/nri-billing/rate-cards');
  return data && !data.error ? data : null;
}

/** Upload a rate-card workbook. It REPLACES that warehouse's card. */
export async function uploadRateCard(formData: FormData) {
  const res = await fetchApi('/nri-billing/rate-cards', { method: 'POST', body: formData });
  const err = apiError(res);
  if (err) return { error: messageOf(err) };
  revalidate();
  return res as { entity: Entity; rates: number; priced: number; info: number; rules: number };
}

// ─── Uploaded NRI invoice reports ────────────────────────────────────────────
export async function getBillingFiles(entity: Entity): Promise<{ files: BillingFile[]; orderDataRows: number }> {
  const data = await fetchApi(`/nri-billing/files?entity=${entity}`);
  return { files: Array.isArray(data?.files) ? data.files : [], orderDataRows: data?.orderDataRows ?? 0 };
}

/**
 * Preview (dryRun=true) or save an NRI report. A 409 comes back as data, not an
 * error: `duplicate` carries the full preview so the page can show what matched
 * and let the user force it deliberately; `locked` says which file to unlock.
 */
export async function uploadBillingFile(formData: FormData):
  Promise<UploadResult | { error: string; message?: string; preview?: UploadResult }> {
  const res = await fetchApi('/nri-billing/files', { method: 'POST', body: formData });
  const err = apiError(res);
  if (err) {
    return {
      error: String(err.error ?? 'Upload failed.'),
      message: err.message as string | undefined,
      preview: err.id ? (err as unknown as UploadResult) : undefined,
    };
  }
  if (formData.get('dryRun') !== 'true') revalidate();
  return res as UploadResult;
}

export async function setFileLocked(id: string, locked: boolean) {
  const res = await fetchApi(`/nri-billing/files/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ locked }) });
  const err = apiError(res);
  if (err) return { error: messageOf(err) };
  revalidate();
  return res as BillingFile;
}

export async function deleteBillingFile(id: string) {
  const res = await fetchApi(`/nri-billing/files/${encodeURIComponent(id)}`, { method: 'DELETE' });
  const err = apiError(res);
  if (err) return { error: messageOf(err) };
  revalidate();
  return res as { deleted: string; lines: number };
}

/** Order data supplies Order Type (the channel) — uploaded through the existing
 *  /nri-invoices endpoint so there is ONE order master per warehouse. */
export async function uploadBillingOrderData(formData: FormData) {
  const res = await fetchApi('/nri-invoices/order-data', { method: 'POST', body: formData });
  const err = apiError(res);
  if (err) return { error: messageOf(err) };
  revalidate();
  return res as { read: number; added: number; updated: number; orders: number };
}

// ─── Results ─────────────────────────────────────────────────────────────────
export async function getBillingResults(scope: Scope): Promise<Results | null> {
  const data = await fetchApi(`/nri-billing/results?${scopeQuery(scope)}`);
  return data && !data.error ? (data as Results) : null;
}

export async function getBillingLines(scope: Scope, filter: LineFilter, page = 1, pageSize = 50): Promise<LinePage | null> {
  const p = scopeQuery(scope);
  for (const [k, v] of Object.entries(filter)) if (v !== undefined && v !== '') p.set(k, String(v));
  p.set('page', String(page));
  p.set('pageSize', String(pageSize));
  const data = await fetchApi(`/nri-billing/lines?${p}`);
  return data && !data.error ? (data as LinePage) : null;
}

/**
 * The workbook's two manual columns. `lineIds` targets specific lines; otherwise
 * every line matching `filter` within `scope`. A key sent as null CLEARS it.
 */
export async function setBillingOverride(
  scope: Scope,
  target: { lineIds?: string[]; filter?: LineFilter },
  patch: { classOverride?: string | null; glOverride?: number | null },
) {
  const res = await fetchApi('/nri-billing/lines/override', {
    method: 'PUT',
    body: JSON.stringify({ ...scope, ...target, ...patch }),
  });
  const err = apiError(res);
  if (err) return { error: messageOf(err) };
  revalidate();
  return res as { updated: number; charges: number };
}

// ─── Channel rules ───────────────────────────────────────────────────────────
export async function getClassRules(entity: Entity, month?: string): Promise<RulesPayload | null> {
  const data = await fetchApi(`/nri-billing/rules?entity=${entity}${month ? `&month=${encodeURIComponent(month)}` : ''}`);
  return data && !data.error ? (data as RulesPayload) : null;
}

/** Saves the entity's rules as one ordered list (replaces what is stored). */
/**
 * Save the rules FOR `month` — only the sections in `saveKinds` (the ones the user
 * changed), so editing an exception never gives the month its own order-type or
 * service columns by accident. A saved month carries forward to later months.
 */
export async function saveClassRules(entity: Entity, rules: ClassRule[], opts: { month: string; saveKinds: RuleKind[] }) {
  const res = await fetchApi('/nri-billing/rules', {
    method: 'PUT',
    body: JSON.stringify({
      entity,
      month: opts.month,
      saveKinds: opts.saveKinds,
      rules: rules.map((r) => ({ kind: r.kind, name: r.name, enabled: r.enabled, conditions: r.conditions, setClass: r.setClass })),
    }),
  });
  const err = apiError(res);
  if (err) return { error: messageOf(err) };
  revalidate();
  return res as { entity: Entity; saved: number };
}

/** Drop everything set for a month — it inherits from the month before again. */
export async function clearRuleMonth(entity: Entity, month: string) {
  const res = await fetchApi(`/nri-billing/rules/month?entity=${entity}&month=${encodeURIComponent(month)}`, { method: 'DELETE' });
  const err = apiError(res);
  if (err) return { error: messageOf(err) };
  revalidate();
  return res as { removed: number };
}

// ─── Order data from NetSuite ────────────────────────────────────────────────
export async function getOrderDataStatus(entity: Entity): Promise<OrderDataStatus | null> {
  const data = await fetchApi(`/nri-billing/order-data?entity=${entity}`);
  return data && !data.error ? (data as OrderDataStatus) : null;
}

/** Pull Item Fulfillments from NetSuite (read-only) — from a week before what is covered, to today. */
export async function syncOrderDataFromNetsuite(entity: Entity) {
  const res = await fetchApi('/nri-billing/order-data/sync', { method: 'POST', body: JSON.stringify({ entity }) });
  const err = apiError(res);
  if (err) return { error: messageOf(err) };
  revalidate();
  return res as OrderSyncResult;
}

// ─── GL Codes (by period-end month) ──────────────────────────────────────────
export async function getGlCodes(entity: Entity, month?: string): Promise<GlCodesPayload | null> {
  const q = new URLSearchParams({ entity });
  if (month) q.set('month', month);
  const data = await fetchApi(`/nri-billing/gl-codes?${q}`);
  return data && !data.error ? (data as GlCodesPayload) : null;
}

/** Save the month's complete service → GL list; it carries forward to later months. */
export async function saveGlCodes(entity: Entity, month: string, services: { service: string; gl: number | null; glWholesaleOrder: number | null }[]) {
  const res = await fetchApi('/nri-billing/gl-codes', { method: 'PUT', body: JSON.stringify({ entity, month, services }) });
  const err = apiError(res);
  if (err) return { error: messageOf(err) };
  revalidate();
  return res as { entity: Entity; month: string; saved: number };
}

/** Drop a month's own settings — it inherits from the month before again. */
export async function clearGlCodes(entity: Entity, month: string) {
  const res = await fetchApi(`/nri-billing/gl-codes?entity=${entity}&month=${encodeURIComponent(month)}`, { method: 'DELETE' });
  const err = apiError(res);
  if (err) return { error: messageOf(err) };
  revalidate();
  return res as { removed: number };
}

// ─── Review after upload ─────────────────────────────────────────────────────
export async function getFileReview(id: string): Promise<FileReview | { error: string }> {
  const res = await fetchApi(`/nri-billing/files/${encodeURIComponent(id)}/review`);
  const err = apiError(res);
  if (err) return { error: messageOf(err) };
  return res as FileReview;
}

/** Confirm the invoice's services → channel + GL; changes become its month's settings. */
export async function confirmFileReview(
  id: string,
  services: { service: string; channel: 'whsle' | 'online'; gl: number | null }[],
  /** one per review question — a hand coding on those lines */
  answers: { lineIds: string[]; channel?: 'whsle' | 'online'; gl?: number }[] = [],
) {
  const res = await fetchApi(`/nri-billing/files/${encodeURIComponent(id)}/confirm`, { method: 'POST', body: JSON.stringify({ services, answers }) });
  const err = apiError(res);
  if (err) return { error: messageOf(err) };
  revalidate();
  return res as { id: string; month: string; channelChanged: number; glChanged: number; answered: number };
}
