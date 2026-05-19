export default function PurchaseOrdersLoading() {
  return (
    <div className="p-6 space-y-6 animate-pulse">

      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="space-y-2">
          <div className="h-6 w-44 rounded-md bg-muted" />
          <div className="h-4 w-72 rounded-md bg-muted/60" />
        </div>
        <div className="flex gap-2">
          <div className="h-9 w-24 rounded-md bg-muted" />
          <div className="h-9 w-32 rounded-md bg-muted" />
          <div className="h-9 w-28 rounded-md bg-muted" />
          <div className="h-9 w-24 rounded-md bg-muted" />
        </div>
      </div>

      {/* Filter bar */}
      <div className="flex gap-3">
        <div className="h-10 flex-1 max-w-sm rounded-md bg-muted" />
        <div className="h-10 w-36 rounded-md bg-muted" />
        <div className="h-10 w-36 rounded-md bg-muted" />
        <div className="ml-auto h-10 w-24 rounded-md bg-muted" />
      </div>

      {/* Table */}
      <div className="rounded-xl border border-border overflow-hidden">
        {/* Table header */}
        <div className="flex gap-4 px-4 py-3 bg-muted/50 border-b border-border">
          {[80, 72, 56, 96, 120, 72, 72, 64, 64, 96, 72, 96].map((w, i) => (
            <div key={i} className="h-4 rounded bg-muted" style={{ width: w }} />
          ))}
        </div>
        {/* Rows */}
        {Array.from({ length: 10 }).map((_, row) => (
          <div key={row} className="flex gap-4 px-4 py-3.5 border-b border-border/50 last:border-0">
            {[80, 72, 56, 96, 120, 72, 72, 64, 64, 96, 72, 96].map((w, i) => (
              <div
                key={i}
                className="h-3.5 rounded bg-muted/70"
                style={{ width: row % 3 === 0 && i > 6 ? w * 0.6 : w }}
              />
            ))}
          </div>
        ))}
      </div>

    </div>
  );
}
