'use server';

import { fetchApi } from '@/lib/api';
import { revalidatePath } from 'next/cache';

export async function getSuppliers() { return fetchApi('/master-data/suppliers') ?? []; }
export async function getCouriers() { return fetchApi('/master-data/couriers') ?? []; }
export async function getIncoterms() { return fetchApi('/master-data/incoterms') ?? []; }
export async function getStatuses() { return fetchApi('/master-data/statuses') ?? []; }
export async function getMasterStatuses(type: string) { return fetchApi(`/master-data/${type}`) ?? []; }

// Master data feeds names into the PO / booking / shipment pages (which join on id),
// so after an edit bust those sections' caches — otherwise a rename only shows after a
// hard refresh. Layout-level revalidation covers their list AND detail routes.
function revalidateMasterDataConsumers() {
  for (const section of ['/mainline', '/sms']) {
    revalidatePath(section, 'layout');
  }
}

// fetchApi returns { error } (with the backend message) on a non-2xx response — surface
// it instead of silently reporting success (e.g. a blank 'name' fails Joi validation).
function saveError(res: any): string | null {
  if (!res?.error) return null;
  const raw: string = res.error;
  const brace = raw.indexOf('{');
  if (brace >= 0) {
    try {
      const p = JSON.parse(raw.slice(brace));
      if (Array.isArray(p.details) && p.details.length) return p.details.map((d: any) => d.message).join('; ');
      if (p.error) return p.error;
    } catch { /* fall through to raw */ }
  }
  return raw;
}

async function putMasterData(endpoint: string, data: any) {
  const res = await fetchApi(endpoint, { method: 'PUT', body: JSON.stringify(data) });
  const error = saveError(res);
  if (error) return { success: false as const, error };
  revalidateMasterDataConsumers();
  return { success: true as const };
}

export async function updateSuppliers(data: any) { return putMasterData('/master-data/suppliers', data); }
export async function updateCouriers(data: any) { return putMasterData('/master-data/couriers', data); }
export async function updateIncoterms(data: any) { return putMasterData('/master-data/incoterms', data); }
export async function updateStatuses(data: any) { return putMasterData('/master-data/statuses', data); }

export async function getWarehouses() { return fetchApi('/master-data/warehouses') ?? []; }
export async function getModes() { return fetchApi('/master-data/modes') ?? []; }
export async function updateWarehouses(data: any) { return putMasterData('/master-data/warehouses', data); }
export async function updateModes(data: any) { return putMasterData('/master-data/modes', data); }

// Per-season KPI gates (On Time / At Risk cutoffs) — grades the mainline report.
export async function getProductionSchedules() { return fetchApi('/master-data/production-schedules') ?? []; }
// Pre-load next season before its POs exist (row in `seasons`; syncs match by code).
export async function createSeason(code: string) {
  const res = await fetchApi('/master-data/seasons', { method: 'POST', body: JSON.stringify({ code }) });
  const error = saveError(res);
  if (error) return { success: false as const, error };
  revalidateMasterDataConsumers();
  return { success: true as const };
}
export async function updateProductionSchedules(data: any) {
  const res = await putMasterData('/master-data/production-schedules', data);
  if (res.success) revalidatePath('/reports/mainline');   // the report grades against these
  return res;
}
