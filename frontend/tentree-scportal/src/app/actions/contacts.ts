'use server';

import { fetchApi } from '@/lib/api';

export async function getContacts() {
  const data = await fetchApi('/contacts');
  return Array.isArray(data) ? data : [];
}
