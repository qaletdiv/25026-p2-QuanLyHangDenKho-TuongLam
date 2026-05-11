'use server';

import { fetchApi } from '@/lib/api';
import { revalidatePath } from 'next/cache';

export async function getHistoryShipments() {
  try {
    const data = await fetchApi('/history');
    return data || [];
  } catch {
    return [];
  }
}

export async function getHistoryBookings() {
  try {
    const data = await fetchApi('/history-bookings');
    return data || [];
  } catch {
    return [];
  }
}

export async function runHistorySweep() {
  try {
    const data = await fetchApi('/history/sweep', {
      method: 'POST',
    });
    revalidatePath('/shipments');
    revalidatePath('/history');
    revalidatePath('/');
    return data;
  } catch (e: any) {
    throw new Error(e?.message || 'History sweep failed');
  }
}
