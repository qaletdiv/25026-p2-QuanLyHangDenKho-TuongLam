import { notFound } from 'next/navigation';
import { getPoMaster, getOrderIntent, getMainlineFulfillment } from '@/modules/mainline/actions';
import { getModes } from '@/app/actions/master-data';
import PoMasterDetail from '@/modules/mainline/components/PoMasterDetail';

// Mainline PO master detail — TRN → orders → legs/lines + order-intent + three-way match.
export default async function MainlinePoDetailPage({ params }: { params: Promise<{ trn: string }> }) {
  const { trn } = await params;
  const [master, intent, fulfillment, modes] = await Promise.all([
    getPoMaster(trn), getOrderIntent(trn), getMainlineFulfillment(trn), getModes(),
  ]);
  if (!master) notFound();
  const modeMap: Record<string, string> = Array.isArray(modes)
    ? Object.fromEntries(modes.map((m: { id: string; name: string }) => [m.id, m.name]))
    : {};
  return <PoMasterDetail master={master} intent={intent} fulfillment={fulfillment} modeMap={modeMap} />;
}
