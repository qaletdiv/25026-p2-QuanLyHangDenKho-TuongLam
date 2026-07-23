'use client';

// Error boundary for all /sms/* routes — a failed RSC fetch or render shows a
// recoverable message instead of a blank page.

import { AlertTriangle, RotateCw } from 'lucide-react';
import { Button } from '@/components/ui/button';

export default function SmsError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center py-24 px-6 text-center">
      <div className="p-4 rounded-2xl bg-red-500/10 mb-4"><AlertTriangle className="w-8 h-8 text-red-500" /></div>
      <h1 className="text-xl font-semibold text-foreground">Something went wrong</h1>
      <p className="text-sm text-muted-foreground mt-1 max-w-md">
        {error?.message || 'The page failed to load. The backend may be unavailable.'}
      </p>
      <Button className="mt-6" variant="outline" onClick={() => reset()}>
        <RotateCw className="w-4 h-4 mr-2" /> Try again
      </Button>
    </div>
  );
}
