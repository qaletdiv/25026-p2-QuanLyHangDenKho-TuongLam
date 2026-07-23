import { Coins } from 'lucide-react';
import LandedCostsTabs from './LandedCostsTabs';

// Shared shell for the Landed Costs section: heading + SMS | Mainline tab strip.
// The heading/tabs are padded here; each tab's content brings its own padding
// (the SMS DataTable self-pads) so the table isn't double-inset.
export default function LandedCostsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="max-w-6xl mx-auto">
      <div className="px-4 md:px-6 pt-4 md:pt-6 space-y-3">
        <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
          <Coins className="w-6 h-6 text-primary" /> Landed Costs
        </h1>
        <LandedCostsTabs />
      </div>
      {children}
    </div>
  );
}
