// GET /api/version — which build is serving right now. The VersionWatcher in the
// root layout compares it with the build the open tab was rendered by
// (NEXT_PUBLIC_DEPLOYMENT_ID, inlined into its bundle) and prompts a
// reload when they differ, BEFORE a stale tab's Save hits an unknown Server Action.
// Public on purpose (/api skips the proxy gate): it returns only the build id.
export const dynamic = 'force-dynamic';

export function GET() {
  return Response.json(
    { deploymentId: process.env.NEXT_DEPLOYMENT_ID || null },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
