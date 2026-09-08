'use strict';
/**
 * NetSuite CLASS per invoice line — PURE.
 *
 * The GL is a property of the SERVICE (the coding legend). The CLASS is a
 * property of the ORDER, and the legend's single hardcoded class per service
 * cannot express it. Reverse-engineered from finance's correct coding of invoice
 * 48872 and validated against it:
 *
 *   Amazon customer                     -> Amazon-US
 *   ECOM  + ship-to outside the US      -> INTL - Online
 *   ECOM  + ship-to United States       -> US - Online
 *   WHOLESALE / PREBOOK / AT ONCE       -> US - Whsle
 *   no order behind the line (storage,
 *   receiving, monthly fees, counts)    -> US - Whsle
 *
 * Evidence the rule is right: applied to only the lines whose order resolves, it
 * lands `Amazon-US $4.79` and `GL 5207 INTL - Online $546.32` EXACTLY on
 * finance's figures, and every other online/INTL bucket comes out UNDER (never
 * over) target — the signature of a correct rule starved of order data, not a
 * wrong rule. See README "Class derivation".
 *
 * ⚠️ The legend's `Mobile Mini` class does NOT appear in finance's coding:
 * Recoverable Materials' $784.00 sits in `US - Whsle`. Legend classes are
 * therefore treated as a FALLBACK for unresolved lines, never as the answer.
 */

const CHANNEL = Object.freeze({
  ECOM: 'online', WHOLESALE: 'wholesale', PREBOOK: 'wholesale', 'AT ONCE': 'wholesale',
});

const CLASSES = Object.freeze({
  US_WHOLESALE: 'US - Whsle',
  US_ONLINE: 'US - Online',
  INTL_ONLINE: 'INTL - Online',
  AMAZON_US: 'Amazon-US',
});

/** Services whose class is a returns question, so the ref-format rule may apply. */
const RETURNS_SERVICES = Object.freeze(['Returns', 'Restock', 'Service Center Labor']);

/**
 * Services that are NOT attributable to a sales order — warehouse-wide work and
 * facility charges. They carry a reference sometimes (a container id, a project
 * name) but never an order number, so they must not sit in the unresolved queue
 * waiting for order data that will never explain them. Finance classes all of
 * these `US - Whsle`, including Recoverable Materials, which is why the legend's
 * `Mobile Mini` class does not appear in the correct coding at all.
 */
const NON_ORDER_SERVICES = Object.freeze(new Set([
  'STORAGE', 'RECOVERABLE MATERIALS', 'REPLENISHMENT',
  'RECEIVING', 'RECEIPT PROCESSING', 'RECEIPT MIXED CARTON UNIT',
  'INBOUND UNITS AUDIT', 'INBOUND PALLETIZATION', 'INBOUND FREIGHT', 'INBOUND PALLETS',
  'CYCLE COUNT', 'CYCLE COUNT UNITS', 'PHYSICAL COUNT',
  'ADMINISTRATION FEE', 'SYSTEMS MAINTENANCE', 'IT TIME',
  'WAREHOUSE LABOR', 'WAREHOUSE LABOUR', 'DATA ENTRY LABOUR', 'VENDOR COMPLIANCE',
  'TAGGING', 'STRIPPING', 'BAGGING (OPS)', 'ATS ADMINISTRATION',
  'QUALITY CONTROL', 'REPACKAGING', 'OVERTIME', 'OVERTIME LABOUR',
  'EDI TRANSMISSION', 'MANUAL BOL',
]));

const norm = v => (v === undefined || v === null ? '' : String(v).trim());
const upper = v => norm(v).toUpperCase();

const isUs = country => {
  const c = upper(country);
  return !c || c === 'UNITED STATES' || c === 'US' || c === 'USA';
};

const isAmazon = (...vals) => vals.some(v => /\bAMAZON\b/.test(upper(v)));

