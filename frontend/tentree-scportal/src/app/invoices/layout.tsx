import { ReceiptText } from 'lucide-react';
import BillingNav from '@/modules/nri-billing/components/BillingNav';

// ALL INVOICES — NRI's billing, the way the team works it in
// `NRI CA_ALL Invoices 2026.xlsx`: rate cards are the agreement, each twice-monthly
// NRI report is uploaded and kept for the year, and the result is cost per GL by
// channel. Data + logic: backend /nri-billing (see docs/NRI_INVOICE_MODULE.md).
export default function AllInvoicesLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-7xl">
      <div className="space-y-3 px-4 pt-4 md:px-6 md:pt-6">
        <div className="space-y-1">
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <ReceiptText className="h-6 w-6 text-primary" /> All Invoices
          </h1>
          <p className="text-sm text-muted-foreground">
            NRI CA and NRI US billing — every charge coded to a GL and channel, and checked against the rate card.
          </p>
        </div>
        <BillingNav />
      </div>
      <div className="p-4 md:p-6">{children}</div>
    </div>
  );
}
