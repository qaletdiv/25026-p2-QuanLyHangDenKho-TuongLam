// Shared route-state fallbacks for the mainline/SMS pages: list, detail and
// report loading skeletons plus a not-found card. Pure presentational
// (server-safe) — each route's loading.tsx / not-found.tsx is a thin wrapper.
//
// The skeletons deliberately MIRROR the shell they stand in for, box for box:
// same paddings (DataTable is `p-4 md:p-6`, details are `p-4 md:p-6` + the same
// max-width AND mx-auto), same card chrome (Card = rounded-xl bg-card py-4
// ring-1), same row metrics (TableHead h-10, TableCell p-2 around a 20px line),
// the ModuleTabs strip the list pages render above the table, and the
// pagination footer below it. Anything the skeleton gets wrong is cumulative
// layout shift the moment the real data lands — a skeleton that is only roughly
// the right shape moves the page more than no skeleton at all.

import Link from 'next/link';
import { PackageX, ArrowLeft } from 'lucide-react';
import { cn } from '@/lib/utils';

const bar = 'rounded bg-muted';
const dimBar = 'rounded bg-muted/70';

// The Mainline | SMS (or Reports/Forecast) tab strip: px-4 py-2 around a
// text-sm label → a 36px row over a 1px border.
function TabStripSkeleton() {
  return (
    <div className="flex gap-1 border-b border-border">
      {['w-16', 'w-10'].map((w) => (
        <div key={w} className="px-4 py-2"><div className={cn('h-5', w, bar)} /></div>
      ))}
    </div>
  );
}

/**
 * Stand-in for a DataTable list page.
 * @param tabs   list routes render <ModuleTabs> in `px-6 pt-6` above the table;
 *               pass false where a layout already renders the strip (it stays
 *               mounted across the loading boundary, so drawing it twice shifts).
 * @param rows   match the page's DataTable `pageSize` so the card is the same height.
 * @param title  true when the page's DataTable gets a `title` (only mainline
 *               Bookings does) — the h1 adds 20px above the row-count line.
 */
export function ListSkeleton({
  tabs = true, rows = 10, title = false,
}: { tabs?: boolean; rows?: number; title?: boolean }) {
  return (
    <div aria-hidden className="animate-pulse">
      {tabs && <div className="px-6 pt-6"><TabStripSkeleton /></div>}

      <div className="p-4 md:p-6 space-y-4">
        {/* header: row count on the left, toolbar + column picker + search right */}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="shrink-0">
            {title && <div className={cn('h-8 w-40', bar)} />}
            <div className={cn('h-5 w-28', dimBar)} />
          </div>
          <div className="flex flex-wrap items-center gap-2 sm:flex-nowrap">
            <div className={cn('h-8 w-24', bar)} />
            <div className={cn('h-8 w-28', bar)} />
            <div className={cn('h-8 w-full sm:w-64', bar)} />
          </div>
        </div>

        {/* the Card-wrapped table: py-4 chrome, a h-10 head row, p-2 body rows */}
        <div className="overflow-hidden rounded-xl bg-card py-4 ring-1 ring-foreground/10">
          <div className="flex h-10 items-center gap-6 border-b border-border px-2">
            {['w-20', 'w-28', 'w-16', 'w-14'].map((w) => <div key={w} className={cn('h-4', w, dimBar)} />)}
            <div className={cn('h-4 w-12 ml-auto', dimBar)} />
          </div>
          {Array.from({ length: rows }).map((_, i) => (
            <div key={i} className="flex items-center gap-6 border-b border-border px-2 py-2 last:border-b-0">
              <div className={cn('h-5 w-24', bar)} />
              <div className={cn('h-5 w-32', dimBar)} />
              <div className={cn('h-5 w-20', dimBar)} />
              <div className={cn('h-5 w-16', dimBar)} />
              <div className={cn('h-5 w-14 ml-auto', dimBar)} />
            </div>
          ))}
        </div>

        {/* pagination footer (rendered whenever there are rows) */}
        <div className="flex items-center justify-between">
          <div className={cn('h-5 w-40', dimBar)} />
          <div className="flex items-center gap-2">
            <div className={cn('h-7 w-20', bar)} />
            <div className={cn('h-5 w-24', dimBar)} />
            <div className={cn('h-7 w-20', bar)} />
          </div>
        </div>
      </div>
    </div>
  );
}

// Detail shells differ only in their max-width — pass the one the real page uses
// (`mx-auto` centring included, or the skeleton starts left and the content jumps).
const DETAIL_WIDTH = { '4xl': 'max-w-4xl mx-auto', '5xl': 'max-w-5xl mx-auto', full: '' } as const;

