import { Suspense } from 'react';
import FreightsClient from '@/components/freights/FreightsClient';
import { getFreightRecords } from '@/app/actions/freights';

export default async function FreightsPage() {
  let initialRecords: any[] = [];
  try {
    initialRecords = await getFreightRecords();
  } catch {}

  return (
    <Suspense>
      <FreightsClient initialRecords={initialRecords} />
    </Suspense>
  );
}
