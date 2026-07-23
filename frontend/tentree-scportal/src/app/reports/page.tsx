import { redirect } from 'next/navigation';

// The legacy report overview was removed with the legacy stack (2026-07-03);
// the season KPI report is the reports landing page. SMS reports come later.
export default function ReportsPage() {
  redirect('/reports/mainline');
}
