'use server';

const IS_SANDBOX = process.env.FEDEX_IS_SANDBOX === 'true';
const FEDEX_API_BASE = IS_SANDBOX ? 'https://apis-sandbox.fedex.com' : 'https://apis.fedex.com';
const CLIENT_ID = process.env.FEDEX_CLIENT_ID || '';
const CLIENT_SECRET = process.env.FEDEX_CLIENT_SECRET || '';

/**
 * Fetches an OAuth token from FedEx.
 */
async function getFedexToken() {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    return null;
  }

  try {
    const params = new URLSearchParams();
    params.append('grant_type', 'client_credentials');
    params.append('client_id', CLIENT_ID);
    params.append('client_secret', CLIENT_SECRET);

    const response = await fetch(`${FEDEX_API_BASE}/oauth/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    if (!response.ok) {
      return null;
    }

    const data = await response.json();
    return data.access_token;
  } catch {
    return null;
  }
}

/**
 * Tracks a FedEx shipment by tracking number.
 */
export async function trackFedexShipment(trackingNumber: string) {
  if (!trackingNumber) return { error: 'Tracking number is required.' };

  // Mock for testing delivered status in sandbox
  if (trackingNumber === 'DELIVERED_TEST') {
    return {
      status: 'Delivered',
      code: 'DL',
      eta: new Date().toISOString().split('T')[0],
    };
  }

  const token = await getFedexToken();
  if (!token) return { error: 'Failed to authenticate with FedEx.' };

  try {
    const requestBody = {
      includeDetailedScans: true,
      trackingInfo: [
        {
          trackingNumberInfo: {
            trackingNumber: trackingNumber,
          },
        },
      ],
    };

    const response = await fetch(`${FEDEX_API_BASE}/track/v1/trackingnumbers`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'x-customer-transaction-id': crypto.randomUUID?.() || Math.random().toString(36).substring(2),
        'x-locale': 'en_US',
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      return { error: 'FedEx Tracking API returned an error.' };
    }

    const data = await response.json();
    
    // Extract fields based on instructions
    const trackResult = data?.output?.completeTrackResults?.[0]?.trackResults?.[0];
    
    if (!trackResult) {
      return { error: 'No tracking information found for this number.' };
    }

    const status = trackResult.latestStatusDetail?.description || trackResult.statusDetail?.description || 'Unknown';
    const code = trackResult.latestStatusDetail?.code || trackResult.statusDetail?.code || 'Unknown';
    
    // Check multiple fields for ETA as they vary by service/status
    const etaWindow = trackResult.estimatedDeliveryTimeWindow?.window;
    const standardWindow = trackResult.standardTransitTimeWindow?.window;
    const eta = etaWindow?.ends || etaWindow?.begins || standardWindow?.ends || standardWindow?.begins || null;

    return {
      status,
      code,
      eta: eta ? eta.split('T')[0] : null, // Return date part only
      raw: data,
    };
  } catch {
    return { error: 'Network error occurred while tracking.' };
  }
}
