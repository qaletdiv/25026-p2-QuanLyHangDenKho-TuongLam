import { getMainlineReport, getMainlineTransitTimes } from '@/modules/mainline/actions';
import { getProductionSchedules } from '@/app/actions/master-data';
import type { MainlineReportRow, TransitTimesReport, ProductionScheduleRow } from '@/modules/mainline/types';
import MainlineReportsClient from './MainlineReportsClient';

// Mainline season KPI report — PO-leg-grained FULL order book: every leg appears
// with stage (Awaiting Booking → Booking Pending → shipment pipeline), timeliness
// graded on actual or projected E-DEL, a per-row reason, and the transit-time
// actual-vs-standard overview. The production schedule (the grading gates, set in
// /settings/production-schedules) is shown in the header.
export default async function MainlineReportsPage() {
  let rows: MainlineReportRow[] = [];
  let transit: TransitTimesReport | null = null;
  let schedules: ProductionScheduleRow[] = [];
  try {
    let sched: unknown;
    [rows, transit, sched] = await Promise.all([getMainlineReport(), getMainlineTransitTimes(), getProductionSchedules()]);
    rows = rows || [];
    schedules = Array.isArray(sched) ? sched : [];
  } catch {
    // render empty state
  }
  return <MainlineReportsClient rows={rows} transit={transit} schedules={schedules} />;
}
