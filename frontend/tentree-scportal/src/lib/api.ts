import { getAuthToken } from '@/app/actions/auth';

export const BACKEND_URL = process.env.NEXT_PUBLIC_API_URL || 'http://127.0.0.1:5000';

export async function fetchApi(endpoint: string, options: RequestInit = {}) {
  const url = `${BACKEND_URL}${endpoint}`;
  try {
    const isFormData = options.body instanceof FormData;
    const token = await getAuthToken();

    const headers: Record<string, string> = { ...(options.headers as Record<string, string>) };

    // Only set Content-Type for non-multipart requests
    if (!isFormData && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }

    // Always attach JWT if available
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const response = await fetch(url, {
      cache: 'no-store',
      ...options,
      headers,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`${response.statusText || response.status}: ${text}`);
    }

    // Handle 204 No Content (e.g. DELETE responses)
    if (response.status === 204 || response.headers.get('content-length') === '0') {
      return true;
    }

    const contentType = response.headers.get("content-type");
    if (!contentType || !contentType.includes("application/json")) {
      return true;
    }

    return response.json();
  } catch (err: any) {
    // Re-throw Next.js internals (redirect, not-found) — they must propagate, not be swallowed
    if (err?.digest) throw err;
    console.error('fetchApi error:', err);
    return { error: err.message || 'Unknown network error' };
  }
}
