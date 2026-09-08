import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getAuthToken } from '@/app/actions/auth';
import { BACKEND_URL } from '@/lib/api';

// Authenticated file-download proxy.
//
// The backend's /uploads and /templates mounts now sit BELOW its auth gate, so they
// require a Bearer token. A browser tab opening a link can't send one — it only has
// the httpOnly cookie. This handler bridges that: it reads the cookie server-side,
// attaches the token, streams the file back.
//
// It also removes the last place the JWT reached browser JavaScript: the freight
// template download used to call a server action that RETURNED the token so client
// code could put it in a fetch header, which defeated the point of httpOnly (any XSS
// could read it). Now the token never leaves the server.
//
// Usage: /api/documents?path=/uploads/asn_123_BKG-1.xlsx
//
// This route is excluded from proxy.ts's matcher (it skips /api), so it authenticates
// itself — an unauthenticated caller gets 401 here, not a redirect.

// Only these are proxied. Everything else is refused, so this can't be turned into a
// general-purpose fetcher for arbitrary backend routes.
const ALLOWED_PREFIXES = ['/uploads/', '/templates/'];
// Exact routes that stream a generated file rather than a stored one. The freight
// template has no file on disk — downloadTemplate() builds the xlsx in memory — so it
// needs an exact entry, not a prefix.
const ALLOWED_EXACT = ['/freights/template'];

export async function GET(request: NextRequest) {
  // Authenticate FIRST, before looking at ?path, so an unauthenticated caller learns
  // nothing about which paths are allowed (400) versus rejected (401).
  const token = await getAuthToken();
  if (!token) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  }

  const raw = request.nextUrl.searchParams.get('path');
  if (!raw) {
    return NextResponse.json({ error: 'Missing ?path' }, { status: 400 });
  }

  // Reject traversal and absolute/protocol-relative targets BEFORE normalising, so a
  // crafted path can't escape the allowed prefixes and read something else — or point
  // at an entirely different host.
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return NextResponse.json({ error: 'Malformed path' }, { status: 400 });
  }
  if (
    decoded.includes('..') ||
    decoded.includes('\\') ||
    decoded.includes('\0') ||
    decoded.startsWith('//') ||
    /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(decoded)          // any scheme, e.g. http:, file:
  ) {
    return NextResponse.json({ error: 'Invalid path' }, { status: 400 });
  }
  const allowed = ALLOWED_PREFIXES.some((p) => decoded.startsWith(p))
    || ALLOWED_EXACT.includes(decoded);
  if (!allowed) {
    return NextResponse.json({ error: 'Path not allowed' }, { status: 400 });
  }

  const upstream = await fetch(`${BACKEND_URL}${decoded}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });

  if (!upstream.ok || !upstream.body) {
    return NextResponse.json(
      { error: `Download failed (${upstream.status})` },
      { status: upstream.status === 404 ? 404 : 502 },
    );
  }

  // Stream rather than buffer — these are spreadsheets and can be large.
  const filename = decoded.split('/').pop() || 'download';
  const headers = new Headers();
  headers.set(
    'Content-Type',
    upstream.headers.get('content-type') || 'application/octet-stream',
  );
  const len = upstream.headers.get('content-length');
  if (len) headers.set('Content-Length', len);
  // `attachment` so a proxied file can never be rendered as a document in our origin.
  headers.set('Content-Disposition', `attachment; filename="${filename}"`);
  headers.set('Cache-Control', 'private, no-store');
  headers.set('X-Content-Type-Options', 'nosniff');

  return new NextResponse(upstream.body, { status: 200, headers });
}
