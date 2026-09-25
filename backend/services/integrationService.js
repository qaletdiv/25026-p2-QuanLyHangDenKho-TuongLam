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

    // Unit price MUST be in the transaction currency (USD for SMS) — i.e. the value
    // shown on the NetSuite PO line. NetSuite's `transactionline.rate` is stored in
    // the account BASE currency (inflated by exchangerate: 20.6553 = 14.99 × 1.37794),
    // so it is NOT the number to use. The transaction-currency price is
    // `foreignamount / quantity`; for zero-qty lines (no amount) fall back to
    // `rate / exchangerate`, which yields the same USD figure.
    const qty  = Number(row.expected_qty) || 0;
    const amt  = Number(row.line_amount);
    const rate = Number(row.rate) || 0;
    const exch = Number(row.exch_rate) || 1;
    const rawPrice = qty && amt ? amt / qty : (exch ? rate / exch : rate);
    const unitPrice = Math.round(rawPrice * 100) / 100;

    // ⚠️ KEYS are ours (camelCase, matching the models); `row.*` are the SuiteQL
    // ALIASES from buildLineItemsQuery and stay snake_case. Do not "tidy" the
    // right-hand side — NetSuite lowercases returned aliases, so renaming them
    // would silently yield undefined on every field.
    const li = {
        id:              `li_ns_${row.line_id}`,
        skuCode:         row.sku_code        || '',
        description:     row.description     || '',
        color,
        size,
        expectedQty:     qty,
        unitPrice,
        netsuiteLineId:  String(row.line_id  || ''),
    };
    // SKU descriptive attributes (only the columns the query actually emitted —
    // see SKU_ATTR_COLUMNS). These feed the product_skus master so the CI/packing
    // list can fall back to them when a vendor's uploaded sheet omits a column.
    // `key` is the SQL alias (snake_case, see skuAttrSelects); the property we
    // store is the model's camelCase attribute — e.g. knit_woven -> knitWoven.
    const camel = (k) => k.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
    for (const { key } of SKU_ATTR_COLUMNS) {
        if (row[key] != null && row[key] !== '') li[camel(key)] = String(row[key]).trim();
    }
    return li;
}

/**
 * SKU descriptive attributes pulled onto each line item so product_skus can carry
 * them (CI / packing-list fallback when a vendor's sheet omits a column).
 *
 * UPC is a STANDARD item field (`i.upccode`) — always pulled. Gender / category /
 * composition / knit-woven are tentree CUSTOM item fields (`custitem_*`) whose
 * internal ids vary per account, so they are read from env and only injected when
 * set. This matters: a typo'd / unknown column name makes the ENTIRE SuiteQL
 * statement 500, which would break SMS PO sync — keeping the custom ones opt-in
 * means the query is always valid out of the box, and each attribute activates the
 * moment its `custitem_*` id is put in .env.
 *
 * Custom fields are wrapped in BUILTIN.DF so List/Record fields (gender, category)
 * return their label rather than an internal id; for free-text fields BUILTIN.DF
 * returns the raw value.
 */
const SKU_ATTR_COLUMNS = [
    { key: 'upc',         expr: 'i.upccode' },
    { key: 'gender',      field: process.env.NS_ITEM_FIELD_GENDER },
    { key: 'category',    field: process.env.NS_ITEM_FIELD_CATEGORY },
    { key: 'composition', field: process.env.NS_ITEM_FIELD_COMPOSITION },
    { key: 'knit_woven',  field: process.env.NS_ITEM_FIELD_KNIT_WOVEN },
];

