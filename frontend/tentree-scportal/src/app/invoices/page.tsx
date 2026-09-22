import { redirect } from 'next/navigation';
import { getInvoiceSources } from '@/modules/nri-invoices/actions';

// /invoices has no content of its own — it lands on the first registered
// warehouse. Derived, not hardcoded to nri-us: if that warehouse is ever
// retired, the section still opens on whatever is left.
export default async function AllInvoicesIndex() {
  const sources = await getInvoiceSources();
  redirect(sources.length ? `/invoices/${sources[0].code}` : '/invoices/nri-us');
}
