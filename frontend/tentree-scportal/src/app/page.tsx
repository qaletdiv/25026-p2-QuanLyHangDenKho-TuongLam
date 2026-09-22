import { redirect } from 'next/navigation';
import { getAuthToken } from '@/app/actions/auth';
import { fetchIdentity } from '@/lib/serverIdentity';
import { firstAllowedPath } from '@/lib/pageAccess';

// Legacy stack removed (2026-07-03) — the portal home is the mainline PO list…
// but only for roles that may open it. Sending everyone there unconditionally
// meant a role without `purchase_orders` (or the Freight Forwarder, who has
// neither PO nor report access) landed on the gate and bounced to /no-access on
// login. Land on the first page the role can actually open instead.
export default async function Home() {
  const token = await getAuthToken();
  const result = token ? await fetchIdentity(token) : null;
  redirect(result?.ok ? firstAllowedPath(result.identity.permissions) : '/mainline/purchase-orders');
}
