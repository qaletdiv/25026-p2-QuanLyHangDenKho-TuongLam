'use server';

import { fetchApi } from '@/lib/api';
import { revalidatePath } from 'next/cache';
import { getShipments, createShipment, deleteShipment, bulkUpdateShipmentStatus } from './shipments';

export async function getBookings() {
  const data = await fetchApi('/bookings');
  return data || [];
}

export async function getHistoryBookings() {
  const data = await fetchApi('/history-bookings');
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

  //    The per-PO bottom-up path (PO row → booking aggregate) is handled by the backend
  //    on PUT /shipments/:id. The top-down path (Booking → Shipments) is now also handled 
  //    by the backend inside PUT /bookings/:id when _cascadeToShipments is true.

  revalidatePath('/bookings');
  revalidatePath('/shipments');
  revalidatePath('/');
  return result;
}

export async function deleteBooking(id: string) {
  // 1. Find the booking to get its booking_number
  const bookings = await getBookings();
  const bookingToDelete = bookings.find((b: any) => b.id === id);

  // 2. Delete ALL linked PO shipment rows (fan-out) is now handled entirely by the backend
  //    inside DELETE /bookings/:id

  // 3. Delete the booking itself
  const result = await fetchApi(`/bookings/${id}`, {
    method: 'DELETE',
  });

  revalidatePath('/bookings');
  revalidatePath('/shipments');
  revalidatePath('/');
  return result;
}
