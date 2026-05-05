'use server';

import { fetchApi } from '@/lib/api';
import { revalidatePath } from 'next/cache';

export async function getShipments() {
  const data = await fetchApi('/shipments');
  return data || [];
}

export async function createShipment(data: any) {
  // Lot number is now calculated in the backend.

  const result = await fetchApi('/shipments', {
    method: 'POST',
    body: JSON.stringify(data),
  });
  revalidatePath('/shipments');
  revalidatePath('/');
  return result;
}

export async function updateShipment(id: string, data: any) {
  // Update the PO row. The backend PUT /shipments/:id handler automatically
  // recalculates the aggregate booking_status across all PO rows sharing
  // this booking_number and writes it back to bookings.json.
  const result = await fetchApi(`/shipments/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
  revalidatePath('/shipments');
  revalidatePath('/bookings');
  revalidatePath('/');
  return result;
}

export async function deleteShipment(id: string) {
  const result = await fetchApi(`/shipments/${id}`, {
    method: 'DELETE',
  });
  revalidatePath('/shipments');
  revalidatePath('/');
  return result;
}

/**
 * Bulk-update ALL PO rows in a booking to the same status at once.
 * The backend recalculates and persists the aggregate booking_status.
 */
export async function bulkUpdateShipmentStatus(bookingNumber: string, status: string) {
  const result = await fetchApi('/shipments/bulk-status', {
    method: 'POST',
    body: JSON.stringify({ booking_number: bookingNumber, status }),
  });
  revalidatePath('/shipments');
  revalidatePath('/bookings');
  revalidatePath('/');
  return result;
}