export function DetailSkeleton({
  width = '5xl', sections = 3,
}: { width?: keyof typeof DETAIL_WIDTH; sections?: number }) {
  return (
    <div aria-hidden className={cn('p-4 md:p-6 space-y-6 animate-pulse', DETAIL_WIDTH[width])}>
      {/* back link (text-sm + mb-3), then the title row with its action buttons */}
      <div>
        <div className={cn('h-5 w-28 mb-3', dimBar)} />
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className={cn('h-8 w-56', bar)} />
          <div className="flex flex-wrap items-center gap-2">
            <div className={cn('h-7 w-24', bar)} />
            <div className={cn('h-7 w-20', bar)} />
          </div>
        </div>
      </div>

      {/* <section className="space-y-2"><h2 text-sm/><Card className="p-4 space-y-4"> */}
      {Array.from({ length: sections }).map((_, i) => (
        <div key={i} className="space-y-2">
          <div className={cn('h-5 w-28', dimBar)} />
          <div className="rounded-xl bg-card p-4 space-y-4 ring-1 ring-foreground/10">
            {[0, 1].map((r) => (
              <div key={r} className="grid grid-cols-2 gap-4 md:grid-cols-4">
                {Array.from({ length: 4 }).map((_, j) => (
                  <div key={j} className="space-y-1">
                    <div className={cn('h-4 w-20', dimBar)} />
                    <div className={cn('h-5 w-28', bar)} />
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Stand-in for the KPI/forecast pages (reports/*, forecast/*), which are NOT
 * DataTable lists: tab strip → primary hero header → stat tiles → panels.
 *
 * The hero grows with its copy and the stat row is 4-up on the forecasts but
 * 5-up on the SMS report, so both are props — measured against the live pages
 * at 1440px, these land the first panel within ~25px of where it really sits
 * (it used to be a table skeleton, i.e. hundreds of px out).
 * @param heroLines subtitle lines under the hero title (mainline KPI has 4)
 * @param cards     stat tiles between hero and panels; 0 = none (reports/mainline)
 */
export function ReportSkeleton({
  heroLines = 1, cards = 0, cardCols = 4, panels = 2,
}: { heroLines?: number; cards?: number; cardCols?: 4 | 5; panels?: number }) {
  return (
    <div aria-hidden className="flex h-full min-h-screen bg-background animate-pulse">
      <div className="flex-1 overflow-y-auto p-4 md:p-6 space-y-6">
        <TabStripSkeleton />

        {/* hero header — same rounded-2xl bg-primary block, 48px icon tile */}
        <div className="flex flex-col gap-4 md:flex-row md:items-center rounded-2xl border border-primary/50 bg-primary px-4 py-4 sm:px-6 sm:py-5">
          <div className="h-12 w-12 shrink-0 self-start rounded-xl bg-primary-foreground/15" />
          <div className="space-y-2">
            <div className="h-7 w-56 rounded bg-primary-foreground/20" />
            {Array.from({ length: heroLines }).map((_, i) => (
              <div key={i} className="h-4 rounded bg-primary-foreground/15" style={{ width: `${18 - i * 2}rem` }} />
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-3 md:ml-auto">
            <div className="h-9 w-28 rounded-lg bg-primary-foreground/15" />
            <div className="h-9 w-32 rounded-xl bg-primary-foreground/20" />
          </div>
        </div>

        {cards > 0 && (
          <div className={cn('grid grid-cols-2 gap-4', cardCols === 5 ? 'md:grid-cols-5' : 'md:grid-cols-4')}>
            {Array.from({ length: cards }).map((_, i) => (
              <div key={i} className="h-26 rounded-2xl border border-border bg-card px-5 py-4 space-y-2">
                <div className={cn('h-4 w-24', dimBar)} />
                <div className={cn('h-8 w-20', bar)} />
              </div>
            ))}
          </div>
        )}

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          {Array.from({ length: panels }).map((_, i) => (
            <div key={i} className="overflow-hidden rounded-2xl border border-border bg-card">
              <div className="px-6 pt-5 pb-3 space-y-2">
                <div className={cn('h-5 w-40', bar)} />
                <div className={cn('h-4 w-28', dimBar)} />
              </div>
              <div className="h-64 bg-muted/40" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function NotFoundCard({ noun, backHref, backLabel }: { noun: string; backHref: string; backLabel: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-24 px-6 text-center">
      <div className="p-4 rounded-2xl bg-muted mb-4"><PackageX className="w-8 h-8 text-muted-foreground" /></div>
      <h1 className="text-xl font-semibold text-foreground">{noun} not found</h1>
      <p className="text-sm text-muted-foreground mt-1 max-w-md">
        It may have been deleted, or the link is out of date.
      </p>
      <Link href={backHref} className="mt-6 inline-flex items-center gap-2 text-sm font-medium text-primary hover:underline">
        <ArrowLeft className="w-4 h-4" /> {backLabel}
      </Link>
    </div>
  );
}
