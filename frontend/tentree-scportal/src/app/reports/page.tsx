import ReportsClient from './ReportsClient';
import { getReports } from '@/app/actions/reports';

export default async function ReportsPage() {
  let reports = [];
  try {
    reports = await getReports() || [];
  } catch {
    // render with empty state
  }

  return <ReportsClient initialReports={reports || []} />;
}
