import { redirect } from 'next/navigation';

// MOVED. This section is now All Invoices (/invoices), one tab per invoicing
// warehouse, because "NRI Invoices" named one vendor after the whole capability.
// Kept as a redirect so existing links and bookmarks keep working.
export default function NriInvoicesMoved() {
  redirect('/invoices');
}
