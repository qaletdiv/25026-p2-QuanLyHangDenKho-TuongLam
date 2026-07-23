import { redirect } from 'next/navigation';

// SMS is the only built module today, so /landed-costs lands on the SMS tab.
export default function LandedCostsPage() {
  redirect('/landed-costs/sms');
}
