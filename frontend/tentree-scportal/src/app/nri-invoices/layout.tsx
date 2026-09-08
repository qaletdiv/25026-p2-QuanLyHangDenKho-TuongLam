import { ReceiptText } from 'lucide-react';

// Shared shell for NRI invoice verification. US only for now — the CA detail
// workbook is built differently (Summary_Coded, its own embedded coding legend)
// and needs its own layout check before it can share this pipeline.
export default function NriInvoicesLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-7xl">
      <div className="space-y-1 px-4 pt-4 md:px-6 md:pt-6">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <ReceiptText className="h-6 w-6 text-primary" /> NRI Invoices
        </h1>
        <p className="text-sm text-muted-foreground">
          Verify the invoice against its detail and against the rate agreement, code every line to a
          GL, then submit. <span className="text-foreground">NRI USA</span> only for now.
        </p>
      </div>
      <div className="p-4 md:p-6">{children}</div>
    </div>
  );
}
