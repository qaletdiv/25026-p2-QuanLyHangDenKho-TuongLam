import { redirect } from 'next/navigation';
import { getInvoice, getInvoiceSources } from '@/modules/nri-invoices/actions';

// MOVED to /invoices/<warehouse>/<invoiceNo>. The warehouse is resolved from the
// invoice itself (its `entity`) rather than assumed to be NRI US, so a bookmarked
// CA invoice lands on the CA tab once CA invoices exist.
export default async function NriInvoiceDetailMoved({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [invoice, sources] = await Promise.all([getInvoice(id), getInvoiceSources()]);
  if (!invoice) redirect('/invoices');
  const code = sources.find((s) => String(s.entity).toUpperCase() === String(invoice.entity).toUpperCase())?.code;
  redirect(code ? `/invoices/${code}/${encodeURIComponent(id)}` : '/invoices');
}
