import { ReceiptText } from 'lucide-react';
import { getInvoiceSources } from '@/modules/nri-invoices/actions';
import { getWarehouseFacilities } from '@/app/actions/master-data';
import WarehouseTabs from '@/modules/nri-invoices/components/WarehouseTabs';

// ALL INVOICES — the 3PL invoice verification section, one tab per invoicing
// warehouse. It was "NRI Invoices" with NRI US hardcoded, which named a single
// vendor after the whole capability; each warehouse bills on its own format, so
// the tabs come from the registry (data/nri/nri_invoice_sources.json) and can be
// added to from the strip.
export default async function AllInvoicesLayout({ children }: { children: React.ReactNode }) {
  const [sources, facilities] = await Promise.all([
    getInvoiceSources(),
    getWarehouseFacilities().catch(() => []),
  ]);

  return (
    <div className="mx-auto max-w-7xl">
      <div className="space-y-3 px-4 pt-4 md:px-6 md:pt-6">
        <div className="space-y-1">
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <ReceiptText className="h-6 w-6 text-primary" /> All Invoices
          </h1>
          <p className="text-sm text-muted-foreground">
            Verify each warehouse invoice against its detail and against the rate agreement, code
            every line to a GL, then submit.
          </p>
        </div>
        <WarehouseTabs
          sources={sources}
          facilities={Array.isArray(facilities) ? facilities.map((f: { id: string; name: string }) => ({ id: f.id, name: f.name })) : []}
        />
      </div>
      <div className="p-4 md:p-6">{children}</div>
    </div>
  );
}
