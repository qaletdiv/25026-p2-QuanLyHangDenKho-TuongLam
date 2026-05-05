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

    const user = await response.json();

    // Store user session in a cookie
    const cookieStore = await cookies();
    cookieStore.set('session', JSON.stringify(user), {
      httpOnly: true, // Server-only, accessed via SessionProvider
      secure: false, // Local dev friendly
      maxAge: 60 * 60 * 24 * 7, // 1 week
      path: '/',
      sameSite: 'lax'
    });

    return { success: true, user };
  } catch (error: any) {
    console.error('Login error:', error);
    return { error: 'Failed to connect to the server. Please ensure the backend is running.' };
  }
}

export async function logout() {
  const cookieStore = await cookies();
  cookieStore.delete('session');
  redirect('/login');
}

export async function getSession() {
  try {
    const cookieStore = await cookies();
    const session = cookieStore.get('session');
    if (!session) return null;
    return JSON.parse(session.value);
  } catch (e) {
    return null;
  }
}
