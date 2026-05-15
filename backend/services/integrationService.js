const crypto = require('crypto');
const axios = require('axios');

/**
 * IntegrationService — NetSuite OAuth 1.0 Token-Based Authentication (TBA).
 *
 * Credentials are read from environment variables (see .env.example).
 * Endpoint: SuiteQL (/services/rest/query/v1/suiteql) — returns all PO fields
 * in one paginated query instead of 1-per-record REST fetches.
 */

/**
 * Percent-encode a string per RFC 3986 (stricter than encodeURIComponent).
 */
function pct(str) {
    return encodeURIComponent(String(str))
        .replace(/!/g, '%21')
        .replace(/'/g, '%27')
        .replace(/\(/g, '%28')
        .replace(/\)/g, '%29')
        .replace(/\*/g, '%2A');
}

/**
 * Build the OAuth 1.0 Authorization header for a given request.
 *
 * @param {string} method   HTTP method (GET, POST, etc.)
 * @param {string} url      Full request URL (query string stripped for base URL)
 * @param {object} queryParams  Query params that will be sent with the request (included in signature)
 */
function buildOAuthHeader(method, url, queryParams = {}) {
    const accountId = (process.env.NETSUITE_ACCOUNT_ID || '').toUpperCase().replace(/-/g, '_');
    const consumerKey = process.env.NETSUITE_CONSUMER_KEY;
    const consumerSecret = process.env.NETSUITE_CONSUMER_SECRET;
    const tokenId = process.env.NETSUITE_TOKEN_ID;
    const tokenSecret = process.env.NETSUITE_TOKEN_SECRET;

    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = crypto.randomBytes(16).toString('hex');

    const oauthParams = {
        oauth_consumer_key: consumerKey,
        oauth_nonce: nonce,
        oauth_signature_method: 'HMAC-SHA256',
        oauth_timestamp: timestamp,
        oauth_token: tokenId,
        oauth_version: '1.0',
    };

    // Signature covers OAuth params + any request query params
    const allParams = { ...oauthParams, ...queryParams };

    // Step 1 — Normalized parameter string (sorted, pct-encoded)
    const normalizedParams = Object.keys(allParams)
        .sort()
        .map(k => `${pct(k)}=${pct(allParams[k])}`)
        .join('&');

    // Step 2 — Signature base string
    const baseUrl = url.split('?')[0];
    const sigBaseString = `${method.toUpperCase()}&${pct(baseUrl)}&${pct(normalizedParams)}`;

    // Step 3 — Signing key
    const signingKey = `${pct(consumerSecret)}&${pct(tokenSecret)}`;

    // Step 4 — HMAC-SHA256 signature
    const signature = crypto
        .createHmac('sha256', signingKey)
        .update(sigBaseString)
        .digest('base64');

    // Step 5 — Build header string
    const headerParams = { ...oauthParams, oauth_signature: signature };
    const headerBody = Object.keys(headerParams)
        .map(k => `${k}="${pct(headerParams[k])}"`)
        .join(', ');

    return `OAuth realm="${accountId}", ${headerBody}`;
}

/**
 * Map a single SuiteQL line-item row to the local line_items schema.
 * Column names match the SELECT aliases in SUITEQL_LINE_ITEMS_QUERY below.
 *
 * Color/size: parsed from sku_code (e.g. "TEN7101-FGN-XS" → color=FGN, size=XS).
 * If tentree adds custcol fields on transactionline, swap those in instead.
 */
function mapLineItemRow(row) {
    // sku_code pattern: <style>-<color_code>-<size>  e.g. TEN7101-FGN-XS
    const parts = (row.sku_code || '').split('-');
    const size  = parts.length >= 3 ? parts[parts.length - 1] : '';
    const color = parts.length >= 3 ? parts[parts.length - 2] : '';

    return {
        id:               `li_ns_${row.line_id}`,
        sku_code:         row.sku_code        || '',
        description:      row.description     || '',
        color,
        size,
        expected_qty:     Number(row.expected_qty) || 0,
        unit_price:       Number(row.unit_price)   || 0,
        netsuite_line_id: String(row.line_id  || ''),
    };
}

/**
 * Map a single SuiteQL row to the local PO schema.
 * Column names match the SELECT aliases in SUITEQL_QUERY below.
 *
 * NS date format: YYYY/MM/DD — normalise to YYYY-MM-DD.
 */
function mapSuiteQLRow(row) {
    const fmtDate = (d) => (d ? String(d).replace(/\//g, '-').split('T')[0] : '');
    return {
        po_number: row.tranid || '',
        supplier: row.supplier || '',
        etd: fmtDate(row.shipdate),      // CRD (Ship Date in NS)
        eta: fmtDate(row.duedate),       // Expected Receipt Date
        expected_qty: Number(row.total_qty) || '',
        mode: row.mode || '',   // custbody16 AS mode
        incoterm: row.incoterm || '',
        receiving_warehouse: row.receiving_warehouse || '',
        season: row.season || '',   // custbody7 AS season
        trn_number: row.trn_number || '',   // custbody_tentree_po AS trn_number
        netsuite_id: row.id || '',
        booking_status: 'No Booking',
        booking_number: null,
        type: row.type || '',   // custbody_tt_po_type AS type
        line_items: [],         // populated by fetchNetSuitePOs after line items query
    };
}

/**
 * SuiteQL query — pulls PO header fields + sums item-line quantities.
 * mainline = 'F' excludes the header summary line (real item lines only).
 * vendor.altname is the display/company name (entityid can be a code like VEN0005).
 */
const SUITEQL_QUERY = `
    SELECT
        agg.id,
        agg.tranid,
        agg.supplier,
        agg.shipdate,
        agg.duedate,
        BUILTIN.DF(agg.custbody7)           AS season,
        BUILTIN.DF(agg.custbody16)          AS mode,
        agg.trn_number,
        agg.receiving_warehouse,
        BUILTIN.DF(agg.custbody_tt_po_type) AS type,
        BUILTIN.DF(agg.incoterm)            AS incoterm,
        agg.total_qty
    FROM (
        SELECT
            t.id,
            t.tranid,
            v.altname             AS supplier,
            t.shipdate,
            t.duedate,
            t.custbody7,
            t.custbody16,
            t.custbody_tentree_po AS trn_number,
            l.name                AS receiving_warehouse,
            t.custbody_tt_po_type,
            t.incoterm,
            SUM(tl.quantity)      AS total_qty
        FROM transaction t
        LEFT JOIN vendor v
               ON v.id          = t.entity
        LEFT JOIN location l
               ON l.id          = t.location
        LEFT JOIN transactionline tl
               ON tl.transaction = t.id
              AND tl.mainline    = 'F'
              AND tl.itemtype    = 'InvtPart'
        WHERE t.type   = 'PurchOrd'
          AND t.status IN ('A', 'B', 'C')
        GROUP BY t.id, t.tranid, v.altname, t.shipdate, t.duedate,
                 t.custbody7, t.custbody16, t.custbody_tentree_po, l.name, t.custbody_tt_po_type, t.incoterm
    ) agg
`;
/*
 * Status codes for reference:
 *   A = Open / Pending Receipt      (included)
 *   B = Partially Received          (included)
 *   C = Pending Billing (Partial)   (included)
 *   D = Pending Bill                (excluded — fully received)
 *   F = Closed                      (excluded)
 *   G = Pending Approval / Draft    (excluded)
 *   H = Rejected / Cancelled        (excluded)
 */

/**
 * SuiteQL query — pulls one row per inventory line item across all active POs.
 * Results are grouped by po_number on the JS side and attached to the header.
 *
 * Pagination: the caller loops with offset until hasMore = false.
 *
 * If tentree stores color / size as custom columns on transactionline, add:
 *   BUILTIN.DF(tl.custcol_color) AS color,
 *   BUILTIN.DF(tl.custcol_size)  AS size,
 * and expose them in mapLineItemRow instead of the sku_code split fallback.
 */
const SUITEQL_LINE_ITEMS_QUERY = `
    SELECT
        t.tranid                                    AS po_number,
        t.id                                        AS netsuite_po_id,
        tl.id                                       AS line_id,
        i.itemid                                    AS sku_code,
        i.itemid                                    AS description,
        tl.quantity                                 AS expected_qty,
        tl.rate                                     AS unit_price
    FROM transaction t
    JOIN transactionline tl
      ON tl.transaction = t.id
     AND tl.mainline    = 'F'
     AND tl.itemtype    = 'InvtPart'
    JOIN item i
      ON i.id = tl.item
    WHERE t.type   = 'PurchOrd'
      AND t.status IN ('A', 'B', 'C')
    ORDER BY t.tranid, tl.linesequencenumber
`;

class IntegrationService {
    /**
     * Internal helper — POST a SuiteQL query and return all rows, following
     * NS pagination (hasMore + offset) automatically.
     *
     * @param {string} query     SuiteQL SELECT string
     * @param {number} pageSize  Rows per page (NS max = 1000)
     * @returns {Promise<object[]>}
     */
    async _suiteqlFetchAll(query, pageSize = 1000) {
        const accountId = process.env.NETSUITE_ACCOUNT_ID;
        const suiteqlUrl = `https://${accountId}.suitetalk.api.netsuite.com/services/rest/query/v1/suiteql`;

        const rows = [];
        let offset = 0;
        let hasMore = true;

        while (hasMore) {
            const queryParams = { limit: pageSize, offset };
            const authHeader = buildOAuthHeader('POST', suiteqlUrl, queryParams);

            let response;
            try {
                response = await axios.post(
                    suiteqlUrl,
                    { q: query },
                    {
                        headers: {
                            Authorization: authHeader,
                            'Content-Type': 'application/json',
                            Prefer: 'transient',
                        },
                        params: queryParams,
                    }
                );
            } catch (err) {
                console.error('[Integration] NetSuite error status:', err.response?.status);
                console.error('[Integration] NetSuite error body:', JSON.stringify(err.response?.data, null, 2));
                throw err;
            }

            const page = response.data?.items || [];
            rows.push(...page);
            hasMore = response.data?.hasMore === true;
            offset += page.length;
        }

        return rows;
    }

    /**
     * Fetch all line items for active POs from NetSuite.
     * Returns a Map keyed by po_number → array of mapped line items.
     *
     * @returns {Promise<Map<string, object[]>>}
     */
    async fetchNetSuiteLineItems() {
        const accountId = process.env.NETSUITE_ACCOUNT_ID;
        if (!accountId || !process.env.NETSUITE_CONSUMER_KEY) {
            console.warn('[Integration] NetSuite credentials not configured — returning empty line items');
            return new Map();
        }

        let rows;
        try {
            rows = await this._suiteqlFetchAll(SUITEQL_LINE_ITEMS_QUERY);
        } catch (err) {
            console.error('[Integration] fetchNetSuiteLineItems query failed — line items will be skipped for this sync');
            console.error('[Integration] Line items query error:', err.response?.data || err.message);
            return new Map();
        }

        console.log(`[Integration] fetchNetSuiteLineItems — fetched ${rows.length} line item rows`);

        const byPO = new Map();
        for (const row of rows) {
            const poNumber = row.po_number;
            if (!poNumber) continue;
            if (!byPO.has(poNumber)) byPO.set(poNumber, []);
            byPO.get(poNumber).push(mapLineItemRow(row));
        }
        return byPO;
    }

    /**
     * Fetch POs from NetSuite via SuiteQL, including SKU-level line items.
     * Two queries are issued — headers (aggregated) + line items (one row per SKU) —
     * then merged before returning.
     *
     * @param {object} opts
     * @param {number} [opts.maxResults]  Cap on PO header rows (null = all)
     * @returns {Promise<object[]>}  Array of POs mapped to the local schema, each with line_items[]
     */
    async fetchNetSuitePOs({ maxResults = null } = {}) {
        const accountId = process.env.NETSUITE_ACCOUNT_ID;
        if (!accountId || !process.env.NETSUITE_CONSUMER_KEY) {
            console.warn('[Integration] NetSuite credentials not configured — returning []');
            return [];
        }

        // Fetch headers and line items in parallel
        const [headerRows, lineItemsByPO] = await Promise.all([
            this._suiteqlFetchAll(SUITEQL_QUERY, maxResults || 1000),
            this.fetchNetSuiteLineItems(),
        ]);

        const pos = headerRows
            .slice(0, maxResults || headerRows.length)
            .map(row => {
                const po = mapSuiteQLRow(row);
                po.line_items = lineItemsByPO.get(po.po_number) || [];
                return po;
            });

        console.log(`[Integration] fetchNetSuitePOs — ${pos.length} POs, ${[...lineItemsByPO.values()].reduce((s, a) => s + a.length, 0)} total line items`);
        return pos;
    }

    /**
     * Fetch courier tracking status for a shipment.
     * Stub — replace with FedEx / DHL API when ready.
     */
    async getTrackingStatus(trackingNumber) {
        if (!trackingNumber) {
            return { trackingNumber: null, status: 'Unknown', eta: null };
        }
        return {
            trackingNumber,
            status: 'In Transit',
            eta: new Date(Date.now() + 86400000).toISOString().split('T')[0],
        };
    }

    /**
     * Send an email report.
     * Stub — replace with Nodemailer / SendGrid when ready.
     */
    async sendToEmail(to, subject, text) {
        if (!to || !subject) return false;
        console.log(`[Integration] Mock email → ${to} | Subject: "${subject}"`);
        return true;
    }
}

module.exports = new IntegrationService();
