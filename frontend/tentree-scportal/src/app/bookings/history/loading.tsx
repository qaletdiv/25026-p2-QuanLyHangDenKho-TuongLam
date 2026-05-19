export default function HistoryBookingsLoading() {
  return (
    <div className="p-6 space-y-4 animate-pulse">
      <div className="flex gap-3">
        <div className="h-10 flex-1 max-w-sm bg-muted rounded-lg" />
        <div className="h-10 w-44 bg-muted rounded-lg" />
        <div className="ml-auto flex gap-2">
          <div className="h-10 w-24 bg-muted rounded-lg" />
          <div className="h-10 w-24 bg-muted rounded-lg" />
        </div>
      </div>
      <div className="rounded-xl border border-border overflow-hidden bg-card">
        <div className="h-10 bg-muted/50" />
        {Array.from({ length: 10 }).map((_, i) => (
          <div key={i} className="h-12 border-t border-border bg-card flex items-center px-4 gap-4">
            <div className="h-3 w-20 bg-muted rounded" />
            <div className="h-3 w-28 bg-muted rounded" />
            <div className="h-3 w-16 bg-muted/70 rounded" />
            <div className="h-3 w-24 bg-muted/70 rounded" />
            <div className="h-3 w-16 bg-muted rounded" />
          </div>
        ))}
      </div>
    </div>
  );
}
