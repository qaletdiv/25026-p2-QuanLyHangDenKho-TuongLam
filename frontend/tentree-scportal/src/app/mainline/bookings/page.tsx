import { getMainlineBookings, getPoMasters, getPoLegs, getCarriers } from '@/modules/mainline/actions';
import BookingsTable from '@/modules/mainline/components/BookingsTable';
import ModuleTabs, { BOOKING_TABS } from '@/components/layout/ModuleTabs';

// Mainline bookings — list + create (single or multi-PO, same vendor) + approve + delete.
// ?new=<supplier_id> (from "Book Now" on the PO masters table) opens the create
// dialog with that supplier preselected.
export default async function MainlineBookingsPage({ searchParams }: { searchParams: Promise<{ new?: string }> }) {
  const [{ new: newSupplier }, bookings, masters, legs, couriers] = await Promise.all([
    searchParams, getMainlineBookings(), getPoMasters(), getPoLegs(), getCarriers(),
  ]);
  return (
    <div>
      <div className="px-6 pt-6"><ModuleTabs tabs={BOOKING_TABS} /></div>
      <BookingsTable bookings={bookings} masters={masters} legs={legs} couriers={couriers} initialNewSupplier={newSupplier ?? null} />
    </div>
  );
}
