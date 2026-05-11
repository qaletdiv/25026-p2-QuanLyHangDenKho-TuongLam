import ForecastClient from './ForecastClient';
import { getForecast } from '@/app/actions/forecast';

export default async function ForecastPage() {
  let forecast = [];
  try {
    forecast = await getForecast() || [];
  } catch {
    // render with empty state
  }

  return <ForecastClient forecast={forecast || []} />;
}
