export default function PurchaseOrderDetailLoading() {
  return (
    <div className="min-h-screen flex flex-col animate-pulse">

      {/* Header bar */}
      <div className="border-b border-border bg-muted/30 px-6 py-4 flex-shrink-0">
        <div className="max-w-3xl mx-auto">

          {/* Top row: back breadcrumb + action buttons */}
          <div className="flex items-center justify-between">
            <div className="h-8 w-36 rounded-md bg-muted" />
            <div className="flex gap-2">
              <div className="h-8 w-8 rounded-md bg-muted" />
              <div className="h-8 w-8 rounded-md bg-muted" />
              <div className="h-8 w-20 rounded-md bg-muted" />
            </div>
          </div>

          {/* Hero row */}
          <div className="flex items-start gap-4 mt-4">
            <div className="w-11 h-11 rounded-xl bg-muted flex-shrink-0" />
            <div className="flex-1 space-y-2">
              <div className="h-7 w-52 rounded-md bg-muted" />
              <div className="flex items-center gap-3">
                <div className="h-4 w-36 rounded-md bg-muted/70" />
                <div className="h-4 w-16 rounded-md bg-muted/70" />
                <div className="h-4 w-20 rounded-md bg-muted/70" />
              </div>
            </div>
          </div>

        </div>
      </div>

      {/* Content */}
      <div className="flex-1 py-6 px-6">
        <div className="max-w-3xl mx-auto space-y-6">

          {/* Order Details section */}
          <div className="space-y-3">
            <div className="h-4 w-28 rounded bg-muted/60" />
            <div className="bg-muted/20 p-4 rounded-xl border border-border/50 space-y-4">
              <div className="grid grid-cols-3 gap-4">
                {Array.from({ length: 3 }).map((_, i) => (
                  <div key={i} className="space-y-1.5">
                    <div className="h-3 w-16 rounded bg-muted/60" />
                    <div className="h-9 rounded-md bg-muted" />
                  </div>
                ))}
              </div>
              <div className="grid grid-cols-2 gap-4">
                {Array.from({ length: 2 }).map((_, i) => (
                  <div key={i} className="space-y-1.5">
                    <div className="h-3 w-20 rounded bg-muted/60" />
                    <div className="h-9 rounded-md bg-muted" />
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Logistics section */}
          <div className="space-y-3">
            <div className="h-4 w-36 rounded bg-muted/60" />
            <div className="bg-muted/20 p-4 rounded-xl border border-border/50 space-y-4">
              <div className="grid grid-cols-2 gap-4">
                {Array.from({ length: 2 }).map((_, i) => (
                  <div key={i} className="space-y-1.5">
                    <div className="h-3 w-24 rounded bg-muted/60" />
                    <div className="h-9 rounded-md bg-muted" />
                  </div>
                ))}
              </div>
              <div className="grid grid-cols-3 gap-4">
                {Array.from({ length: 3 }).map((_, i) => (
                  <div key={i} className="space-y-1.5">
                    <div className="h-3 w-16 rounded bg-muted/60" />
                    <div className="h-9 rounded-md bg-muted" />
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Quantities section */}
          <div className="space-y-3">
            <div className="h-4 w-24 rounded bg-muted/60" />
            <div className="bg-muted/20 p-4 rounded-xl border border-border/50 grid grid-cols-2 gap-6">
              {Array.from({ length: 2 }).map((_, i) => (
                <div key={i} className="space-y-1.5">
                  <div className="h-3 w-24 rounded bg-muted/60" />
                  <div className="h-8 w-28 rounded-md bg-muted" />
                </div>
              ))}
            </div>
          </div>

          {/* Line Items section */}
          <div className="space-y-3">
            <div className="h-4 w-24 rounded bg-muted/60" />
            <div className="rounded-lg border border-border/50 overflow-hidden">
              <div className="flex gap-4 px-3 py-2 bg-muted/30 border-b border-border/50">
                {[80, 120, 72, 48, 56, 64].map((w, i) => (
                  <div key={i} className="h-3 rounded bg-muted" style={{ width: w }} />
                ))}
              </div>
              {Array.from({ length: 4 }).map((_, row) => (
                <div key={row} className="flex gap-4 px-3 py-2.5 border-b border-border/30 last:border-0">
                  {[80, 120, 72, 48, 56, 64].map((w, i) => (
                    <div key={i} className="h-3 rounded bg-muted/70" style={{ width: w }} />
                  ))}
                </div>
              ))}
            </div>
          </div>

        </div>
      </div>

    </div>
  );
}
