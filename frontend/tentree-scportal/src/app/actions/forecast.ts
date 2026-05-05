'use server';

import { fetchApi } from '@/lib/api';

export async function getForecast() {
  const data = await fetchApi('/forecast');
  return data || [];
}
