'use client';

// Shared toolbar filter for lifecycle tables (bookings, shipments): a Season
// dropdown (defaults to the current/newest season) + an Active/All scope toggle
// that hides fully-completed records by default. Records persist forever; this is
// a default VIEW, not deletion or an access rule.

import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select';

export type Scope = 'active' | 'all';

// "SS27" → sortable number (year, then SS before FW) so seasons list newest-first.
export function seasonRank(code: string) {
  const m = String(code || '').match(/^([A-Za-z]+)\s*(\d+)$/);
  if (!m) return -1;
  return Number(m[2]) * 2 + (m[1].toUpperCase() === 'FW' ? 1 : 0);
}

// Distinct season codes from a row set, newest-first. A row's `season` may be a
// comma-joined list (rare multi-season record) — split so each appears once.
export function seasonsFrom<T extends { season?: string | null }>(rows: T[]): string[] {
  const set = new Set<string>();
  rows.forEach((r) => String(r.season || '').split(',').map((s) => s.trim()).filter(Boolean).forEach((s) => set.add(s)));
  return [...set].sort((a, b) => seasonRank(b) - seasonRank(a));
}

// Filter rows by season + scope. `isCompleted` marks a row as done (hidden when
// scope='active'). A multi-season row matches if ANY of its seasons matches.
export function applySeasonScope<T extends { season?: string | null }>(
  rows: T[],
  { season, scope, isCompleted }: { season: string; scope: Scope; isCompleted: (r: T) => boolean },
): T[] {
  return rows.filter((r) => {
    if (scope === 'active' && isCompleted(r)) return false;
    if (season === 'all') return true;
    return String(r.season || '').split(',').map((s) => s.trim()).includes(season);
  });
}

export function SeasonScopeFilter({ season, seasons, onSeason, scope, onScope, activeLabel = 'Active' }: {
  season: string;
  seasons: string[];
  onSeason: (v: string) => void;
  scope: Scope;
  onScope: (v: Scope) => void;
  activeLabel?: string;
}) {
  return (
    <>
      <Select value={season} onValueChange={(v) => v && onSeason(v)}>
        {/* label rendered directly — Base UI shows the raw value otherwise */}
        <SelectTrigger className="w-32 h-9">{season === 'all' ? 'All Seasons' : season}</SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All Seasons</SelectItem>
          {seasons.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
        </SelectContent>
      </Select>
      <Select value={scope} onValueChange={(v) => v && onScope(v as Scope)}>
        <SelectTrigger className="w-32 h-9">{scope === 'active' ? activeLabel : 'All Records'}</SelectTrigger>
        <SelectContent>
          <SelectItem value="active">{activeLabel}</SelectItem>
          <SelectItem value="all">All Records</SelectItem>
        </SelectContent>
      </Select>
    </>
  );
}
