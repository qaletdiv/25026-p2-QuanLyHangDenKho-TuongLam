const integrationService = require('../services/integrationService');
const PurchaseOrderModel = require('../models/PurchaseOrderModel');

/**
 * GET /integrations/netsuite/pos
 *
 * Fetches open POs from NetSuite and upserts them into purchase-orders.json.
 * Matches on po_number — preserves booking_status and booking_number for
 * any PO already touched in the portal.
 *
 * Returns { added, updated, total } so the frontend can show a summary.
 */
async function getNetSuitePOs(req, res) {
    const maxResults = req.query.limit ? parseInt(req.query.limit, 10) : null;
    const incoming = await integrationService.fetchNetSuitePOs({ maxResults });

    const existing = await PurchaseOrderModel.read().catch(() => []);
    const combined = [...existing];

    let added   = 0;
    let updated = 0;

    incoming.forEach(nsPO => {
        if (!nsPO.po_number) return;

        const idx = combined.findIndex(p => p.po_number === nsPO.po_number);
        if (idx > -1) {
            // Only refresh NS-sourced fields — never touch portal-managed fields
            // (booking_status, booking_number).
            // line_items come from NS and are always authoritative for expected_qty;
            // they carry no CI or portal state so a full replace is safe.
            combined[idx] = {
                ...combined[idx],
                po_number:           nsPO.po_number,
                supplier:            nsPO.supplier,
                etd:                 nsPO.etd,
                eta:                 nsPO.eta,
                expected_qty:        nsPO.expected_qty,
                mode:                nsPO.mode,
                incoterm:            nsPO.incoterm,
                receiving_warehouse: nsPO.receiving_warehouse,
                season:              nsPO.season,
                trn_number:          nsPO.trn_number,
                type:                nsPO.type,
                netsuite_id:         nsPO.netsuite_id,
                // Replace line_items only when NS returned them (empty array is valid)
                ...(Array.isArray(nsPO.line_items) && { line_items: nsPO.line_items }),
            };
            updated++;
        } else {
            combined.push({
                id: Date.now().toString() + Math.random(),
                ...nsPO,
            });
            added++;
        }
    });

    await PurchaseOrderModel.write(combined);

    res.json({ added, updated, total: incoming.length });
}

module.exports = { getNetSuitePOs };
