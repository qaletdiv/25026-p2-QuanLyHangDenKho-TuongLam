import Link from 'next/link';
import { cookies } from 'next/headers';
import { ShieldAlert, ArrowRight } from 'lucide-react';
import { getAuthToken } from '@/app/actions/auth';
import { fetchIdentity } from '@/lib/serverIdentity';
import { firstAllowedPath } from '@/lib/pageAccess';
import { PERMISSION_MANIFEST } from '@/lib/permissions';

// Where the route gate sends a signed-in user who asked for a page their role
// does not include. Deliberately a plain explanation rather than a silent
// redirect: the user typed or bookmarked that URL, so "nothing happened" would
// read as a broken link. This page itself requires no permission, so it can
// never bounce off the gate.
export default async function NoAccessPage() {
  const [cookieStore, token] = await Promise.all([cookies(), getAuthToken()]);
  const denied = cookieStore.get('denied_permission')?.value ?? null;
  const result = token ? await fetchIdentity(token) : null;
  const identity = result?.ok ? result.identity : null;
  const home = firstAllowedPath(identity?.permissions);

  const label = denied
    ? PERMISSION_MANIFEST.flatMap((g) => g.items).find((i) => i.key === denied)?.label ?? denied
    : null;

  return (
    <div className="flex flex-col items-center justify-center px-6 py-24 text-center">
      <div className="mb-4 rounded-2xl bg-muted p-4"><ShieldAlert className="h-8 w-8 text-muted-foreground" /></div>
      <h1 className="text-xl font-semibold text-foreground">You don’t have access to this page</h1>
      <p className="mt-2 max-w-md text-sm text-muted-foreground">
        {label
          ? <>It needs the <span className="font-medium text-foreground">{label}</span> permission, which the{' '}
              <span className="font-medium text-foreground">{identity?.role ?? 'your'}</span> role doesn’t currently include.</>
          : <>Your role doesn’t include this page.</>}
        {' '}Ask an administrator to grant it in Settings → Roles.
      </p>
      {home !== '/no-access' && (
        <Link href={home} className="mt-6 inline-flex items-center gap-2 text-sm font-medium text-primary hover:underline">
          Go to a page you can open <ArrowRight className="h-4 w-4" />
        </Link>
      )}
    </div>
  );
}
