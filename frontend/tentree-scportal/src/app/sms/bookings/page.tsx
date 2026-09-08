import { getSmsBookings, getSmsPos, getSmsIncoterms, getSmsCouriers, getSmsModes } from '@/modules/sms/actions';
import SmsBookingsTable from '@/modules/sms/components/SmsBookingsTable';
import ModuleTabs, { BOOKING_TABS } from '@/components/layout/ModuleTabs';

// SMS bookings — the OPTIONAL authorization step (added 2026-08-07). Vendor
// submits, Logistics approves, and approval creates the draft consignment. SMS
// shipments can still be entered directly with no booking at all.
export default async function SmsBookingsPage() {
  // couriers + modes feed the new-booking form: both are stated on the booking and
  // copied onto the draft consignment at approve (they used to be hardcoded FedEx).
  const [bookings, pos, incoterms, couriers, modes] = await Promise.all([
    getSmsBookings(), getSmsPos(), getSmsIncoterms(), getSmsCouriers(), getSmsModes(),
  ]);
  return (
    <div>
      <div className="px-6 pt-6"><ModuleTabs tabs={BOOKING_TABS} /></div>
      <SmsBookingsTable bookings={bookings} pos={pos} incoterms={incoterms} couriers={couriers} modes={modes} />
    </div>
  );
}
