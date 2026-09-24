import ForecastClient, { type ForecastWeek } from './ForecastClient';
import { getForecast } from '@/app/actions/forecast';

type ForecastPayload = { seasons: string[]; bySeason: Record<string, ForecastWeek[]> };

export default async function ForecastPage() {
  let data: ForecastPayload = { seasons: [], bySeason: { all: [] } };
  try {
    data = (await getForecast()) as ForecastPayload;
  } catch {
    // render with empty state
  }

  return <ForecastClient seasons={data.seasons || []} bySeason={data.bySeason || { all: [] }} />;
}