/**
 * Both shapes NRI uses in the same invoice:
 *   "SANMAR (98029SAN)"   — every returns line
 *   "49636COA - COASTAL"  — most other lines
 */
function customerCode(customer) {
  const s = norm(customer);
  const paren = /\(([^)]+)\)\s*$/.exec(s);
  if (paren) return paren[1].trim().toUpperCase();
  const dashed = /^([A-Za-z0-9]+)\s+-\s+/.exec(s);
  return dashed ? dashed[1].trim().toUpperCase() : null;
}

function customerName(customer) {
  const s = norm(customer);
  if (/\([^)]+\)\s*$/.test(s)) return s.replace(/\s*\([^)]*\)\s*$/, '').trim().toUpperCase() || null;
  const dashed = /^[A-Za-z0-9]+\s+-\s+(.+)$/.exec(s);
  return (dashed ? dashed[1] : s).trim().toUpperCase() || null;
}

/** Return-identifier format, the only channel signal on a returns line. */
function refFormatChannel(clientRef1) {
  const s = upper(clientRef1);
  if (!s) return null;
  if (/^RA\s*[:#]/.test(s)) return 'wholesale';
  if (/^RMA\s*#\s*\d+$/.test(s)) return 'wholesale';
  if (/^RMA\s*#/.test(s)) return 'online';
  if (/^RMA\s*\d+$/.test(s)) return 'wholesale';
  return null;
}

/** Declared accounts beat every inference — see README "Prep spec != sales channel". */
const CUSTOMER_CHANNEL = Object.freeze({
  '981110870NOR': 'wholesale',   // Nordstrom: wholesale revenue, ecom-style unit prep
  'NORDSTROM': 'wholesale',
});

/** Index the order master for lookup by order #, Ref2 and customer code/name. */
function buildOrderIndex(master) {
  const byOrder = master && master.byOrder ? master.byOrder : new Map();
  const byRef2 = new Map();
  const byCode = new Map();
  const byName = new Map();

  const bump = (m, k, o) => {
    if (!k) return;
    let t = m.get(k);
    if (!t) { t = new Map(); m.set(k, t); }
    const sig = `${o.orderType || ''}|${isUs(o.country) ? 'US' : 'INTL'}`;
    t.set(sig, (t.get(sig) || 0) + 1);
  };

  for (const o of byOrder.values()) {
    if (o.ref2) byRef2.set(upper(o.ref2), o);
    bump(byCode, o.custCode, o);
    bump(byName, o.custName, o);
  }

  // Dominant signature per customer, ties broken by name so it never depends on
  // row order (undefined in SQL; the same hazard already bit sms_packing_cartons).
  const collapse = m => {
    const out = new Map();
    for (const [k, t] of m) {
      let best = null;
      for (const [sig, n] of t) if (!best || n > best.n || (n === best.n && sig < best.sig)) best = { sig, n };
      if (best) {
        const [orderType, geo] = best.sig.split('|');
        out.set(k, { orderType, country: geo === 'US' ? 'UNITED STATES' : 'INTERNATIONAL' });
      }
    }
    return out;
  };

  return { byOrder, byRef2, byCode: collapse(byCode), byName: collapse(byName) };
}

const EMPTY_INDEX = Object.freeze({ byOrder: new Map(), byRef2: new Map(), byCode: new Map(), byName: new Map() });

function classOf(channel, country) {
  if (channel === 'wholesale') return CLASSES.US_WHOLESALE;
  if (channel === 'online') return isUs(country) ? CLASSES.US_ONLINE : CLASSES.INTL_ONLINE;
  return null;
}

/**
 * Resolve the class for one line.
 *
 * line: { service, clientRef1, clientRef2, customer, legendClass }
 * returns { class, channel, order_type, country, basis, confidence, resolved }
 *
 * `confidence`:
 *   'exact'      the line's own order was found
 *   'declared'   an account-level decision
 *   'derived'    the customer's dominant channel
 *   'inferred'   returns ref-format only
 *   'default'    no order behind the line — non-order services are wholesale
 *   'unresolved' an order-level line whose order is not in the master yet
 */
function resolveClass(line, index, options) {
  const idx = index || EMPTY_INDEX;
  const service = norm(line.service);
  const isReturns = RETURNS_SERVICES.includes(service);
  const cust = line.customer;

  // 0. Amazon is a marketplace, not a channel — it gets its own class.
  if (isAmazon(cust, line.clientRef1)) {
    return { class: CLASSES.AMAZON_US, channel: 'amazon', order_type: null, country: null,
      basis: 'amazon', confidence: 'declared', resolved: true };
  }

  // 1. Declared account channel.
  const declared = (options && options.customerChannels) || CUSTOMER_CHANNEL;
  const dc = declared[customerCode(cust)] || declared[customerName(cust)];
  if (dc) {
    return { class: classOf(dc, 'UNITED STATES'), channel: dc, order_type: null, country: null,
      basis: 'customer_declared', confidence: 'declared', resolved: true };
  }

  // 2. The line's own order.
  const attempts = [
    ['order_no', 'exact', () => idx.byOrder.get(upper(line.clientRef1))],
    ['ref2', 'exact', () => idx.byRef2.get(upper(line.clientRef2))],
    ['cust_code', 'derived', () => idx.byCode.get(customerCode(cust))],
    ['cust_name', 'derived', () => idx.byName.get(customerName(cust))],
  ];
  for (const [basis, confidence, get] of attempts) {
    const o = get();
    if (!o || !o.orderType) continue;
    const channel = CHANNEL[upper(o.orderType)];
    if (!channel) {
      return { class: null, channel: null, order_type: o.orderType, country: o.country || null,
        basis, confidence: 'unresolved', resolved: false,
        reason: `order type "${o.orderType}" has no channel mapping` };
    }
    return { class: classOf(channel, o.country), channel, order_type: o.orderType,
      country: o.country || null, basis, confidence, resolved: true };
  }

  // 3. Returns: the identifier format is the only remaining signal.
  if (isReturns && (!options || options.allowRefFormat !== false)) {
    const ch = refFormatChannel(line.clientRef1);
    if (ch) {
      return { class: classOf(ch, 'UNITED STATES'), channel: ch, order_type: null, country: null,
        basis: 'ref_format', confidence: 'inferred', resolved: true };
    }
  }

  // 4. Not an order-level charge at all — either the service is warehouse-wide or
  //    the line carries no reference. Wholesale by default, which is what finance
  //    does with them.
  if (NON_ORDER_SERVICES.has(upper(service)) || (!norm(line.clientRef1) && !norm(line.clientRef2))) {
    return { class: CLASSES.US_WHOLESALE, channel: 'wholesale', order_type: null, country: null,
      basis: 'non_order', confidence: 'default', resolved: true };
  }

  // 5. An order-level line whose order is not in the master yet.
  //
  //    Left NULL on purpose. Defaulting it to wholesale is exactly the error that
  //    makes the workbook report US - Whsle $38,369 against finance's $26,543, and
  //    the legend's class is not usable either — it has no channel or geography in
  //    it. This is a MISSING INPUT (the period's order CSV), not a judgement call,
  //    so it is surfaced as such.
  return {
    class: null, channel: null, order_type: null, country: null,
    basis: 'no_order_data', confidence: 'unresolved', resolved: false,
    reason: `order ${norm(line.clientRef1) || '(none)'} is not in the order master — needs the order data covering this period`,
  };
}

module.exports = {
  CLASSES, CHANNEL, RETURNS_SERVICES, NON_ORDER_SERVICES, CUSTOMER_CHANNEL,
  buildOrderIndex, resolveClass, customerCode, customerName, refFormatChannel, isUs, isAmazon, classOf,
};
