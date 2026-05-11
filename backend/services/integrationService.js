/**
 * IntegrationService — stubs for external system integrations.
 *
 * All methods are currently mocked/placeholder implementations.
 * None of them throw on invalid input; callers can always await them safely.
 * Replace the method bodies with real API calls when credentials are available.
 */

class IntegrationService {
    /**
     * Fetch open POs from NetSuite Saved Search.
     * Stub returns an empty array until NetSuite credentials are configured.
     *
     * @returns {Promise<object[]>}
     */
    async fetchNetSuitePOs() {
        console.log('[Integration] fetchNetSuitePOs — stub, returning []');
        // Replace with:
        //   const response = await axios.get(process.env.NETSUITE_API_URL, {
        //       headers: { Authorization: `Bearer ${process.env.NETSUITE_TOKEN}` },
        //   });
        //   return response.data;
        return [];
    }

    /**
     * Fetch courier tracking status for a shipment.
     * Stub returns a mock "In Transit" response.
     *
     * @param {string} trackingNumber
     * @returns {Promise<object>}
     */
    async getTrackingStatus(trackingNumber) {
        if (!trackingNumber) {
            console.warn('[Integration] getTrackingStatus called with no tracking number');
            return { trackingNumber: null, status: 'Unknown', eta: null };
        }
        console.log(`[Integration] getTrackingStatus — stub for ${trackingNumber}`);
        // Replace with real FedEx / DHL API call
        return {
            trackingNumber,
            status: 'In Transit',
            eta: new Date(Date.now() + 86400000).toISOString().split('T')[0],
        };
    }

    /**
     * Send an email report (e.g. daily sweep summary).
     * Stub logs the call; replace with Nodemailer / SendGrid when ready.
     *
     * @param {string} to
     * @param {string} subject
     * @param {string} text
     * @returns {Promise<boolean>}
     */
    async sendToEmail(to, subject, text) {
        if (!to || !subject) {
            console.warn('[Integration] sendToEmail called with missing to/subject — skipping');
            return false;
        }
        console.log(`[Integration] Mock email → ${to} | Subject: "${subject}"`);
        // Replace with Nodemailer/SendGrid
        return true;
    }
}

module.exports = new IntegrationService();
