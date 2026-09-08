import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createHmac, timingSafeEqual } from 'node:crypto';

// Route gate. Replaces src/middleware.ts, which only checked that a `session` cookie
// EXISTED — never that it was authentic. Because the cookie's own contents named the
// role, anyone could hand-craft `session={"role":"Admin",...}` and every page shell
// would render for them. Now the JWT's SIGNATURE is verified.
//
// Renamed middleware.ts → proxy.ts because that is the supported convention in the
// installed Next (16.2.4): `middleware` is deprecated, and `proxy` runs on the
// nodejs runtime (not configurable — edge is unsupported here). The nodejs runtime is
// what lets this use node:crypto and therefore verify HS256 with NO new dependency.
// (`jose` is present in node_modules but only as a transitive dep of Next, so relying
// on it would be relying on something package.json does not declare.)
//
// This is defence in depth, not the primary control: the API enforces auth and
// permissions server-side, so a forged cookie already yields 401/403 on every fetch
// and renders empty pages. This stops the bogus admin-looking shell from rendering
// at all.

const SECRET = process.env.JWT_SECRET;

if (!SECRET) {
  // Loud, once, at load. Deliberately NOT a throw: a throw would 500 every request
  // including /login, leaving no way back in. Failing closed (redirect to /login)
  // keeps the app safe while making the misconfiguration obvious in the logs.
  console.error(
    '[proxy] JWT_SECRET is not set — every request will be treated as unauthenticated. ' +
    'Add JWT_SECRET to frontend/tentree-scportal/.env.local, matching backend/.env.',
  );
}

const b64url = (s: string) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

/**
 * Verify an HS256 JWT: signature, algorithm and expiry. Returns false on anything
 * malformed rather than throwing — a bad cookie is an unauthenticated request, not a
 * server error.
 */
function verifyJwt(token: string, secret: string): boolean {
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [head, payload, sig] = parts;

  // Pin the algorithm. Without this check a token with {"alg":"none"} and no
  // signature — or one signed with a different scheme — could be accepted.
  let header: { alg?: string };
  try {
    header = JSON.parse(b64url(head).toString('utf8'));
  } catch {
    return false;
  }
  if (header?.alg !== 'HS256') return false;

  const expected = createHmac('sha256', secret).update(`${head}.${payload}`).digest();
  const actual = b64url(sig);
  // timingSafeEqual throws on a length mismatch, so compare lengths first.
  if (actual.length !== expected.length) return false;
  if (!timingSafeEqual(actual, expected)) return false;

  let claims: { exp?: number };
  try {
    claims = JSON.parse(b64url(payload).toString('utf8'));
  } catch {
    return false;
  }
  // Reject expired tokens here too, so a stale 24h cookie bounces to /login instead
  // of rendering a shell whose every fetch then 401s.
  if (typeof claims?.exp === 'number' && claims.exp * 1000 <= Date.now()) return false;

  return true;
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const token = request.cookies.get('auth_token')?.value;
  const authed = Boolean(SECRET && token && verifyJwt(token, SECRET));

  // 1. Unauthenticated on a protected route → /login, clearing the bad cookies so a
  //    forged or expired pair doesn't sit around being re-sent on every request.
  if (!authed && pathname !== '/login') {
    const res = NextResponse.redirect(new URL('/login', request.url));
    res.cookies.delete('session');
    res.cookies.delete('auth_token');
    return res;
  }

  // 2. Already authenticated and heading to /login → into the app.
  if (authed && pathname === '/login') {
    return NextResponse.redirect(new URL('/mainline/shipments', request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - api (route handlers authenticate themselves — see app/api/documents)
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico / icon.png / apple-icon.png (app icon files — must load
     *   without a session so the browser tab shows the logo on the login page)
     * - tentree_logo_green.png (the login screen's own logo — the login page is
     *   by definition unauthenticated, so without this the <img> request is
     *   redirected to /login and the mark renders broken)
     */
    '/((?!api|_next/static|_next/image|favicon.ico|icon.png|apple-icon.png|tentree_logo_green.png).*)',
  ],
};
