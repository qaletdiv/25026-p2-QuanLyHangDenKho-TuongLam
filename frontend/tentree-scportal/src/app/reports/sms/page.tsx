import { getSmsReport } from '@/modules/sms/actions';
import type { SmsReportRow } from '@/modules/sms/types';
import SmsReportsClient from './SmsReportsClient';

// SMS season KPI report — PO-grained full order book. One row per sms_po with
// ordered/shipped/received rollups, a fulfillment KPI cascade, and HOD timeliness
// (SMS has no production schedule; HOD, the handover-by date, is the time anchor).
export default async function SmsReportsPage() {
  let rows: SmsReportRow[] = [];
  try {
    rows = await getSmsReport();
  } catch {
    // render empty state
  }
  return <SmsReportsClient rows={rows} />;
}
