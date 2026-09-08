import { notFound } from 'next/navigation';
import { getPoLeg, getMainlineLegReconcile, getMainlineLegShipments } from '@/modules/mainline/actions';
import PoLegDetail from '@/modules/mainline/components/PoLegDetail';

// Mainline PO leg detail — the SKU line items a vendor must produce for one
// air/sea split, plus the LEG-scoped reconcile (allocated/shipped/received):
// NetSuite receipts are split across the PO's legs so the sea leg isn't credited
// the air leg's received units, and the consignments carrying the leg.
// Path: /mainline/purchase-orders/{trn}/{legId}.
export default async function MainlinePoLegPage({ params }: { params: Promise<{ trn: string; legId: string }> }) {
  const { legId } = await params;
  const leg = await getPoLeg(legId);
  if (!leg) notFound();
  // Independent of each other — both only need the leg to exist.
  const [reconcile, shipments] = await Promise.all([
    getMainlineLegReconcile(legId),
    getMainlineLegShipments(legId),
  ]);
  return <PoLegDetail leg={leg} reconcile={reconcile} shipments={shipments} />;
}
