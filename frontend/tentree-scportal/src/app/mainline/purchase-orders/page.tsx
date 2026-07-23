import { getPoLegs } from '@/modules/mainline/actions';
import PoLegsTable from '@/modules/mainline/components/PoLegsTable';
import ModuleTabs, { PO_TABS } from '@/components/layout/ModuleTabs';

// Mainline PO list (Phase 5b) — flat per-leg (PO-split) view: PO#, mode, warehouse,
// CRD, qty. TRN links to the master detail (orders/legs + three-way match).
export default async function MainlinePurchaseOrdersPage() {
  const legs = await getPoLegs();
  return (
    <div>
      <div className="px-6 pt-6"><ModuleTabs tabs={PO_TABS} /></div>
      <PoLegsTable legs={legs} />
    </div>
  );
}
