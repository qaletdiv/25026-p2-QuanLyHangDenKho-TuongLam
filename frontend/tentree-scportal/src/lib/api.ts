import { getAuthToken } from '@/app/actions/auth';

export const BACKEND_URL = process.env.NEXT_PUBLIC_API_URL || 'http://127.0.0.1:5000';

/**
 * Href for a backend file (`/uploads/...`, `/templates/...`).
 *
 * Points at our own authenticated proxy, NOT at the backend. The backend's static
 * mounts now sit below its auth gate, and a browser tab cannot send a Bearer token —
 * it only has the httpOnly cookie. The route handler at /api/documents reads that
 * cookie server-side and streams the file through.
 *
 * Client components must use this instead of building `${BACKEND_URL}${file_url}`.
 */
export function docHref(fileUrl: string | null | undefined): string {
  if (!fileUrl) return '#';
  return `/api/documents?path=${encodeURIComponent(fileUrl)}`;
}

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
      // Return a structured error instead of throwing. HTTP errors (e.g. a 404
      // that a page turns into notFound()) are an expected outcome handled by
      // callers via `result.error`. Throwing here — only to catch it below and
      // console.error it — made Next.js dev surface a noisy error overlay for
      // 404s that were already handled gracefully.
      return { error: `${response.statusText || response.status}: ${text}`, status: response.status };
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
