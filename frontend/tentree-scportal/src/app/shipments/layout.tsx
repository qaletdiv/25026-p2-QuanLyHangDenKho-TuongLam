import { Suspense } from 'react';
import ShipmentsSubNav from './ShipmentsSubNav';

export default function ShipmentsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col h-full">
      <Suspense fallback={null}>
        <ShipmentsSubNav />
      </Suspense>
      <div className="flex-1 overflow-y-auto">
        <Suspense fallback={<div className="p-6 text-sm text-muted-foreground italic">Loading...</div>}>
          {children}
        </Suspense>
      </div>
    </div>
  );
}
