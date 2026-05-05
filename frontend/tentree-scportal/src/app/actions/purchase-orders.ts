'use server';

import { fetchApi } from '@/lib/api';
import { revalidatePath } from 'next/cache';

export async function getPurchaseOrders() {
  try {
    const data = await fetchApi('/purchase-orders');
    return data || [];
  } catch {
    return [];
  }
}

export async function createPurchaseOrder(data: any) {
  const result = await fetchApi('/purchase-orders', {
    method: 'POST',
    body: JSON.stringify(data),
  });
  revalidatePath('/purchase-orders');
  return result;
}

export async function bulkCreatePurchaseOrders(rows: any[]) {
  const result = await fetchApi('/purchase-orders/bulk', {
    method: 'POST',
    body: JSON.stringify(rows),
  });
  revalidatePath('/purchase-orders');
  return result;
}

export async function updatePurchaseOrder(id: string, data: any) {
  const result = await fetchApi(`/purchase-orders/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
  revalidatePath('/purchase-orders');
  return result;
}

export async function deletePurchaseOrder(id: string) {
  const result = await fetchApi(`/purchase-orders/${id}`, {
    method: 'DELETE',
  });
  revalidatePath('/purchase-orders');
  return result;
}

export async function duplicatePurchaseOrder(po: any) {
  const { id, ...rest } = po;
  // Append -copy or similar if needed, or just let server handle it
  return createPurchaseOrder({ ...rest });
}

export async function syncNetSuite() {
  const data = await fetchApi('/integrations/netsuite/pos');
  revalidatePath('/purchase-orders');
  return data;
}
