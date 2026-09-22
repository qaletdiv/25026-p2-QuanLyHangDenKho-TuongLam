import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactCompiler: true,
  devIndicators: false,
  experimental: {
    serverActions: {
      bodySizeLimit: '20mb',
    },
  },

  // ---------------------------------------------------------------------------
  // Section index routes. These used to be `redirect()` calls in a page.tsx, and
  // /landed-costs threw "Rendered more hooks than during the previous render" on
  // every visit.
  //
  // WHY: /landed-costs has a sibling loading.tsx, so its page renders inside a
  // Suspense boundary — a STREAMING context. Per the redirect() docs: "When used
  // in a streaming context, this will insert a meta tag to emit the redirect on
  // the client side." So instead of an HTTP redirect the browser got a
  // client-side one, and re-running the client Router against an already-mounted
  // tree changed its internal hook count. The same page with no loading.tsx
  // (/reports, /settings, /mainline, /invoices) gets a plain 307 and is fine —
  // which is why this was the only route affected.
  //
  // The docs' own prescription: "If you'd like to redirect before the render
  // process, use next.config.js or Proxy." Here the redirect is resolved before
  // React is involved at all, so there is no render to be inconsistent.
  //
  // This runs BEFORE src/proxy.ts (execution order: next.config redirects are
  // step 2, Proxy is step 3), so the DESTINATION still passes through the
  // permission gate — /landed-costs/sms is covered by the '/landed-costs' prefix
  // in lib/pageAccess.ts. No route is exposed by moving the redirect here.
  //
  // `permanent: false` (307) on purpose: which tab is the default is a product
  // decision that will change when Mainline landed costs ship, and a 308 would
  // be cached by browsers long after.
  // ---------------------------------------------------------------------------
  async redirects() {
    return [
      { source: '/landed-costs', destination: '/landed-costs/sms', permanent: false },
    ];
  },
};

export default nextConfig;
