'use strict';

// SMS derivations — status, rollups, reconciliation, IR auto-match. Everything
// here is computed at read-time and never stored (same rule as mainline).

// ---- shipment status --------------------------------------------------------
// DISPLAYED status = the latest courier tracking event mapped through
// courier_status_map; a shipment with no events falls back to the manually
// entered status. Returns { status_id, status, status_source }.
function deriveStatus(shipment, eventsByShipment, codeMap, statusNameById) {
  const events = eventsByShipment[shipment.id] || [];
  // Order by actual INSTANT — FedEx stamps each scan in the scan location's local
  // timezone (mixed offsets), so a string sort scrambles the sequence. Then use
  // the newest event whose code IS mapped, so an unmapped latest scan (e.g. an
  // exotic FedEx code) doesn't blank out the courier status.
  const byInstantDesc = [...events].sort((a, b) => Date.parse(b.event_time) - Date.parse(a.event_time));
  for (const e of byInstantDesc) {
    const mapped = codeMap.get(`${shipment.courier_id}|${e.courier_code}`);
    if (mapped) return { status_id: mapped, status: statusNameById.get(mapped) || null, status_source: 'courier' };
  }
  return {
    status_id: shipment.manual_status_id || null,
    status: statusNameById.get(shipment.manual_status_id) || null,
    status_source: 'manual',
  };
}

// ---- shipping-data (packing cartons) derivations ----------------------------
// Shipped truth per PO: if the vendor has uploaded shipping data (carton × SKU
// detail), shipped = Σ pcs_per_ctn from those cartons (SKU-grained, confirmed);
// otherwise fall back to the declared Σ sms_shipment_pos.units (PO-grain estimate).
// Σ packing pcs per PO
function packingShippedByPo(packingCartons) {
  const m = new Map();
  packingCartons.forEach((c) => m.set(c.po_number, (m.get(c.po_number) || 0) + (Number(c.pcs_per_ctn) || 0)));
  return m;
}
// Σ packing pcs per (po, sku)
function packingShippedByPoSku(packingCartons) {
  const m = new Map();
  packingCartons.forEach((c) => {
    const k = `${c.po_number}|${c.sku_code}`;
    m.set(k, (m.get(k) || 0) + (Number(c.pcs_per_ctn) || 0));
  });
  return m;
}
// Distinct physical cartons per PO from uploaded shipping data (unique ctn_number).
// Used as the fallback carton count when the vendor didn't declare one at entry —
// the packing list is the actual truth (same spirit as packed pcs overriding
// declared units in poRollups). Pass cartons already scoped to the shipment.
function packingCartonsCountByPo(packingCartons) {
  const sets = new Map();
  packingCartons.forEach((c) => {
    if (c.ctn_number == null) return;
    if (!sets.has(c.po_number)) sets.set(c.po_number, new Set());
    sets.get(c.po_number).add(c.ctn_number);
  });
  const m = new Map();
  sets.forEach((set, po) => m.set(po, set.size));
  return m;
}

// Packing summary for a set of carton rows (per shipment or per PO). Weights are
// carton-level facts so they're counted once per distinct carton; value is Σ line.
function packingSummary(cartons) {
  const seenCtn = new Set();
  let pcs = 0, value = 0, net = 0, gross = 0, cbm = 0;
  cartons.forEach((c) => {
    pcs += Number(c.pcs_per_ctn) || 0;
    value += Number(c.total_usd) || (Number(c.pcs_per_ctn) || 0) * (Number(c.unit_price) || 0);
    if (!seenCtn.has(c.ctn_number)) {
      seenCtn.add(c.ctn_number);
      net += Number(c.net_weight_kgs) || 0;
      gross += Number(c.gross_weight_kgs) || 0;
      const d = String(c.measure_cm || '').split(/[*×xX]/).map((p) => parseFloat(p.trim()));
      if (d.length === 3 && d.every((v) => !isNaN(v))) cbm += (d[0] * d[1] * d[2]) / 1e6;
    }
  });
  return {
    total_pcs: pcs, total_cartons: seenCtn.size, total_value: +value.toFixed(2),
    total_net_weight: +net.toFixed(2), total_gross_weight: +gross.toFixed(2), total_cbm: +cbm.toFixed(3),
  };
}

