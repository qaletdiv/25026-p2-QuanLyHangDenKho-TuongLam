import { getMainlineLandedCosts } from '@/modules/landed-costs/actions';
import MainlineLandedCostsTable from '@/modules/landed-costs/components/MainlineLandedCostsTable';

// Landed Costs — Mainline: freight & duty (entered on the shipment) split per PO by
// CI value and posted to each PO's Item Receipt. Read-only amounts here.
export default async function MainlineLandedCostsPage() {
  const { rows } = await getMainlineLandedCosts();
  return <MainlineLandedCostsTable rows={rows} />;
}
