import { redirect } from 'next/navigation';

export default function BookingsPage() {
  redirect('/bookings/pending');
}
