'use strict';

// Landed-cost export → one xlsx per module, ONE flat sheet, built for PIVOTING.
//
// Built from the SAME read model the page renders (`getSms` / `getMainline` rows),
// not from a second query — so the spreadsheet cannot disagree with the screen.
// Everything here is derived at read like the rest of this module; nothing is
// stored and nothing is written.
//
// The sheet is at PO grain — the split, which is what actually lands on an Item
// Receipt — with the shipment's own attributes repeated on each of its lines.
// Three rules make that pivot-safe, and breaking any of them silently corrupts a
// pivot rather than erroring:
//   1. ONE row per PO line. The repetition of the shipment attributes is not
//      redundancy; it is what lets them serve as pivot row/column fields.
//   2. EVERY money column at PO grain, so Σ over any selection is correct. A
//      shipment-level total column beside them would be counted once per PO and
//      overstate a multi-PO shipment.
//   3. NO totals row. Excel takes the contiguous block as the pivot source range,
//      so a TOTAL row becomes a data row and every measure doubles.
// Both modules share the column list through `Status` and carry a `Module` column,
// so the two exports paste together into one pivot source.

const ExcelJS = require('exceljs');

const MONEY = '#,##0.00';
const money = (v) => (v == null ? null : Number(v));
const sum = (rows, pick) => Number(rows.reduce((a, r) => a + (Number(pick(r)) || 0), 0).toFixed(2));

// A shipment's state, in the words the page uses. Derived, same order of tests as
// the UI's block reasons, so the export never calls something postable that the
// screen greys out.
function smsStatus(r) {
  if (r.posted) return 'Posted';
  if (!r.has_shipping_data) return 'No shipping data';
  if (r.awaiting_actual) return 'Awaiting actual';
  if (!r.ir_resolved) return 'No IR match';
  if (!r.matched) return 'IR match unconfirmed';
  return 'Ready to post';
}

function mlStatus(r) {
  if (r.split.length && r.posted_count === r.split.length) return 'Posted';
  if (r.posted_count) return `Partially posted (${r.posted_count}/${r.split.length})`;
  if (!r.has_shipping_data) return 'No shipping data';
  if (r.awaiting_actual) return 'Awaiting actual';
  if (!r.ir_resolved) return 'No IR match';
  if (!r.matched) return 'IR match unconfirmed';
  return 'Ready to post';
}

function addSheet(wb, name, columns, data, moneyKeys, { totals = true } = {}) {
  const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = columns;
  const header = ws.getRow(1);
  header.font = { bold: true };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8E8E8' } };
  data.forEach((d) => ws.addRow(d));
  moneyKeys.forEach((k) => {
    const col = ws.getColumn(k);
    if (col) col.numFmt = MONEY;
  });
  // Totals, bold, one blank row below the data — so a reader who prints the sheet
  // sees the same figure the page footer shows.
  //
  // ⚠️ `totals: false` for a sheet meant to be PIVOTED. Excel takes the whole
  // contiguous block as the source range, so a TOTAL row becomes a data row and
  // every measure doubles.
  if (totals && data.length) {
    const t = ws.addRow({});
    const tot = ws.addRow(Object.fromEntries(moneyKeys.map((k) => [k, sum(data, (d) => d[k])])));
    tot.font = { bold: true };
    tot.getCell(1).value = 'TOTAL';
    moneyKeys.forEach((k) => { const c = tot.getCell(k); if (c) c.numFmt = MONEY; });
    void t;
  }
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
  return ws;
}

