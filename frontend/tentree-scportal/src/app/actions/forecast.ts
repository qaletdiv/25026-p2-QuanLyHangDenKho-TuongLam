'use server';

import { fetchApi } from '@/lib/api';

// `/forecast` returns { seasons, by_season } — the whole weekly rollup is
// pre-computed per season server-side so switching is instant and every series
// stays exact. Falls back to an empty shape so the page renders its empty state
// rather than throwing.
export async function getForecast() {
  const data = await fetchApi('/forecast');
  if (Array.isArray(data)) return { seasons: [], by_season: { all: data } };  // legacy shape
  return data && data.by_season ? data : { seasons: [], by_season: { all: [] } };
}
