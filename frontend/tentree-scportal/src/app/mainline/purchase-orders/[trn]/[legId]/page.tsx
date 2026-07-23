import { notFound } from 'next/navigation';
import { getPoLeg } from '@/modules/mainline/actions';
import PoLegDetail from '@/modules/mainline/components/PoLegDetail';

// Mainline PO leg detail — the SKU line items a vendor must produce for one
// air/sea split. Path: /mainline/purchase-orders/{trn}/{legId}.
export default async function MainlinePoLegPage({ params }: { params: Promise<{ trn: string; legId: string }> }) {
  const { legId } = await params;
  const leg = await getPoLeg(legId);
  if (!leg) notFound();
  return <PoLegDetail leg={leg} />;
}
