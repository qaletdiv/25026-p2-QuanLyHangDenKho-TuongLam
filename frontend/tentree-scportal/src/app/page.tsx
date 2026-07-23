import { redirect } from 'next/navigation';

// Legacy stack removed (2026-07-03) — the portal home is the mainline PO list.
export default function Home() {
  redirect('/mainline/purchase-orders');
}
