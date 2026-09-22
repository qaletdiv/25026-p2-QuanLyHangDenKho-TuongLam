import { Badge } from '@/components/ui/badge';
import { Clock, ShieldAlert } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { PoApprovalStatus } from '../types';

/**
 * NetSuite's sign-off state for a PO.
 *
 * An unapproved PO used to look exactly like an approved one everywhere in the
 * portal, so nobody could tell that (today) 16 of 81 POs are still waiting on a
 * supervisor.
 *
 * Approved renders as QUIET TEXT, not a pill, and not nothing. Nothing was the
 * first cut — only exceptions get ink — but an empty cell reads as "this feature
 * isn't working" (it was reported as a bug twice, once for all 88 approved FW26
 * rows). Muted text keeps the 4 amber pills the only thing that catches the eye
 * while making blank mean exactly one thing: NetSuite has no value for this PO.
 *
 * 'Rejected' can no longer reach the portal (the sync refuses it and prunes it),
 * but it renders loudly if a stale row ever surfaces — better a visible
 * contradiction than a PO quietly passing for live.
 */
export default function ApprovalBadge({
  status, className,
}: { status: PoApprovalStatus | undefined; className?: string }) {
  if (status === 'Pending Approval') {
    return (
      <Badge
        variant="outline"
        title="Not yet approved by a supervisor in NetSuite"
        className={cn('gap-1 border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400', className)}
      >
        <Clock className="h-3 w-3" /> Pending approval
      </Badge>
    );
  }
  if (status === 'Rejected') {
    return (
      <Badge
        variant="outline"
        title="Rejected in NetSuite — this PO should not be in the portal; run scripts/prune-rejected-pos.js"
        className={cn('gap-1 border-destructive/40 bg-destructive/10 text-destructive', className)}
      >
        <ShieldAlert className="h-3 w-3" /> Rejected
      </Badge>
    );
  }
  if (status === 'Approved') {
    return (
      <span
        title="Approved by a supervisor in NetSuite"
        className={cn('text-xs text-muted-foreground', className)}
      >
        Approved
      </span>
    );
  }
  return null;   // NetSuite has no value for this PO — say nothing rather than guess
}
