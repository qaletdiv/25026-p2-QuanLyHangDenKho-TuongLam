'use client';

// Stale-tab guard. Every deploy builds new Server Action ids, so a tab opened
// before it keeps calling the OLD ids and the server answers 404 — Save silently
// "doesn't work" (seen on the VM: POST /settings/users 200 → 404 at the deploy).
// `deploymentId` (next.config.ts) makes Next hard-reload on NAVIGATION, but not on
// a button click, so this adds two things:
//   1. on tab focus / becoming visible, and every 5 min, ask /api/version which
//      build is live; if it isn't the one this tab was rendered by, prompt;
//   2. backstop: a Server Action the server doesn't recognise (Next's
//      UnrecognizedActionError) that nobody caught also prompts.
// The prompt is a sticky toast with a Reload button — never an automatic reload,
// which would throw away whatever the user is typing.
// Inert when no deploymentId is configured (local `next dev`). The tab's own
// build id is NEXT_PUBLIC_DEPLOYMENT_ID, inlined at build time by next.config.ts
// (the data-dpl-id attribute on <html> is stripped by React on hydration).

import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { unstable_isUnrecognizedActionError } from 'next/navigation';

const CHECK_EVERY_MS = 5 * 60 * 1000;

export default function VersionWatcher() {
  const prompted = useRef(false);

  useEffect(() => {
    const mine = process.env.NEXT_PUBLIC_DEPLOYMENT_ID;

    const prompt = () => {
      if (prompted.current) return;
      prompted.current = true;
      toast('A new version of the portal is available', {
        description: 'Reload to keep working — anything not yet saved on this page will be lost.',
        duration: Infinity,
        action: { label: 'Reload', onClick: () => window.location.reload() },
      });
    };

    const check = async () => {
      if (!mine || prompted.current || document.visibilityState !== 'visible') return;
      try {
        const r = await fetch('/api/version', { cache: 'no-store' });
        if (!r.ok) return;
        const { deploymentId } = await r.json();
        if (deploymentId && deploymentId !== mine) prompt();
      } catch { /* offline or restarting — try again on the next trigger */ }
    };

    const onVisible = () => { if (document.visibilityState === 'visible') void check(); };
    const onRejection = (e: PromiseRejectionEvent) => {
      if (unstable_isUnrecognizedActionError(e.reason)) { e.preventDefault(); prompt(); }
    };

    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    window.addEventListener('unhandledrejection', onRejection);
    const timer = window.setInterval(() => void check(), CHECK_EVERY_MS);
    void check();
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
      window.removeEventListener('unhandledrejection', onRejection);
      window.clearInterval(timer);
    };
  }, []);

  return null;
}
