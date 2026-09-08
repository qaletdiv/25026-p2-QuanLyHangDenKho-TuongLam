'use server';

import { fetchApi, BACKEND_URL } from '@/lib/api';
import { getAuthToken } from '@/app/actions/auth';
import { revalidatePath } from 'next/cache';

/** GET /freights — list of records (rates stripped, rate_count added) */
export async function getFreightRecords() {
  const data = await fetchApi('/freights');
  return Array.isArray(data) ? data : [];
}

/** GET /freights/:id — full record including rates array */
export async function getFreightRecord(id: string) {
  return fetchApi(`/freights/${id}`);
}

/**
 * POST /freights/parse — upload filled template (.xlsx/.csv), parse, save.
 * FormData fields: file, forwarder, region, quote_ref?, effective_date?, expiry_date?
 */
export async function parseFreightTemplate(formData: FormData) {
  const token = await getAuthToken();
  const url = `${BACKEND_URL}/freights/parse`;

  const res = await fetch(url, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: formData,
    cache: 'no-store',
  });

  const text = await res.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = { error: text }; }

  if (!res.ok) throw new Error(data?.error || `Upload failed (${res.status})`);

  revalidatePath('/freights');
  return data;
}

// getFreightTemplateUrl() was REMOVED (2026-08-12). It returned the raw JWT to client
// code so a browser fetch could set an Authorization header — which put the token in
// browser JavaScript and defeated the httpOnly cookie. The template now downloads via
// docHref('/freights/template') → the /api/documents proxy, which authenticates from
// the cookie server-side. Do not reintroduce a server action that returns the token.

/** GET /freights/:id/export — generate export xlsx, return file_url */
export async function exportFreightRecord(id: string) {
  const data = await fetchApi(`/freights/${id}/export`);
  return data as { file_url: string };
}

/** DELETE /freights/:id */
export async function deleteFreightRecord(id: string) {
  await fetchApi(`/freights/${id}`, { method: 'DELETE' });
  revalidatePath('/freights');
}
