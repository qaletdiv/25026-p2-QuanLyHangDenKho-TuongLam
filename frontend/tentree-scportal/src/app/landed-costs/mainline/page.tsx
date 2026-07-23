// Landed Costs — Mainline: placeholder. Freight & duty for ocean/air freight (from
// the forwarder's bill / customs entry) will be added here later. All landed-cost
// features today are SMS-only.
export default function MainlineLandedCostsPage() {
  return (
    <div className="p-4 md:p-6">
      <div className="rounded-md border border-dashed border-border py-16 text-center text-sm text-muted-foreground">
        Mainline landed costs — coming soon.
        <div className="text-xs mt-1">Freight &amp; duty for ocean/air freight shipments will be managed here.</div>
      </div>
    </div>
  );
}
