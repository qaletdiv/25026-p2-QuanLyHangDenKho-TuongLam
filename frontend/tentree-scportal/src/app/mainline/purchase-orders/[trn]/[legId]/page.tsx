import { notFound } from 'next/navigation';
import { getPoLeg, getMainlineLegReconcile } from '@/modules/mainline/actions';
import PoLegDetail from '@/modules/mainline/components/PoLegDetail';

// Mainline PO leg detail — the SKU line items a vendor must produce for one
// air/sea split, plus the LEG-scoped reconcile (allocated/shipped/received):
// NetSuite receipts are split across the PO's legs so the sea leg isn't credited
// the air leg's received units. Path: /mainline/purchase-orders/{trn}/{legId}.
export default async function MainlinePoLegPage({ params }: { params: Promise<{ trn: string; legId: string }> }) {
  const { legId } = await params;
  const leg = await getPoLeg(legId);
  if (!leg) notFound();
  const reconcile = await getMainlineLegReconcile(legId);
  return <PoLegDetail leg={leg} reconcile={reconcile} />;
}
