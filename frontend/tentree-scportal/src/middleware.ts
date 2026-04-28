import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export function middleware(request: NextRequest) {
  const session = request.cookies.get('session');
  const { pathname } = request.nextUrl;

  // 1. If no session and trying to access protected routes
  if (!session && pathname !== '/login' && !pathname.startsWith('/api')) {
    return NextResponse.redirect(new URL('/login', request.url));
  }

  // 2. If session exists and trying to access login page
  if (session && pathname === '/login') {
    return NextResponse.redirect(new URL('/shipments', request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - api (API routes)
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     */
    '/((?!api|_next/static|_next/image|favicon.ico).*)',
  ],
};
