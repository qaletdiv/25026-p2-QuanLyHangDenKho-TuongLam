export default function HistoryShipmentsLoading() {
  return (
    <div className="p-6 space-y-4 animate-pulse">
      <div className="flex flex-wrap items-center gap-3">
        <div className="h-10 w-72 rounded-md bg-muted" />
        <div className="h-10 w-40 rounded-md bg-muted" />
        <div className="ml-auto h-10 w-36 rounded-md bg-muted" />
      </div>
      <div className="bg-card rounded-xl border border-border overflow-hidden shadow-sm">
        <div className="h-11 bg-muted/50 border-b border-border" />
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="flex items-center gap-4 px-4 py-3 border-b border-border last:border-0">
            <div className="h-4 w-24 rounded bg-muted/70" />
            <div className="h-4 w-32 rounded bg-muted/70" />
            <div className="h-4 w-20 rounded bg-muted/70" />
            <div className="h-4 w-28 rounded bg-muted/70" />
            <div className="ml-auto h-6 w-24 rounded-full bg-muted" />
          </div>
        ))}
      </div>
    </div>
  );
}
