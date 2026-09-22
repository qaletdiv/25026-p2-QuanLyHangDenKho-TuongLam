import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { getChargeCodes, getOrderData, getInvoiceSources } from '@/modules/nri-invoices/actions';
import { LegendPanel, OrderDataPanel } from '@/modules/nri-invoices/components/SetupPanels';

// SETUP — the two inputs the coding runs on, before any invoice is uploaded:
// the legend (GL per service) and the order data (channel + ship-to country).
// Kept on its own page rather than on the upload screen: they are configured
// rarely and read constantly, and mixing them into the per-invoice flow would
// suggest you re-do them every time.
export default async function WarehouseSetupPage({ params }: { params: Promise<{ warehouse: string }> }) {
  const { warehouse } = await params;
  const sources = await getInvoiceSources();
  const source = sources.find((s) => s.code === warehouse);
  if (!source) notFound();

  const [codes, orderStatus] = await Promise.all([getChargeCodes(), getOrderData(warehouse)]);

  return (
    <div className="space-y-5">
      <Link href={`/invoices/${warehouse}`} className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> {source.label} invoices
      </Link>

      <div>
        <h2 className="text-lg font-semibold">Setup — {source.label}</h2>
        <p className="text-sm text-muted-foreground">
          What the coding looks things up in. Configure these once; every invoice you upload afterwards
          is coded against them.
        </p>
      </div>

      <LegendPanel codes={codes} entity={String(source.entity).toUpperCase()} warehouse={warehouse} />
      <OrderDataPanel status={orderStatus} warehouse={warehouse} />
    </div>
  );
}
