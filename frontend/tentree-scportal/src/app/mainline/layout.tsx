import { Suspense } from 'react';

// Wraps all /mainline/* surfaces. Post-cutover the sidebar provides section nav
// (Purchase Orders / Bookings / Shipments), so no redundant sub-nav here.
export default function MainlineLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto">
        <Suspense fallback={<div className="p-6 text-sm text-muted-foreground italic">Loading...</div>}>
          {children}
        </Suspense>
      </div>
    </div>
  );
}
