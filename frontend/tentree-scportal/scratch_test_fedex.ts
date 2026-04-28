import { trackFedexShipment } from './src/app/actions/fedex.ts';

async function test() {
  const numbers = ['123456789012', '449044300481', '111111111111'];
  for (const num of numbers) {
    console.log(`--- Testing ${num} ---`);
    const result = await trackFedexShipment(num);
    console.log(JSON.stringify(result, null, 2));
  }
}

test();
