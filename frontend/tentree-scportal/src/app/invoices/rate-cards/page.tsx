import { getRateCards } from '@/modules/nri-billing/actions';
import RateCardsView from '@/modules/nri-billing/components/RateCardsView';

export default async function RateCardsPage() {
  const cards = await getRateCards();
  return <RateCardsView cards={cards} />;
}
