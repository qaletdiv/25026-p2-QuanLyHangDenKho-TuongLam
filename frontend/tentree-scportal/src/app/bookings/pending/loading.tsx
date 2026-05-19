export default function PendingLoading() {
  return (
    <div className="p-6 space-y-4 animate-pulse">
      <div className="h-5 w-48 bg-muted rounded" />
      <div className="flex gap-3">
        <div className="h-10 flex-1 max-w-sm bg-muted rounded-lg" />
        <div className="h-10 w-44 bg-muted rounded-lg" />
      </div>
      <div className="rounded-lg border border-border overflow-hidden">
        <div className="h-10 bg-muted/50" />
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="h-12 border-t border-border bg-card flex items-center px-4 gap-4">
            <div className="h-3 w-16 bg-muted rounded" />
            <div className="h-3 w-24 bg-muted rounded" />
            <div className="h-3 w-32 bg-muted/70 rounded" />
          </div>
        ))}
      </div>
    </div>
  );
}
