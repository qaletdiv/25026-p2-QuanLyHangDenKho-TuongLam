// SERVER-ONLY. Resolves "who is this request, and what may they open" from the
// backend, never from the cookie.
//
// The `session` cookie carries a permissions[] snapshot taken at login. It is
// fine for painting the first frame, but it must not decide access: it is data
// the browser holds (a signed JWT is not — that is why the gate verifies that),
// and it goes stale the moment an admin edits a role. GET /me re-resolves the
// role's permissions from roles.json per call, so a revoked permission applies
// without the user logging out and back in.
//
// Imported by src/proxy.ts (the gate) and the root layout (the nav), both of
// which run in the Next server process — hence the shared module-level cache.

import type { Permission } from './permissions';

const BACKEND_URL = process.env.NEXT_PUBLIC_API_URL || 'http://127.0.0.1:5000';

export type Identity = {
  id: string;
  email: string;
  role: string;
  name: string | null;
  supplier: string | null;
  permissions: Permission[];
};

export type IdentityResult =
  | { ok: true; identity: Identity }
  // the backend rejected the token — treat as signed out
  | { ok: false; reason: 'unauthenticated' }
  // the backend could not be reached / errored — an authorization answer is UNKNOWN
  | { ok: false; reason: 'unavailable' };

// A page navigation fans out into several server requests (the gate runs for the
// document and for each RSC payload, and Next prefetches links), so without this
// one click would mean a handful of identical /me calls. 3s is short enough that
// "revoke a permission, then try the URL" behaves as immediate — you cannot
// realistically do both inside the window — and long enough to collapse a burst.
const TTL_MS = 3_000;
const cache = new Map<string, { at: number; result: IdentityResult }>();

export function clearIdentityCache(token?: string) {
  if (token) cache.delete(token); else cache.clear();
}

export async function fetchIdentity(token: string): Promise<IdentityResult> {
  const hit = cache.get(token);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.result;

  let result: IdentityResult;
  try {
    const res = await fetch(`${BACKEND_URL}/me`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
    });
    if (res.status === 401 || res.status === 403) {
      result = { ok: false, reason: 'unauthenticated' };
    } else if (!res.ok) {
      result = { ok: false, reason: 'unavailable' };
    } else {
      const identity = (await res.json()) as Identity;
      result = Array.isArray(identity?.permissions)
        ? { ok: true, identity }
        : { ok: false, reason: 'unavailable' };
    }
  } catch {
    result = { ok: false, reason: 'unavailable' };
  }

  // Don't cache a transport failure: the backend restarting for a few seconds
  // shouldn't keep every gate decision unknown after it comes back.
  if (!(result.ok === false && result.reason === 'unavailable')) {
    cache.set(token, { at: Date.now(), result });
  }
  // Bound the map: one entry per live token is small, but a long-running dev
  // server accumulates one per login. Cheap sweep of expired entries.
  if (cache.size > 64) {
    const now = Date.now();
    for (const [k, v] of cache) if (now - v.at >= TTL_MS) cache.delete(k);
  }
  return result;
}
