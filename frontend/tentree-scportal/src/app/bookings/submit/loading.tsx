export default function SubmitLoading() {
  return (
    <div className="p-6 max-w-2xl mx-auto space-y-6 animate-pulse">
      <div className="h-6 w-48 bg-muted rounded" />
      <div className="space-y-4 bg-card p-4 rounded-xl border border-border">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="space-y-1.5">
            <div className="h-3 w-24 bg-muted rounded" />
            <div className="h-9 bg-muted rounded-lg" />
          </div>
        ))}
      </div>
    </div>
  );
}
