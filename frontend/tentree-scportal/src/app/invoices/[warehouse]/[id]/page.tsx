import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { getInvoice, getChargeCodes } from '@/modules/nri-invoices/actions';
import ReconcileView from '@/modules/nri-invoices/components/ReconcileView';
import GlClassPivot from '@/modules/nri-invoices/components/GlClassPivot';
import LinesTable from '@/modules/nri-invoices/components/LinesTable';
import SubmitBar from '@/modules/nri-invoices/components/SubmitBar';

// One loaded invoice: the three-way verification, then the coded lines with the
// exception queue on top. Rollups are derived on read, so an override moves the
// GL summary immediately.
export default async function InvoiceDetailPage({ params }: { params: Promise<{ warehouse: string; id: string }> }) {
  const { warehouse, id } = await params;
  const [invoice, chargeCodes] = await Promise.all([getInvoice(id), getChargeCodes()]);
  if (!invoice) notFound();

  const submitted = invoice.status === 'submitted';

  return (
    <div className="space-y-5">
      {/* back to the warehouse this invoice belongs to, not to the section root —
          landing on a different warehouse's tab would be disorienting */}
      <Link href={`/invoices/${warehouse}`} className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> Invoices
      </Link>

      <SubmitBar invoice={invoice} />
      <ReconcileView data={invoice} sourceFile={invoice.sourceFile} />
      {/* The answer, in the workbook's Pivot shape. Above the line detail because
          it IS the deliverable — the lines below are how you fix what it flags. */}
      <GlClassPivot lines={invoice.lines} />
      <div id="coded-lines">
        <LinesTable
          invoiceNo={invoice.invoiceNo}
          lines={invoice.lines}
          chargeCodes={chargeCodes}
          readOnly={submitted}
        />
      </div>
    </div>
  );
}
