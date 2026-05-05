'use server';

import { fetchApi } from '@/lib/api';
import { revalidatePath } from 'next/cache';

export async function getHistoryShipments() {
  const data = await fetchApi('/history');
  return data || [];
}

export async function runHistorySweep() {
  const data = await fetchApi('/history/sweep', {
    method: 'POST',
  });
  revalidatePath('/shipments');
  revalidatePath('/history');
  revalidatePath('/');
  return data;
}