// SELECT fragments for the attributes we can safely reference (standard column, or
// a configured custom field). Returns [] → nothing appended → query unchanged.
function skuAttrSelects() {
    return SKU_ATTR_COLUMNS
        .filter((c) => c.expr || c.field)
        .map((c) => `        ${c.expr || `BUILTIN.DF(i.${c.field})`} AS ${c.key}`);
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
        // ⚠️ KEYS are ours (camelCase); `row.*` are the SuiteQL ALIASES and stay
        // snake_case — NetSuite lowercases returned aliases, so renaming the
        // right-hand side would silently yield undefined on every field.
        poNumber: row.tranid || '',
        supplier: row.supplier || '',
        etd: fmtDate(row.shipdate),      // ETD (Ship Date in NS)
        // ⚠️ duedate is the EXPECTED RECEIVE DATE — when NetSuite expects the
        // goods booked in. It was previously mislabelled `etdPol` (departure
        // from port of loading), which is the opposite end of the journey. That
        // was harmless only because the sync's etdPol never reached a leg
        // (0/87 populated); under v2 it would have fed the transit segments
        // backwards. E-DEL is DERIVED from this — see netsuiteSyncService.
        expectedReceiveDate: fmtDate(row.duedate),
        crd: fmtDate(row.crd),           // custbody46 — cargo ready date
        expectedQty: Number(row.total_qty) || '',
        mode: row.mode || '',   // custbody16 AS mode
        incoterm: row.incoterm || '',
        receivingWarehouse: row.receiving_warehouse || '',
        season: row.season || '',   // custbody7 AS season
        trnNumber: row.trn_number || '',   // custbody_tentree_po AS trn_number
        hod: fmtDate(row.hod),               // custbody8 — handover date (SMS "CRD")
        approvalStatus: row.approval_status || '',   // approvalstatus display value
        netsuiteId: row.id || '',
        bookingStatus: 'No Booking',
        bookingNumber: null,
        type: row.type || '',   // custbody_tt_po_type AS type
        line_items: [],         // populated by fetchNetSuitePOs after line items query
    };
}

/**
 * PO type filter — maps a portal `type` value to a SuiteQL predicate on the
 * NetSuite custom field `custbody_tt_po_type`. Used so the SMS tab's sync only
 * pulls SMS POs. Mainline sync passes no type (current behaviour — pulls all).
 *
 * `null`/unknown → '' (no extra filter). Returns a clause that references the
 * `transaction` alias `t`, so it must be injected inside the inner subquery.
 */
function poTypeClause(type) {
    // display value confirmed as 'smm' (Lam, 2026-07-02) — match case-insensitively
    // and accept the 'SMS' spelling too in case the sandbox list label differs.
    if (type === 'sms') return "AND UPPER(BUILTIN.DF(t.custbody_tt_po_type)) IN ('SMM', 'SMS')";
    // mainline → everything that is NOT SMS, including POs with no type set
    // (BUILTIN.DF is NULL for an unset field, so guard for it explicitly).
    if (type === 'mainline') return "AND (UPPER(BUILTIN.DF(t.custbody_tt_po_type)) NOT IN ('SMM', 'SMS') OR t.custbody_tt_po_type IS NULL)";
    return '';
}

/**
 * A REJECTED purchase order is not a commitment and must never enter the portal:
 * it has no goods coming, so it would sit in the order book forever, inflate the
 * forecast and offer itself for booking. `approvalstatus` 3 = Rejected.
 *
 * IS NULL is allowed on purpose. 880 of this account's Fully-Billed / Closed POs
 * carry no approval status at all; they sit outside SMS's 18-month window today,
 * but a plain `approvalstatus != 3` would silently exclude every one of them the
 * moment the window widened — SQL three-valued logic makes NULL != 3 UNKNOWN, not
 * true. Verified: SMS scope 120 → 120 POs with this clause added.
 */
const NOT_REJECTED_CLAUSE = 'AND (t.approvalstatus IS NULL OR t.approvalstatus != 3)';

