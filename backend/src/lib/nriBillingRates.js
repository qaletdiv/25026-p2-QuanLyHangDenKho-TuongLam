'use strict';
/**
 * Rate-card validation for NRI billing lines: is each charge what the agreement
 * says it should be?
 *
 * NRI's `Service` names are not the rate card's charge names ("Order
 * NonMasterPack" is the card's "Outbound Handling – B2C"), so the bridge between
 * them is this table: SERVICE → which Rate Codes may price it, and HOW. The rates
 * themselves are NEVER written here — they are read from the uploaded card
 * (nri_contract_rates) at check time, so re-uploading a card re-validates every
 * line with no code change.
 *
 * Mapped from the 2026 CA data (52,625 lines across 18 invoices), where each
 * service's charges cluster on exactly the card rates named below — e.g. Order
 * Processing is 1.25 (B2C order, 6,970 lines) or 2.00 (B2B order, 3,827 lines);
 * Returns is the COMPOSITE $1.40 per return + $0.67 per unit (2.07 for one unit,
 * 2.74 for two). The US map follows the same service names against the US card.
 *
 * Bases:
 *   perUnit     charge = rate × units           (any listed code may match)
 *   perLine     charge = rate                   (per order / receipt / month / event)
 *   composite   charge = fixed + rate × units   (`fixed` code + per-unit codes)
 *   hourly      charge = rate × units. NRI's RAW file states hours to two
 *               decimals (Tagging 0.42 h → $19.85) and they tie. A miss is still
 *               `qtyUnsupported`, not an overcharge, because the 2026 history was
 *               imported from the workbook, whose Power Query typed Units as a
 *               WHOLE NUMBER (0.42 → 0, 11.5 → 12; 3,085 lines in Sept 15 alone) —
 *               on those rows the hours genuinely cannot be checked. The implied
 *               hours are reported instead.
 *   passthrough freight / materials at market — nothing on the card to check.
 *
 * Storage carries `tiers` as well. NRI bills a month's storage as ONE line with
 * the aging tiers BLENDED (Aug 31: 282,015 units, $19,186.21 = $0.068/unit, which
 * sits between <180 d $0.05 and 180–364 d $0.07). No single tier can match that,
 * and calling it over/undercharged is wrong — so a line inside
 * [lowest tier × units, highest tier × units] is `tierBlend` with its implied
 * average rate, and only a charge OUTSIDE that range is flagged. Proving the mix
 * needs NRI's aging report, which the invoice does not carry.
 *
 * A service absent from the map is `noContractRate`: the agreement is silent on
 * it (Overtime, Pallet Prep), which is a question for the account manager, not a
 * coding error.
 *
 * Tolerance: $0.01 + $0.01 per 100 units. NRI rounds each LINE to cents, so the
 * total is compared, never the implied rate (charge ÷ units yields 30 distinct
 * "rates" for one flat $0.657 on the US side).
 */

const HOURLY = ['HRS-01', 'HRS-02', 'HRS-03', 'HRS-05', 'VAS-01', 'VAS-02', 'VAS-03', 'REV-05'];
const POP_RECEIVING = ['POP-01', 'POP-04', 'POP-07', 'POP-10'];
const POP_OUTBOUND = ['POP-02', 'POP-05', 'POP-08', 'POP-11'];
const POP_STORAGE = ['POP-03', 'POP-06', 'POP-09', 'POP-12'];

