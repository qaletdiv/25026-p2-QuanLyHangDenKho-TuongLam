'use server';

import { fetchApi } from '@/lib/api';

export async function getReports() {
  const data = await fetchApi('/reports');
  return data || [];
}
