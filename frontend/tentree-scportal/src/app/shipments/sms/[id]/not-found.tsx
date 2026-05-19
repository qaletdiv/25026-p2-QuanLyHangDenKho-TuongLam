import Link from 'next/link';
import { FileX, ArrowLeft } from 'lucide-react';

export default function SmsShipmentNotFound() {
  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4 text-center px-6">
      <div className="w-16 h-16 rounded-2xl bg-muted flex items-center justify-center">
        <FileX className="w-8 h-8 text-muted-foreground" />
      </div>
      <div className="space-y-1">
        <h2 className="text-xl font-bold">Shipment not found</h2>
        <p className="text-sm text-muted-foreground">This shipment may have been deleted or the ID is incorrect.</p>
      </div>
      <Link href="/shipments/sms" className="inline-flex items-center gap-2 text-sm font-medium text-primary hover:underline">
        <ArrowLeft className="w-4 h-4" /> Back to SMS
      </Link>
    </div>
  );
}