// Shared between the two cards — same NRI service, same code suffix.
const COMMON = {
    'Receipt Processing':        { basis: 'perLine', codes: ['FUL-01'] },
    'Receipt Mixed Carton Unit': { basis: 'perUnit', codes: ['SUR-01'] },
    'Repackaging':               { basis: 'perUnit', codes: ['SUR-01'] },
    'Inbound Units Audit':       { basis: 'perUnit', codes: ['SUR-02'] },
    'Returns':                   { basis: 'composite', fixed: 'REV-01', codes: ['REV-03'] },
    'Restock':                   { basis: 'perUnit', codes: ['REV-04', ...POP_RECEIVING] },
    'Order Restocking':          { basis: 'perUnit', codes: ['REV-04', ...POP_RECEIVING] },
    'Administration Fee':        { basis: 'perLine', codes: ['ADM-02'] },
    'Systems Maintenance':       { basis: 'perLine', codes: ['ADM-03'] },
    'Insert':                    { basis: 'perUnit', codes: ['VAS-05'] },
    'CI Generation':             { basis: 'perUnit', codes: ['VAS-06'] },
    'CI Maintenance':            { basis: 'perUnit', codes: ['VAS-07'] },
    'Manual BOL':                { basis: 'perLine', codes: ['SHP-05'] },
    'Order Cancel/Mod.':         { basis: 'perUnit', codes: ['SHP-08'] },
    'Order Cancellation':        { basis: 'perLine', codes: ['SHP-08'] },
    'Shipment Cancellation':     { basis: 'perLine', codes: ['SHP-09'] },
    'Rush Order':                { basis: 'perLine', codes: ['SHP-11'] },
    'Call Tags':                 { basis: 'perLine', codes: ['SHP-12'] },
    'EDI Labels':                { basis: 'perUnit', codes: ['EDI-01'] },
    'EDI Transmission':          { basis: 'perUnit', codes: ['EDI-03'] },
    'Storage Carton Shipped':    { basis: 'perUnit', codes: ['SUR-06'] },
    'Pallet storage (non-standard products)': { basis: 'perUnit', codes: ['VAS-08'] },
    'Warehouse Labour':          { basis: 'hourly', codes: HOURLY },
    'Warehouse Labor':           { basis: 'hourly', codes: HOURLY },
    'Tagging':                   { basis: 'hourly', codes: HOURLY },
    'Data Entry Labour':         { basis: 'hourly', codes: HOURLY },
    'Vendor Compliance':         { basis: 'hourly', codes: HOURLY },
    'Stripping':                 { basis: 'hourly', codes: HOURLY },
    'Service Center Labor':      { basis: 'hourly', codes: HOURLY },
    'Replenishment':             { basis: 'hourly', codes: HOURLY },
    'Cycle Count':               { basis: 'hourly', codes: ['CNT-01', 'HRS-05'] },
    'Outbound Freight':          { basis: 'passthrough', codes: ['FRT-01'] },
    'Inbound Freight':           { basis: 'passthrough', codes: ['FRT-01'] },
    'Returns Freight':           { basis: 'passthrough', codes: ['FRT-01'] },
    'Outbound Shipment Materials': { basis: 'passthrough', codes: ['MAT-01'] },
    'Shop Supplies':             { basis: 'passthrough', codes: ['MAT-01'] },
    'Recoverable Materials':     { basis: 'passthrough', codes: ['MAT-01'] },
    'Pallet Wrap':               { basis: 'passthrough', codes: ['MAT-01'] },
    'Inbound Pallets':           { basis: 'passthrough', codes: ['MAT-02'] },
    'Inbound Palletization':     { basis: 'passthrough', codes: ['MAT-02'] },
};

const SERVICE_RATES = {
    // The CA card prices outbound by CHANNEL — B2C (FUL-02 / FUL-06) vs B2B
    // (FUL-03 / FUL-07). The invoice line does not say which, but the order does:
    // `byChannel` narrows the codes once the line's Order Type is known (see
    // channelOf). Measured on Sept 15: every ECOM line is billed 1.25 / 0.65 and
    // every PREBOOK / WHOLESALE / PROMO line 2.00 / 0.50 — so a B2B rate on an ecom
    // order is a real discrepancy, not a near miss. An order missing from the order
    // data falls back to either.
    CA: {
        ...COMMON,
        'Order Processing':         { basis: 'perLine', codes: ['FUL-02', 'FUL-03'], byChannel: { b2c: ['FUL-02'], b2b: ['FUL-03'] } },
        'Order NonMasterPack':      { basis: 'perUnit', codes: ['FUL-06', 'FUL-07'], byChannel: { b2c: ['FUL-06'], b2b: ['FUL-07'] } },
        'Order Master Pack Carton': { basis: 'perUnit', codes: ['FUL-08'] },
        'Handling':                 { basis: 'perUnit', codes: ['FUL-06', 'FUL-07', 'FUL-08', ...POP_OUTBOUND] },
        'Receiving':                { basis: 'perUnit', codes: ['FUL-04', ...POP_RECEIVING] },
        'Storage':                  { basis: 'perUnit', codes: ['STO-02', 'STO-03', 'STO-04', 'VAS-08', ...POP_STORAGE], tiers: ['STO-02', 'STO-03', 'STO-04'] },
    },
    US: {
        ...COMMON,
        'Order Processing':         { basis: 'perLine', codes: ['FUL-02'] },
        'Order NonMasterPack':      { basis: 'perUnit', codes: ['FUL-04'] },
        'Handling':                 { basis: 'perUnit', codes: ['FUL-04', ...POP_OUTBOUND] },
        'Receiving':                { basis: 'perUnit', codes: ['FUL-03', ...POP_RECEIVING] },
        'Storage':                  { basis: 'perUnit', codes: ['STO-02', 'STO-03', 'STO-04', 'VAS-08', ...POP_STORAGE], tiers: ['STO-02', 'STO-03', 'STO-04'] },
        'Crossdock Receiving':      { basis: 'perUnit', codes: ['XD-01'] },
        'Crossdock Outbound':       { basis: 'perUnit', codes: ['XD-02'] },
    },
};

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

/** NRI Order Type → the card's channel. ECOM is B2C; every trade order type is B2B. */
function channelOf(orderType) {
    const t = String(orderType || '').trim().toUpperCase();
    if (!t) return null;
    if (t === 'ECOM') return 'b2c';
    if (['WHOLESALE', 'PREBOOK', 'AT ONCE', 'PROMO'].includes(t)) return 'b2b';
    return null;
}
const tolerance = (units) => 0.01 + Math.abs(units || 0) / 10000;

