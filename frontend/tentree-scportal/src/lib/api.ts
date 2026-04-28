const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || 'http://127.0.0.1:5000';

export async function fetchApi(endpoint: string, options: RequestInit = {}) {
  const url = `${BACKEND_URL}${endpoint}`;
  try {
    const response = await fetch(url, {
      cache: 'no-store',
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
      ...options,
    });

    if (!response.ok) {
      const text = await response.text();
      console.error(`API Error on ${url}:`, text);
      throw new Error(`API Error: ${response.status} - ${text}`);
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
  } catch (err) {
    console.error(`Network error fetching ${url}:`, err);
    return null;
  }
}
