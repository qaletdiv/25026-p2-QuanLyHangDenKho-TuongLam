'use server';

import { fetchApi } from '@/lib/api';

export async function getSuppliers() { return fetchApi('/master-data/suppliers') ?? []; }
export async function getCouriers() { return fetchApi('/master-data/couriers') ?? []; }
export async function getIncoterms() { return fetchApi('/master-data/incoterms') ?? []; }
export async function getStatuses() { return fetchApi('/master-data/statuses') ?? []; }
export async function getMasterStatuses(type: string) { return fetchApi(`/master-data/${type}`) ?? []; }

export async function updateSuppliers(data: any) { await fetchApi('/master-data/suppliers', { method: 'PUT', body: JSON.stringify(data) }); return { success: true }; }
export async function updateCouriers(data: any) { await fetchApi('/master-data/couriers', { method: 'PUT', body: JSON.stringify(data) }); return { success: true }; }
export async function updateIncoterms(data: any) { await fetchApi('/master-data/incoterms', { method: 'PUT', body: JSON.stringify(data) }); return { success: true }; }
export async function updateStatuses(data: any) { await fetchApi('/master-data/statuses', { method: 'PUT', body: JSON.stringify(data) }); return { success: true }; }

export async function getWarehouses() { return fetchApi('/master-data/warehouses') ?? []; }
export async function getModes() { return fetchApi('/master-data/modes') ?? []; }
export async function updateWarehouses(data: any) { await fetchApi('/master-data/warehouses', { method: 'PUT', body: JSON.stringify(data) }); return { success: true }; }
export async function updateModes(data: any) { await fetchApi('/master-data/modes', { method: 'PUT', body: JSON.stringify(data) }); return { success: true }; }
