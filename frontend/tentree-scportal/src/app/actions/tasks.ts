'use server';

import { fetchApi } from '@/lib/api';
import { revalidatePath } from 'next/cache';

export async function getEomTasks(month: string) {
  const data = await fetchApi(`/eom-tasks?month=${month}`);
  return data || [];
}

export async function createEomTasks(data: any[]) {
  const result = await fetchApi('/eom-tasks/bulk', {
    method: 'POST',
    body: JSON.stringify(data),
  });
  revalidatePath('/eom');
  revalidatePath('/');
  return result;
}

export async function updateEomTask(id: string, data: any) {
  const result = await fetchApi(`/eom-tasks/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
  revalidatePath('/eom');
  revalidatePath('/');
  return result;
}
