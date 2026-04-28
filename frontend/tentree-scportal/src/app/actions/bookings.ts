'use server';

import { fetchApi } from '@/lib/api';
import { revalidatePath } from 'next/cache';
import { getShipments, createShipment, deleteShipment, bulkUpdateShipmentStatus } from './shipments';

export async function getBookings() {
  const data = await fetchApi('/bookings');
  return data || [];
}

export async function createBooking(data: any) {
  const result = await fetchApi('/bookings', {
    method: 'POST',
    body: JSON.stringify(data),
  });
  revalidatePath('/bookings');
  revalidatePath('/');
  return result;
}

export async function updateBooking(id: string, data: any) {
  // 1. Update the Booking record itself
  const result = await fetchApi(`/bookings/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });

  // 2. If a booking_status was provided, fan-out/cascade to ALL linked PO rows in Shipments.
  //    This is the top-down path: booking-level status → all PO rows.
  //    The per-PO bottom-up path (PO row → booking aggregate) is handled by the backend
  //    on PUT /shipments/:id, so we do NOT call bulkUpdateShipmentStatus here when it's
  //    a backend-triggered recalc (to avoid infinite loops). We only cascade when
  //    the update originates from the UI/Booking drawer.
  if (data.booking_number && data._cascadeToShipments && data.booking_status) {
    try {
      await bulkUpdateShipmentStatus(data.booking_number, data.booking_status);
    } catch (e) {
      console.error('Failed to cascade status to shipments:', e);
    }
  }

  revalidatePath('/bookings');
  revalidatePath('/shipments');
  revalidatePath('/');
  return result;
}

export async function deleteBooking(id: string) {
  // 1. Find the booking to get its booking_number
  const bookings = await getBookings();
  const bookingToDelete = bookings.find((b: any) => b.id === id);

  // 2. Delete ALL linked PO shipment rows (fan-out — there may be N rows per booking)
  if (bookingToDelete?.booking_number) {
    const shipments = await getShipments();
    const linkedShipments = shipments.filter((s: any) => s.booking_number === bookingToDelete.booking_number);
    for (const s of linkedShipments) {
      await deleteShipment(s.id);
    }
  }

  // 3. Delete the booking itself
  const result = await fetchApi(`/bookings/${id}`, {
    method: 'DELETE',
  });

  revalidatePath('/bookings');
  revalidatePath('/shipments');
  revalidatePath('/');
  return result;
}
