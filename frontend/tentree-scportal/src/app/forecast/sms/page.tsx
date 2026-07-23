import { getSmsForecast } from '@/modules/sms/actions';
import type { SmsForecastRow } from '@/modules/sms/types';
import SmsForecastClient from './SmsForecastClient';

// SMS incoming-quantity forecast — units still to arrive (ordered − received),
// bucketed by ISO week of each PO's Expected Receive Date (NS Due Date) and by
// destination facility. All aggregation happens client-side from PO-grained rows.
export default async function SmsForecastPage() {
  let rows: SmsForecastRow[] = [];
  try {
    rows = await getSmsForecast();
  } catch {
    // render empty state
  }
  return <SmsForecastClient rows={rows} />;
}