/**
 * PO status scope — a WHERE fragment on the `t` alias.
 *
 * Default (mainline / untyped) = not yet received: Pending Supervisor Approval
 * (A) + Pending Receipt (B). SMS receiving needs the FULL post-order lifecycle
 * so a PO's receipts keep syncing AFTER it's fully received — a PO flips to
 * G (Fully Billed) the moment receiving completes, so excluding the received
 * states means the final receipt (and the "fully received" total) never lands.
 * We therefore pull the lifecycle for SMS, bounded to a rolling window
 * (SMS_SYNC_SINCE_MONTHS, default 18) so years of Fully-Billed/Closed POs don't
 * pile up (the UI season filter hides done records anyway).
 *
 * VERIFIED legend (production, GROUP BY t.status over every PurchOrd, 2026-09-08):
 *   A = Pending Supervisor Approval      (approval: Pending Approval)
 *   B = Pending Receipt                  (Approved)
 *   C = Rejected by Supervisor           (Rejected)   ← NOT a live PO
 *   D = Partially Received, E = Pending Billing/Partially Received,
 *   F = Pending Bill, G = Fully Billed, H = Closed     (Approved / unset)
 *
 * 'C' used to be in BOTH lists, described as "Pending Billing" from a legend that
 * was already known to be wrong (see the D..H note this comment replaced). That is
 * how PO03521 and PO03789 — rejected by a supervisor — reached the portal as live
 * mainline POs. It is excluded twice over now: not in the status list, and refused
 * by NOT_REJECTED_CLAUSE, which also catches a PO rejected at the approval level
 * while sitting in some other transaction state.
 */
function poStatusClause(type) {
    if (type !== 'sms') return `AND t.status IN ('A', 'B') ${NOT_REJECTED_CLAUSE}`;
    const months = Number(process.env.SMS_SYNC_SINCE_MONTHS) || 18;
    const d = new Date();
    d.setMonth(d.getMonth() - months);
    const cutoff = d.toISOString().slice(0, 10);
    return `AND t.status IN ('A','B','D','E','F','G','H') ${NOT_REJECTED_CLAUSE}`
        + ` AND t.trandate >= TO_DATE('${cutoff}', 'YYYY-MM-DD')`;
}

/**
 * SuiteQL query — pulls PO header fields + sums item-line quantities.
 * mainline = 'F' excludes the header summary line (real item lines only).
 * vendor.altname is the display/company name (entityid can be a code like VEN0005).
 *
 * Receiving warehouse: the location lives on the transaction LINE (tl.location),
 * not the header (t.location is null on these POs). We MAX-aggregate the line
 * location so the PO stays one row even if lines ever span warehouses (in
 * practice each PO resolves to a single location).
 *
 * @param {string} [typeClause]  Extra WHERE predicate (see poTypeClause).
 */
