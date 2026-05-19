import Link from 'next/link';
import { ArrowLeft, PackageX } from 'lucide-react';

export default function PurchaseOrderNotFound() {
  return (
    <div className="min-h-screen flex flex-col">

      {/* Header bar — matches detail page structure */}
      <div className="border-b border-border bg-muted/30 px-6 py-4 flex-shrink-0">
        <div className="max-w-3xl mx-auto">
          <Link
            href="/purchase-orders"
            className="inline-flex items-center gap-1.5 h-8 px-2 -ml-2 text-sm text-muted-foreground hover:text-foreground rounded-md hover:bg-muted/50 transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            Purchase Orders
          </Link>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 flex items-center justify-center px-6">
        <div className="text-center space-y-4 max-w-sm">
          <div className="w-16 h-16 rounded-2xl bg-muted/50 border border-border flex items-center justify-center mx-auto">
            <PackageX className="w-8 h-8 text-muted-foreground" />
          </div>
          <div className="space-y-1.5">
            <h1 className="text-xl font-bold">Purchase Order Not Found</h1>
            <p className="text-sm text-muted-foreground">
              This PO may have been deleted or the ID is incorrect.
            </p>
          </div>
          <Link
            href="/purchase-orders"
            className="inline-flex items-center justify-center h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors"
          >
            Back to Purchase Orders
          </Link>
        </div>
      </div>

    </div>
  );
}
