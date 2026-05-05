import ReportsClient from './ReportsClient';
import { getReports } from '@/app/actions/reports';

export default async function ReportsPage() {
  let reports = [];
  try {
    reports = await getReports() || [];
  } catch (e) {
    console.error('Failed to fetch reports:', e);
  }

  return <ReportsClient initialReports={reports || []} />;
}
