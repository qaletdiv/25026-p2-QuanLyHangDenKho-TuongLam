import { notFound } from 'next/navigation';
import { getPoLeg, getMainlinePoReconcile } from '@/modules/mainline/actions';
import PoLegDetail from '@/modules/mainline/components/PoLegDetail';

// Mainline PO leg detail — the SKU line items a vendor must produce for one
// air/sea split, plus the component-PO reconcile (ordered/shipped/received).
// Path: /mainline/purchase-orders/{trn}/{legId}.
export default async function MainlinePoLegPage({ params }: { params: Promise<{ trn: string; legId: string }> }) {
  const { legId } = await params;
  const leg = await getPoLeg(legId);
  if (!leg) notFound();
  const reconcile = leg.po_number ? await getMainlinePoReconcile(leg.po_number) : null;
  return <PoLegDetail leg={leg} reconcile={reconcile} />;
}