// ONE flat sheet at PO grain, same three pivot rules as mainline below.
//
// The column list mirrors mainline's through `Status`, so a mainline export pastes
// straight under an SMS one and the `Module` column tells them apart in the pivot.
// Two SMS-only attributes (Supplier, Season) are APPENDED after the shared block
// rather than interleaved — mainline's read model carries neither, and adding two
// permanently blank columns to that export to force symmetry would read as a bug
// to whoever opened it. `Shipment #` holds the tracking number, which is what
// identifies an SMS consignment (the same substitution smsDocumentService makes).
function smsWorkbook(rows) {
  const wb = new ExcelJS.Workbook();

  addSheet(wb, 'Landed Costs', [
    { header: 'Module', key: 'module', width: 10 },
    { header: 'Ship date', key: 'ship_date', width: 12 },
    { header: 'Month', key: 'ship_month', width: 10 },
    { header: 'Shipment #', key: 'shipment_number', width: 18 },
    { header: 'Carrier Ref #', key: 'carrier_reference', width: 18 },
    { header: 'Customs entry #', key: 'customs_entry_number', width: 18 },
    { header: 'Destination', key: 'facility', width: 16 },
    { header: 'Carrier', key: 'courier', width: 14 },
    { header: 'Mode', key: 'mode', width: 10 },
    { header: 'Basis', key: 'basis', width: 10 },
    { header: 'Freight %', key: 'freight_pct', width: 10 },
    { header: 'Duty %', key: 'duty_pct', width: 10 },
    { header: 'PO #', key: 'po_number', width: 14 },
    { header: 'CI value', key: 'ci_value', width: 14 },
    { header: 'Freight', key: 'freight', width: 12 },
    { header: 'Duty', key: 'duty', width: 12 },
    { header: 'Commission', key: 'commission', width: 12 },
    { header: 'Total', key: 'total', width: 14 },
    { header: 'Item Receipt', key: 'ir', width: 14 },
    { header: 'IR confirmed', key: 'ir_confirmed', width: 13 },
    { header: 'Posted', key: 'posted', width: 10 },
    { header: 'Posted at', key: 'posted_at', width: 22 },
    { header: 'Status', key: 'status', width: 20 },
    { header: 'Supplier', key: 'supplier', width: 30 },
    { header: 'Season', key: 'season', width: 10 },
  ], rows.flatMap((r) => {
    const byPo = new Map((r.match || []).map((m) => [m.po_number, m]));
    const status = smsStatus(r);
    // SMS posts per SHIPMENT (one customs entry), so every PO line of a posted
    // consignment is posted — unlike mainline, where it is per PO.
    const posted = r.posted ? 'Yes' : 'No';
    // A posted row records its OWN rates; `freight_pct` NULL on the snapshot IS the
    // record of "these were actuals off the bill" (see CLAUDE.md).
    const freight_pct = r.posted ? r.posted.freight_pct : (r.is_booked ? null : r.estimate.freight_pct);
    const duty_pct = r.posted ? r.posted.duty_pct : (r.is_booked ? null : r.estimate.duty_pct);
    // A consignment with no shipping data has an EMPTY split (it is apportioned by
    // CI value), which would drop it from the export entirely — including a booked
    // one whose broker bill is already entered. Fall back to zero-amount lines from
    // its POs, exactly as the page does; the Status column says why they are zero.
    const split = (r.split && r.split.length)
      ? r.split
      : (r.pos || []).map((po) => ({ po_number: po, ci_value: 0, freight: 0, duty: 0, commission: 0 }));
    return split.map((sp) => {
      const m = byPo.get(sp.po_number);
      return {
        module: 'SMS',
        ship_date: r.ship_date, ship_month: r.ship_month,
        shipment_number: r.tracking_number,
        carrier_reference: null,            // no SMS equivalent — mainline-only field
        customs_entry_number: r.customs_entry_number,
        facility: r.facility, courier: r.courier, mode: r.mode,
        basis: r.basis, freight_pct, duty_pct,
        po_number: sp.po_number,
        ci_value: money(sp.ci_value), freight: money(sp.freight), duty: money(sp.duty),
        commission: money(sp.commission),
        total: money(Number(((sp.freight || 0) + (sp.duty || 0) + (sp.commission || 0)).toFixed(2))),
        ir: m ? m.netsuite_ir_tranid : null,
        ir_confirmed: m ? (m.confirmed ? 'Yes' : 'No') : 'No',
        posted,
        posted_at: r.posted ? r.posted.posted_at : null,
        status,
        supplier: r.supplier, season: r.season,
      };
    });
  }), ['ci_value', 'freight', 'duty', 'commission', 'total'], { totals: false });

  return wb;
}