// default = the mainline scope, from the ONE definition of it (a literal copy
// here is how 'C'/Rejected survived the legend correction the first time)
function buildHeaderQuery(typeClause = '', statusClause = poStatusClause(null)) {
    return `
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
        agg.hod,
        agg.crd,
        BUILTIN.DF(agg.approvalstatus)      AS approval_status,
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
            t.custbody8           AS hod,   -- hand-over date
            t.custbody46          AS crd,   -- cargo ready date (v2 leg.crd)
            t.approvalstatus,
            MAX(l.name)           AS receiving_warehouse,
            t.custbody_tt_po_type,
            t.incoterm,
            SUM(tl.quantity)      AS total_qty
        FROM transaction t
        LEFT JOIN vendor v
               ON v.id          = t.entity
        LEFT JOIN transactionline tl
               ON tl.transaction = t.id
              AND tl.mainline    = 'F'
              AND tl.itemtype    = 'InvtPart'
        LEFT JOIN location l
               ON l.id          = tl.location
        WHERE t.type   = 'PurchOrd'
          ${statusClause}
          ${typeClause}
        GROUP BY t.id, t.tranid, v.altname, t.shipdate, t.duedate,
                 t.custbody7, t.custbody16, t.custbody_tentree_po, t.custbody8,
                 t.custbody46,
                 t.approvalstatus, t.custbody_tt_po_type, t.incoterm
    ) agg
`;
}
/*
 * NetSuite PO status codes (verified against production 2026-07-22 via
 * BUILTIN.DF(t.status) on custbody_tt_po_type='smm' POs):
 *   B = Pending Receipt                        (open, no receipts yet)
 *   D = Partially Received                      (has receipts)
 *   E = Pending Billing/Partially Received      (has receipts)
 *   F = Pending Bill                            (fully received, has receipts)
 *   G = Fully Billed                            (fully received + billed)
 *   H = Closed                                  (has receipts)
 * (A / C exist for other PO types.) Mainline sync keeps the active-only A/B/C
 * scope; SMS widens to B..H so received POs stay in scope — see poStatusClause.
 * The earlier legend here was WRONG and is why the receiving sync pulled zero
 * receipts (it excluded exactly the D..H states that carry them).
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
function buildLineItemsQuery(typeClause = '', statusClause = poStatusClause(null)) {
    const attrCols = skuAttrSelects();
    const attrSelect = attrCols.length ? ',\n' + attrCols.join(',\n') : '';
    return `
    SELECT
        t.tranid                                    AS po_number,
        t.id                                        AS netsuite_po_id,
        tl.id                                       AS line_id,
        i.itemid                                    AS sku_code,
        i.description                               AS description,
        tl.quantity                                 AS expected_qty,
        tl.rate                                     AS rate,
        tl.foreignamount                            AS line_amount,
        t.exchangerate                              AS exch_rate${attrSelect}
    FROM transaction t
    JOIN transactionline tl
      ON tl.transaction = t.id
     AND tl.mainline    = 'F'
     AND tl.itemtype    = 'InvtPart'
    JOIN item i
      ON i.id = tl.item
    WHERE t.type   = 'PurchOrd'
      ${statusClause}
      ${typeClause}
    ORDER BY t.tranid, tl.linesequencenumber
`;
}

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
    async fetchNetSuiteLineItems({ type = null } = {}) {
        const accountId = process.env.NETSUITE_ACCOUNT_ID;
        if (!accountId || !process.env.NETSUITE_CONSUMER_KEY) {
            console.warn('[Integration] NetSuite credentials not configured — returning empty line items');
            return new Map();
        }

        let rows;
        try {
            rows = await this._suiteqlFetchAll(buildLineItemsQuery(poTypeClause(type), poStatusClause(type)));
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
     * @param {string} [opts.type]        Portal PO type filter (e.g. 'sms' → only SMS POs).
     *                                    Omit/null for the default mainline sync (all POs).
     * @returns {Promise<object[]>}  Array of POs mapped to the local schema, each with line_items[]
     */
    async fetchNetSuitePOs({ maxResults = null, type = null } = {}) {
        const accountId = process.env.NETSUITE_ACCOUNT_ID;
        if (!accountId || !process.env.NETSUITE_CONSUMER_KEY) {
            console.warn('[Integration] NetSuite credentials not configured — returning []');
            return [];
        }

        const typeClause = poTypeClause(type);

        // Fetch headers and line items in parallel
        const [headerRows, lineItemsByPO] = await Promise.all([
            this._suiteqlFetchAll(buildHeaderQuery(typeClause, poStatusClause(type)), maxResults || 1000),
            this.fetchNetSuiteLineItems({ type }),
        ]);

        const pos = headerRows
            .slice(0, maxResults || headerRows.length)
            .map(row => {
                const po = mapSuiteQLRow(row);
                po.line_items = lineItemsByPO.get(po.poNumber) || [];
                // SMS sync: normalise type so these POs surface under the SMS tab,
                // whose frontend filter checks `type === 'sms'`.
                if (type === 'sms') po.type = 'sms';
                return po;
            });

        console.log(`[Integration] fetchNetSuitePOs — ${pos.length} POs, ${[...lineItemsByPO.values()].reduce((s, a) => s + a.length, 0)} total line items`);
        return pos;
    }

    /**
     * Fetch NetSuite Item Receipts for the given SMS PO internal ids — one row per
     * receipt line, grouped into { ir_id, ir_tranid, po_number, receipt_date,
     * lines[] } on the JS side.
     *
     * Linkage: a receipt is tied to its source PO through the receipt LINE's
     * `transactionline.createdfrom` (the HEADER's `transaction.createdfrom` is NOT
     * a valid SuiteQL column and 500s). We scope to the passed PO ids (createdfrom
     * IN …) rather than a BUILTIN.DF(custbody) scan of the whole receipt table,
     * which is orders of magnitude faster (the caller already has the SMS PO ids).
     * Degrades gracefully: no ids → []; query error → logs + [] (never throws).
     *
     * @param {Array<string|number>} poIds  SMS PO internal ids (sms_pos.netsuite_id)
     * @returns {Promise<object[]>}
     */
    async fetchNetSuiteItemReceipts(poIds = []) {
        const accountId = process.env.NETSUITE_ACCOUNT_ID;
        if (!accountId || !process.env.NETSUITE_CONSUMER_KEY) {
            console.warn('[Integration] NetSuite credentials not configured — returning []');
            return [];
        }
        // internal ids only — sanitized to digits (also guards the inlined IN list)
        const ids = (poIds || []).map((x) => String(x).replace(/[^0-9]/g, '')).filter(Boolean);
        if (!ids.length) {
            console.log('[Integration] fetchNetSuiteItemReceipts — no SMS PO ids, skipping receipts');
            return [];
        }
        const query = `
    SELECT
        ir.id                 AS ir_id,
        ir.tranid             AS ir_tranid,
        ir.trandate           AS receipt_date,
        po.tranid             AS po_number,
        i.itemid              AS sku_code,
        irl.quantity          AS qty
    FROM transactionline irl
    JOIN transaction ir
      ON ir.id  = irl.transaction
     AND ir.type = 'ItemRcpt'
    JOIN transaction po
      ON po.id  = irl.createdfrom
     AND po.type = 'PurchOrd'
    JOIN item i
      ON i.id = irl.item
    WHERE irl.mainline  = 'F'
      AND irl.itemtype  = 'InvtPart'
      AND irl.createdfrom IN (${ids.join(', ')})
    ORDER BY ir.id, irl.linesequencenumber
`;
        let rows;
        try {
            rows = await this._suiteqlFetchAll(query);
        } catch (err) {
            console.error('[Integration] fetchNetSuiteItemReceipts query failed — receipts skipped for this sync');
            console.error('[Integration] IR error:', err.response?.data?.['o:errorDetails']?.[0]?.detail || err.message);
            return [];
        }
        const fmtDate = (d) => (d ? String(d).replace(/\//g, '-').split('T')[0] : null);
        const byIr = new Map();
        for (const r of rows) {
            if (!byIr.has(r.ir_id)) {
                // Keys are OURS (camelCase, consumed by the receipt folds);
                // `r.*` are the SuiteQL aliases and stay snake_case.
                byIr.set(r.ir_id, { ir_id: String(r.ir_id), ir_tranid: r.ir_tranid || null, poNumber: r.po_number || null, receiptDate: fmtDate(r.receipt_date), lines: [] });
            }
            // receipt lines can repeat a SKU across bins — aggregate per SKU
            const ir = byIr.get(r.ir_id);
            const qty = Math.abs(Number(r.qty) || 0);
            const line = ir.lines.find((l) => l.skuCode === r.sku_code);
            if (line) line.qty += qty; else ir.lines.push({ skuCode: r.sku_code || '', qty });
        }
        const receipts = [...byIr.values()];
        console.log(`[Integration] fetchNetSuiteItemReceipts — ${receipts.length} receipts, ${rows.length} lines`);
        return receipts;
    }

    /**
     * Resolve PO internal ids from their document numbers (tranids, e.g. "PO04749").
     * Used to backfill po_orders.netsuite_id for POs outside the active sync window
     * (received/closed), so their Item Receipts can still be fetched. Returns a
     * { tranid: internal_id } map. Batched to stay under the IN-list limit.
     */
    async fetchPoIdsByTranid(tranids = []) {
        if (!process.env.NETSUITE_ACCOUNT_ID || !process.env.NETSUITE_CONSUMER_KEY) return {};
        const clean = [...new Set((tranids || []).map((t) => String(t).replace(/[^A-Za-z0-9-]/g, '')).filter(Boolean))];
        const out = {};
        for (let i = 0; i < clean.length; i += 900) {
            const batch = clean.slice(i, i + 900);
            const list = batch.map((t) => `'${t}'`).join(', ');
            const rows = await this._suiteqlFetchAll(
                `SELECT id, tranid FROM transaction WHERE type = 'PurchOrd' AND tranid IN (${list})`,
            ).catch(() => []);
            for (const r of rows) out[r.tranid] = String(r.id);
        }
        return out;
    }

    /**
     * Approval status of the POs the portal HOLDS, whether or not they are still in
     * the sync's pull scope.
     *
     * Two jobs, one round trip:
     *  · the prune needs to know which held POs NetSuite has since REJECTED — the
     *    scope filters can't say, because a rejected PO is out of scope by
     *    definition, so a PO rejected after it synced just stops being refreshed
     *    and lives on (that is how PO03521 / PO03789 were found);
     *  · the "Pending approval" badge needs the CURRENT value for every held PO.
     *    Taking it only from the pull would freeze it: a PO that was pending when
     *    it synced, then got approved and received, leaves the A/B scope and would
     *    wear "Pending approval" forever — a badge that lies on exactly the POs
     *    that moved on is worse than no badge.
     *
     * Batched to stay under the IN-list limit; sanitised because the list is
     * inlined. Never throws — a failed lookup leaves this sync's values alone.
     *
     * @param {string[]} tranids
     * @returns {Promise<Map<string, {approval: string|null, rejected: boolean}>>}
     */
    async fetchPoApprovalStatuses(tranids = []) {
        const out = new Map();
        if (!process.env.NETSUITE_ACCOUNT_ID || !process.env.NETSUITE_CONSUMER_KEY) return out;
        const clean = [...new Set((tranids || []).map((t) => String(t).replace(/[^A-Za-z0-9-]/g, '')).filter(Boolean))];
        for (let i = 0; i < clean.length; i += 900) {
            const list = clean.slice(i, i + 900).map((t) => `'${t}'`).join(', ');
            const rows = await this._suiteqlFetchAll(
                `SELECT tranid,
                        BUILTIN.DF(approvalstatus) AS approval,
                        approvalstatus             AS approval_code,
                        status                     AS status_code
                   FROM transaction
                  WHERE type = 'PurchOrd' AND tranid IN (${list})`,
            ).catch((e) => { console.error('[Integration] fetchPoApprovalStatuses failed:', e.message); return []; });
            rows.forEach((r) => out.set(r.tranid, {
                approval: r.approval || null,
                // both signals: approvalstatus 3 and transaction status 'C' are the
                // same rejection seen at the approval and transaction levels
                rejected: String(r.approval_code) === '3' || r.status_code === 'C',
            }));
        }
        return out;
    }

    /**
     * The subset of these POs that NetSuite has REJECTED. Thin wrapper over
     * fetchPoApprovalStatuses so both answers come from one query shape.
     * @returns {Promise<Set<string>>}
     */
    async fetchRejectedPoTranids(tranids = []) {
        const statuses = await this.fetchPoApprovalStatuses(tranids);
        return new Set([...statuses.entries()].filter(([, v]) => v.rejected).map(([k]) => k));
    }

    /**
     * Resolve ONE Item Receipt by its document number (tranid, e.g. "IR65377") to
     * its internal id + date — used for a MANUAL landed-cost match when the
     * auto-matcher found no receipt. Returns { ir_id, ir_tranid, receipt_date } or null.
     */
    async fetchItemReceiptByTranid(tranid) {
        if (!process.env.NETSUITE_ACCOUNT_ID || !process.env.NETSUITE_CONSUMER_KEY) return null;
        const t = String(tranid || '').replace(/[^A-Za-z0-9-]/g, '').trim();   // sanitise (inlined literal)
        if (!t) return null;
        const rows = await this._suiteqlFetchAll(
            `SELECT id, tranid, trandate FROM transaction WHERE type = 'ItemRcpt' AND UPPER(tranid) = UPPER('${t}')`,
        );
        if (!rows.length) return null;
        const r = rows[0];
        const fmtDate = (d) => (d ? String(d).replace(/\//g, '-').split('T')[0] : null);
        return { ir_id: String(r.id), ir_tranid: r.tranid || t, receiptDate: fmtDate(r.trandate) };
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
// OAuth 1.0 (TBA) signer — exported for other NetSuite callers (e.g. the landed
// cost Item-Receipt push). Additive; does not change existing behaviour.
module.exports.buildOAuthHeader = buildOAuthHeader;
