'use server';

import { fetchApi } from '@/lib/api';
import { revalidatePath } from 'next/cache';

export async function getRoles() {
  const data = await fetchApi('/roles');
  return data;
}

export async function createRole(data: { name: string; description?: string; permissions: string[] }) {
  const result = await fetchApi('/roles', {
    method: 'POST',
    body: JSON.stringify(data),
  });
  revalidatePath('/settings/roles');
  return result;
}

export async function updateRole(id: string, data: { name?: string; description?: string; permissions?: string[] }) {
  const result = await fetchApi(`/roles/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
  revalidatePath('/settings/roles');
  return result;
}

export async function deleteRole(id: string) {
  const result = await fetchApi(`/roles/${id}`, {
    method: 'DELETE',
  });
  revalidatePath('/settings/roles');
  return result;
}
