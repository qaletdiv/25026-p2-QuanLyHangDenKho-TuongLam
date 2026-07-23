import { getMainlineBookings, getPoMasters, getPoLegs } from '@/modules/mainline/actions';
import BookingsTable from '@/modules/mainline/components/BookingsTable';

// Mainline bookings — list + create (single or multi-PO, same vendor) + approve + delete.
// ?new=<supplier_id> (from "Book Now" on the PO masters table) opens the create
// dialog with that supplier preselected.
export default async function MainlineBookingsPage({ searchParams }: { searchParams: Promise<{ new?: string }> }) {
  const [{ new: newSupplier }, bookings, masters, legs] = await Promise.all([
    searchParams, getMainlineBookings(), getPoMasters(), getPoLegs(),
  ]);
  return <BookingsTable bookings={bookings} masters={masters} legs={legs} initialNewSupplier={newSupplier ?? null} />;
}
