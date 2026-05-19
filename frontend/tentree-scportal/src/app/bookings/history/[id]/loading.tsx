export default function HistoryBookingDetailLoading() {
  return (
    <div className="min-h-screen flex flex-col animate-pulse">
      <div className="border-b border-border bg-muted/30 px-6 py-4 flex-shrink-0">
        <div className="max-w-3xl mx-auto">
          <div className="flex items-center justify-between">
            <div className="h-8 w-36 rounded-md bg-muted" />
            <div className="flex gap-2">
              <div className="h-8 w-8 rounded-md bg-muted" />
              <div className="h-8 w-8 rounded-md bg-muted" />
              <div className="h-8 w-16 rounded-md bg-muted" />
            </div>
          </div>
          <div className="flex items-start gap-4 mt-4">
            <div className="w-11 h-11 rounded-xl bg-muted flex-shrink-0" />
            <div className="flex-1 space-y-2">
              <div className="h-7 w-48 rounded-md bg-muted" />
              <div className="flex items-center gap-3">
                <div className="h-4 w-36 rounded-md bg-muted/70" />
                <div className="h-4 w-24 rounded-md bg-muted/70" />
              </div>
            </div>
          </div>
        </div>
      </div>
      <div className="flex-1 py-6 px-6">
        <div className="max-w-3xl mx-auto space-y-6">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="space-y-3">
              <div className="h-4 w-32 rounded bg-muted/60" />
              <div className="bg-card p-4 rounded-xl border border-border shadow-sm space-y-4">
                {Array.from({ length: 3 }).map((_, j) => (
                  <div key={j} className="space-y-1.5">
                    <div className="h-3 w-20 rounded bg-muted/60" />
                    <div className="h-9 rounded-md bg-muted" />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
