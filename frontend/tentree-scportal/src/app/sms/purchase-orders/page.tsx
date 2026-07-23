import { getSmsPos } from '@/modules/sms/actions';
import SmsPosTable from '@/modules/sms/components/SmsPosTable';
import ModuleTabs, { PO_TABS } from '@/components/layout/ModuleTabs';

// SMS purchase orders — NetSuite-sourced (custbody_tt_po_type='smm'), own
// dataset (sms_pos). List defaults to the newest season with open POs.
export default async function SmsPurchaseOrdersPage() {
  const pos = await getSmsPos();
  return (
    <div>
      <div className="px-6 pt-6"><ModuleTabs tabs={PO_TABS} /></div>
      <SmsPosTable pos={pos} />
    </div>
  );
}
