import { getSmsLandedCosts } from '@/modules/landed-costs/actions';
import LandedCostsTable from '@/modules/landed-costs/components/LandedCostsTable';

// Landed Costs — SMS: freight & duty estimates from the commercial-invoice value,
// split per-PO, matched to the NetSuite Item Receipt, and posted (which pushes to
// NetSuite). Derived server-side; only the posted snapshot is stored.
export default async function SmsLandedCostsPage() {
  const { rows } = await getSmsLandedCosts();
  return <LandedCostsTable rows={rows} />;
}
