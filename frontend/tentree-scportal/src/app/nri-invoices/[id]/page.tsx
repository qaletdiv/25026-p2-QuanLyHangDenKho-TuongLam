import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { getInvoice, getChargeCodes } from '@/modules/nri-invoices/actions';
import ReconcileView from '@/modules/nri-invoices/components/ReconcileView';
import LinesTable from '@/modules/nri-invoices/components/LinesTable';
import SubmitBar from '@/modules/nri-invoices/components/SubmitBar';

// One loaded invoice: the three-way verification, then the coded lines with the
// exception queue on top. Rollups are derived on read, so an override moves the
// GL summary immediately.
export default async function NriInvoiceDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [invoice, chargeCodes] = await Promise.all([getInvoice(id), getChargeCodes()]);
  if (!invoice) notFound();

  const submitted = invoice.status === 'submitted';

  return (
    <div className="space-y-5">
      <Link href="/nri-invoices" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> All invoices
      </Link>

      <SubmitBar invoice={invoice} />
      <ReconcileView data={invoice} sourceFile={invoice.source_file} />
      <LinesTable
        invoiceNo={invoice.invoice_no}
        lines={invoice.lines}
        chargeCodes={chargeCodes}
        readOnly={submitted}
      />
    </div>
  );
}
