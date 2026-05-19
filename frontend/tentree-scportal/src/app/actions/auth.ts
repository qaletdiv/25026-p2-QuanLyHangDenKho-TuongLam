'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

const BACKEND_URL = process.env.NEXT_PUBLIC_API_URL || 'http://127.0.0.1:5000';

export async function login(formData: any) {
  const { email, password } = formData;

  try {
    const response = await fetch(`${BACKEND_URL}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
      cache: 'no-store'
    });

    if (!response.ok) {
      return { error: 'Invalid email or password' };
    }

    const data = await response.json();

    // Extract JWT token from response, keep the rest as the user object
    const { token, ...user } = data;

    const cookieStore = await cookies();

    // Store JWT token in a separate httpOnly cookie
    if (token) {
      cookieStore.set('auth_token', token, {
        httpOnly: true,
        path: '/',
        maxAge: 86400, // 24 hours — matches JWT expiry
        sameSite: 'lax',
        secure: false // Local dev friendly
      });
    }

    // Store user session — maxAge matches JWT expiry (24h) so session and token expire together
    cookieStore.set('session', JSON.stringify({ ...user, token: token ?? null }), {
      httpOnly: true, // Server-only, accessed via SessionProvider
      secure: false, // Local dev friendly
      maxAge: 86400, // 24 hours — matches JWT expiry in authController
      path: '/',
      sameSite: 'lax'
    });

    return { success: true, user };
  } catch {
    return { error: 'Failed to connect to the server. Please ensure the backend is running.' };
  }
}

export async function logout() {
  const cookieStore = await cookies();
  cookieStore.delete('session');
  cookieStore.delete('auth_token');
  redirect('/login');
}

export async function getSession() {
  try {
    const cookieStore = await cookies();
    const session = cookieStore.get('session');
    if (!session) return null;
    const { token: _token, ...user } = JSON.parse(session.value);
    return user;
  } catch (e) {
    return null;
  }
}

export async function getAuthToken(): Promise<string | null> {
  const cookieStore = await cookies();
  // Primary: dedicated auth_token cookie
  const dedicated = cookieStore.get('auth_token')?.value;
  if (dedicated) return dedicated;
  // Fallback: token embedded in session (set by newer login flow)
  try {
    const sessionRaw = cookieStore.get('session')?.value;
    if (sessionRaw) {
      const parsed = JSON.parse(sessionRaw);
      if (parsed?.token) return parsed.token;
    }
  } catch {
    // ignore malformed session
  }
  return null;
}
