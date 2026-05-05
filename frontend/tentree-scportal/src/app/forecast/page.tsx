import ForecastClient from './ForecastClient';
import { getForecast } from '@/app/actions/forecast';

export default async function ForecastPage() {
  let forecast = [];
  try {
    forecast = await getForecast() || [];
  } catch (e) {
    console.error('Failed to fetch forecast:', e);
  }

  return <ForecastClient forecast={forecast || []} />;
}
