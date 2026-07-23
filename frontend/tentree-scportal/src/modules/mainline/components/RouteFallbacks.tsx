// Shared route-state fallbacks for the mainline pages: list/detail loading
// skeletons and a not-found card. Pure presentational (server-safe) — each
// route's loading.tsx / not-found.tsx is a thin wrapper around these.

import Link from 'next/link';
import { PackageX, ArrowLeft } from 'lucide-react';

export function ListSkeleton() {
  return (
    <div className="p-6 space-y-4 animate-pulse">
      <div className="flex items-center justify-between gap-4">
        <div className="space-y-2">
          <div className="h-8 w-56 rounded-md bg-muted" />
          <div className="h-4 w-32 rounded-md bg-muted/70" />
        </div>
        <div className="flex items-center gap-2">
          <div className="h-9 w-28 rounded-md bg-muted" />
          <div className="h-9 w-64 rounded-md bg-muted" />
        </div>
      </div>
      <div className="rounded-xl border border-border overflow-hidden">
        <div className="h-10 bg-muted/50" />
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="h-12 border-t border-border bg-card flex items-center gap-6 px-4">
            <div className="h-4 w-24 rounded bg-muted" />
            <div className="h-4 w-40 rounded bg-muted/70" />
            <div className="h-4 w-28 rounded bg-muted/70" />
            <div className="h-4 w-20 rounded bg-muted/70 ml-auto" />
          </div>
        ))}
      </div>
    </div>
  );
}

export function DetailSkeleton() {
  return (
    <div className="p-6 space-y-6 animate-pulse max-w-5xl">
      <div className="h-5 w-40 rounded-md bg-muted" />
      <div className="flex items-start gap-4">
        <div className="w-11 h-11 rounded-xl bg-muted shrink-0" />
        <div className="space-y-2">
          <div className="h-7 w-48 rounded-md bg-muted" />
          <div className="h-4 w-64 rounded-md bg-muted/70" />
        </div>
      </div>
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="rounded-xl border border-border p-5 space-y-3">
          <div className="h-5 w-36 rounded-md bg-muted" />
          <div className="grid grid-cols-3 gap-4">
            {Array.from({ length: 6 }).map((_, j) => (
              <div key={j} className="space-y-1.5">
                <div className="h-3 w-20 rounded bg-muted/70" />
                <div className="h-4 w-28 rounded bg-muted" />
              </div>
            ))}
          </div>
        </div>
      ))}
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
