import { redirect } from 'next/navigation';

// /invoices has no content of its own — it opens on the result. No sibling
// loading.tsx, so this is a real 307 (see the redirect() note in CLAUDE.md).
export default function AllInvoicesIndex() {
  redirect('/invoices/results');
}