// ONE flat sheet, at PO grain, for pivoting (Lam, 2026-09-16).
//
// Three rules make it pivot-safe, and breaking any of them silently corrupts a
// pivot rather than erroring:
//   1. ONE row per PO line — the finest grain. Shipment attributes (date, carrier,
//      basis, status…) REPEAT down the rows; that repetition is what lets them be
//      used as pivot row/column fields.
//   2. EVERY money column is at PO grain, so Σ over any selection is correct. A
//      shipment-level total column alongside them would be counted once per PO and
//      overstate a multi-PO shipment.
//   3. NO totals row — Excel takes the contiguous block as the source range, so a
//      TOTAL row becomes a data row and every measure doubles.
function mainlineWorkbook(rows) {
  const wb = new ExcelJS.Workbook();

  addSheet(wb, 'Landed Costs', [
    { header: 'Module', key: 'module', width: 10 },
    { header: 'Ship date', key: 'ship_date', width: 12 },
    { header: 'Month', key: 'ship_month', width: 10 },
    { header: 'Shipment #', key: 'shipment_number', width: 14 },
    { header: 'Carrier Ref #', key: 'carrier_reference', width: 18 },
    { header: 'Customs entry #', key: 'customs_entry_number', width: 18 },
    { header: 'Destination', key: 'facility', width: 16 },
    { header: 'Carrier', key: 'courier', width: 14 },
    { header: 'Mode', key: 'mode', width: 10 },
    { header: 'Basis', key: 'basis', width: 10 },
    { header: 'Freight %', key: 'freight_pct', width: 10 },
    { header: 'Duty %', key: 'duty_pct', width: 10 },
    { header: 'PO #', key: 'po_number', width: 14 },
    { header: 'CI value', key: 'ci_value', width: 14 },
    { header: 'Freight', key: 'freight', width: 12 },
    { header: 'Duty', key: 'duty', width: 12 },
    { header: 'Commission', key: 'commission', width: 12 },
    { header: 'Total', key: 'total', width: 14 },
    { header: 'Item Receipt', key: 'ir', width: 14 },
    { header: 'IR confirmed', key: 'ir_confirmed', width: 13 },
    { header: 'Posted', key: 'posted', width: 10 },
    { header: 'Posted at', key: 'posted_at', width: 22 },
    { header: 'Status', key: 'status', width: 24 },
  ], rows.flatMap((r) => {
    const byPo = new Map((r.match || []).map((m) => [m.po_number, m]));
    const status = mlStatus(r);
    // Mainline posts PER PO, so the posted flag belongs on the line, not the header.
    return (r.split || []).map((sp) => {
      const m = byPo.get(sp.po_number);
      return {
        module: 'Mainline',
        ship_date: r.ship_date, ship_month: r.ship_month,
        shipment_number: r.shipment_number, carrier_reference: r.carrier_reference,
        customs_entry_number: r.customs_entry_number,
        facility: r.facility, courier: r.courier, mode: r.mode,
        basis: r.basis,
        // Only an ESTIMATE-basis shipment has rates; a forwarder one carries actuals.
        freight_pct: r.is_estimate ? r.estimate.freight_pct : null,
        duty_pct: r.is_estimate ? r.estimate.duty_pct : null,
        po_number: sp.po_number,
        ci_value: money(sp.ci_value), freight: money(sp.freight), duty: money(sp.duty),
        commission: money(sp.commission),
        total: money(Number(((sp.freight || 0) + (sp.duty || 0) + (sp.commission || 0)).toFixed(2))),
        ir: m ? m.netsuite_ir_tranid : null,
        ir_confirmed: m ? (m.confirmed ? 'Yes' : 'No') : 'No',
        posted: sp.posted ? 'Yes' : 'No',
        posted_at: sp.posted ? sp.posted.posted_at : null,
        status,
      };
    });
  }), ['ci_value', 'freight', 'duty', 'commission', 'total'], { totals: false });

  return wb;
}

/** @returns {Promise<Buffer>} */
function build(module, rows) {
  const wb = module === 'mainline' ? mainlineWorkbook(rows) : smsWorkbook(rows);
  return wb.xlsx.writeBuffer();
}

module.exports = { build };