/** Rate rows of one entity → Map(code → row). */
function cardIndex(rates) {
    return new Map(rates.map((r) => [String(r.id).toUpperCase(), r]));
}

/**
 * Check one line.
 * @returns {{ verdict, expected: number|null, variance: number|null, rateCodes: string[], impliedHours?: number }}
 *   verdict: ok | overcharge | undercharge | qtyUnsupported | tierBlend | passthrough | noContractRate | noRateOnCard
 */
function checkLine(line, entity, card) {
    const spec = (SERVICE_RATES[entity] || {})[line.service];
    if (!spec) return { verdict: 'noContractRate', expected: null, variance: null, rateCodes: [] };
    const channel = channelOf(line.orderType);
    const codes = ((channel && spec.byChannel && spec.byChannel[channel]) || spec.codes).map((c) => `${entity}-${c}`);
    // the card's own wording for a line it gives no number for ("NRI Discounted", "Hourly")
    const cardText = (code) => {
        const r = card.get(code);
        return { basis: 'text', code, rate: null, uom: r ? r.uom || null : null, text: r ? r.rateText || null : null, fixed: null, fixedCode: null };
    };
    if (spec.basis === 'passthrough') return { verdict: 'passthrough', expected: null, variance: null, rateCodes: codes, calc: cardText(codes[0]) };

    const priced = codes.map((c) => card.get(c)).filter((r) => r && typeof r.rate === 'number' && r.rate > 0);
    if (!priced.length) return { verdict: 'noRateOnCard', expected: null, variance: null, rateCodes: codes, calc: cardText(codes[0]) };

    const units = Number(line.units) || 0;
    const charge = Number(line.charges) || 0;
    const tol = tolerance(units);

    let fixed = 0;
    if (spec.basis === 'composite') {
        const f = card.get(`${entity}-${spec.fixed}`);
        if (!f || typeof f.rate !== 'number') return { verdict: 'noRateOnCard', expected: null, variance: null, rateCodes: codes };
        fixed = f.rate;
        codes.unshift(f.id);
    }

    const candidates = priced.map((r) => ({
        code: r.id,
        rate: r.rate,
        uom: r.uom || null,
        expected: round2(spec.basis === 'perLine' ? r.rate : fixed + r.rate * units),
    }));
    // `calc` = the arithmetic that produced `expected`, so the page can show its working
    const calc = (c) => ({ basis: spec.basis, code: c.code, rate: c.rate, uom: c.uom, fixed: fixed || null, fixedCode: fixed ? codes[0] : null });
    const hit = candidates.find((c) => Math.abs(charge - c.expected) <= tol);
    if (hit) return { verdict: 'ok', expected: hit.expected, variance: round2(charge - hit.expected), rateCodes: [hit.code], calc: calc(hit) };

    if (spec.tiers && units > 0) {
        const tierRates = spec.tiers.map((c) => card.get(`${entity}-${c}`)).filter((r) => r && typeof r.rate === 'number');
        if (tierRates.length) {
            const lo = Math.min(...tierRates.map((r) => r.rate));
            const hi = Math.max(...tierRates.map((r) => r.rate));
            const min = round2(lo * units);
            const max = round2(hi * units);
            const impliedRate = Math.round((charge / units) * 10000) / 10000;
            const tierCodes = tierRates.map((r) => r.id);
            if (charge >= min - tol && charge <= max + tol) {
                return {
                    verdict: 'tierBlend', expected: null, variance: null, rateCodes: tierCodes, impliedRate, range: [min, max],
                    calc: { basis: 'tier', code: tierCodes.join('|'), rate: lo, rateMax: hi, uom: tierRates[0].uom || null, fixed: null, fixedCode: null, min, max },
                };
            }
            const bound = charge > max ? max : min;
            return {
                verdict: charge > max ? 'overcharge' : 'undercharge', expected: bound,
                variance: round2(charge - bound), rateCodes: tierCodes, impliedRate, range: [min, max],
            };
        }
    }

    // nearest candidate explains the miss
    const near = candidates.reduce((a, b) => (Math.abs(charge - b.expected) < Math.abs(charge - a.expected) ? b : a));
    const variance = round2(charge - near.expected);
    if (spec.basis === 'hourly') {
        return {
            verdict: 'qtyUnsupported', expected: near.expected, variance, rateCodes: [near.code],
            impliedHours: Math.round((charge / near.rate) * 100) / 100, calc: calc(near),
        };
    }
    return { verdict: variance > 0 ? 'overcharge' : 'undercharge', expected: near.expected, variance, rateCodes: [near.code], calc: calc(near) };
}

module.exports = { SERVICE_RATES, checkLine, cardIndex, channelOf };
