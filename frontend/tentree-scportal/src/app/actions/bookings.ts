'use server';

import { fetchApi } from '@/lib/api';
import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

export async function getBookings() {
  const data = await fetchApi('/bookings');
  return data || [];
}

export async function getBooking(id: string) {
  const data = await fetchApi(`/bookings/${id}`);
  if (!data || data.error) return null;
  return data;
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

  // fetchApi returns { error: "Conflict: <json>" } for 409 responses.
  // Detect an overbook_warning payload and pass it through as a structured object
  // so BookingForm can show a warning dialog instead of treating it as a hard error.
  if (result?.error) {
    const msg: string = result.error;
    const jsonStart = msg.indexOf('{');
    if (jsonStart !== -1) {
      try {
        const parsed = JSON.parse(msg.slice(jsonStart));
        if (parsed.overbook_warning) return parsed;
      } catch {}
    }
    return result;
  }

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

  // If the token was invalid/expired, clear cookies and force re-login
  if ((result as any)?.error?.includes('Unauthorized') || (result as any)?.error?.includes('401')) {
    const cookieStore = await cookies();
    cookieStore.delete('auth_token');
    cookieStore.delete('session');
    redirect('/login');
  }

  //    The per-PO bottom-up path (PO row → booking aggregate) is handled by the backend
  //    on PUT /shipments/:id. The top-down path (Booking → Shipments) is now also handled 
  //    by the backend inside PUT /bookings/:id when _cascadeToShipments is true.

  revalidatePath('/bookings');
  revalidatePath('/shipments');
  revalidatePath('/');
  return result;
}

export async function deleteBooking(id: string) {
  // Delete ALL linked PO shipment rows (fan-out) is handled entirely by the backend
  // inside DELETE /bookings/:id
  const result = await fetchApi(`/bookings/${id}`, {
    method: 'DELETE',
  });

  revalidatePath('/bookings');
  revalidatePath('/shipments');
  revalidatePath('/');
  return result;
}
