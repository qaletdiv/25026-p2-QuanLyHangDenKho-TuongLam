import { notFound } from 'next/navigation';
import { getSmsPo } from '@/modules/sms/actions';
import SmsPoDetail from '@/modules/sms/components/SmsPoDetail';

// SMS PO detail — lines, consignments (lots), receiving reconciliation.
export default async function SmsPoDetailPage({ params }: { params: Promise<{ poNumber: string }> }) {
  const { poNumber } = await params;
  const po = await getSmsPo(decodeURIComponent(poNumber));
  if (!po) notFound();
  return <SmsPoDetail po={po} />;
}
