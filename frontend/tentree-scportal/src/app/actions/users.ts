'use server';

import { fetchApi } from '@/lib/api';
import { revalidatePath } from 'next/cache';

export async function getUsers() {
  const data = await fetchApi('/users');
  // Return raw response so the caller can distinguish API errors from an empty array
  return data;
}

export async function createUser(data: {
  name: string;
  email: string;
  password: string;
  role: string;
  supplier?: string | null;
}) {
  const result = await fetchApi('/users', {
    method: 'POST',
    body: JSON.stringify(data),
  });
  revalidatePath('/settings/users');
  return result;
}

export async function updateUser(id: string, data: {
  name?: string;
  email?: string;
  password?: string;
  role?: string;
  supplier?: string | null;
  must_change_password?: boolean;
}) {
  const result = await fetchApi(`/users/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
  revalidatePath('/settings/users');
  return result;
}

export async function deleteUser(id: string) {
  const result = await fetchApi(`/users/${id}`, {
    method: 'DELETE',
  });
  revalidatePath('/settings/users');
  return result;
}