// ---- per-PO rollups ---------------------------------------------------------
// ordered  = Σ sms_po_lines.ordered_qty
// shipped  = Σ packing pcs when shipping data exists, else Σ sms_shipment_pos.units
// received = Σ sms_item_receipt_lines.qty (via the PO's receipts)
function poRollups({ poLines, shipmentPos, receipts, receiptLines, packingCartons = [] }) {
  const ordered = new Map();
  poLines.forEach((l) => ordered.set(l.po_number, (ordered.get(l.po_number) || 0) + (Number(l.ordered_qty) || 0)));

  const declared = new Map();
  const lots = new Map();
  shipmentPos.forEach((j) => {
    declared.set(j.po_number, (declared.get(j.po_number) || 0) + (Number(j.units) || 0));
    lots.set(j.po_number, Math.max(lots.get(j.po_number) || 0, Number(j.lot_number) || 0));
  });
  const packed = packingShippedByPo(packingCartons);
  // packed truth overrides declared where present
  const shipped = new Map(declared);
  packed.forEach((v, po) => shipped.set(po, v));

  const linesByReceipt = receiptLines.reduce((m, l) => ((m[l.receipt_id] = (m[l.receipt_id] || 0) + (Number(l.qty) || 0)), m), {});
  const received = new Map();
  receipts.forEach((r) => received.set(r.po_number, (received.get(r.po_number) || 0) + (linesByReceipt[r.id] || 0)));

  return { ordered, shipped, received, lots };
}

// ---- reconciliation (one PO) ------------------------------------------------
// PO grain: ordered vs shipped vs received (+remaining/variance). SKU grain:
// ordered vs SHIPPED vs received per SKU. Shipped-per-SKU comes from the uploaded
// shipping data (sms_packing_cartons); when none exists yet the per-SKU shipped
// is 0 (only the PO-grain declared total is known) and shipped_total falls back
// to the declared Σ sms_shipment_pos.units.
function reconcilePo(poNumber, { poLines, shipmentPos, receipts, receiptLines, packingCartons = [] }) {
  const myLines = poLines.filter((l) => l.po_number === poNumber);
  const ordered_total = myLines.reduce((a, l) => a + (Number(l.ordered_qty) || 0), 0);

  const myCartons = packingCartons.filter((c) => c.po_number === poNumber);
  const hasShippingData = myCartons.length > 0;
  const declared_total = shipmentPos.filter((j) => j.po_number === poNumber).reduce((a, j) => a + (Number(j.units) || 0), 0);
  const packed_total = myCartons.reduce((a, c) => a + (Number(c.pcs_per_ctn) || 0), 0);
  const shipped_total = hasShippingData ? packed_total : declared_total;

  const shippedBySku = new Map();
  myCartons.forEach((c) => shippedBySku.set(c.sku_code, (shippedBySku.get(c.sku_code) || 0) + (Number(c.pcs_per_ctn) || 0)));

  const myReceiptIds = new Set(receipts.filter((r) => r.po_number === poNumber).map((r) => r.id));
  const myReceiptLines = receiptLines.filter((l) => myReceiptIds.has(l.receipt_id));
  const received_total = myReceiptLines.reduce((a, l) => a + (Number(l.qty) || 0), 0);

  const receivedBySku = new Map();
  myReceiptLines.forEach((l) => receivedBySku.set(l.sku_code, (receivedBySku.get(l.sku_code) || 0) + (Number(l.qty) || 0)));

  const skuCodes = [...new Set([...myLines.map((l) => l.sku_code), ...shippedBySku.keys(), ...receivedBySku.keys()])].sort();
  const by_sku = skuCodes.map((sku_code) => {
    const ordered_qty = myLines.filter((l) => l.sku_code === sku_code).reduce((a, l) => a + (Number(l.ordered_qty) || 0), 0);
    const shipped_qty = shippedBySku.get(sku_code) || 0;
    const received_qty = receivedBySku.get(sku_code) || 0;
    // variance = shipped − received (matches PO-grain shipped_vs_received_variance).
    // >0 short-received / still in transit, <0 over-received. NOT vs ordered — an
    // un-shipped SKU isn't a receiving discrepancy, just not shipped yet.
    return { sku_code, ordered_qty, shipped_qty, received_qty, variance: shipped_qty - received_qty };
  });

  return {
    po_number: poNumber,
    ordered_total, shipped_total, received_total,
    has_shipping_data: hasShippingData,
    remaining_to_ship: ordered_total - shipped_total,
    shipped_vs_received_variance: shipped_total - received_total,
    by_sku,
  };
}

// (The IR ↔ consignment auto-match suggestion was removed with the receiving
//  page 2026-07-03 — receipts sync from NetSuite and feed reconcilePo directly,
//  aggregated per PO, so no lot-level matching is needed.)

module.exports = { deriveStatus, poRollups, reconcilePo, packingSummary, packingShippedByPo, packingShippedByPoSku, packingCartonsCountByPo };
