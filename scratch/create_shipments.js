const fs = require('fs');
const path = require('path');

const shipmentsPath = path.join(process.cwd(), 'backend', 'data', 'shipments.json');
let shipments = [];

try {
    shipments = JSON.parse(fs.readFileSync(shipmentsPath, 'utf8'));
} catch (e) {
    shipments = [];
}

const newShipments = [
    {
        id: "ship_gfl_1",
        po_number: "PO-FW26-004",
        season: "FW26",
        trn_number: "TRN-1004",
        type: "mainline",
        supplier: "Green Fabrics Ltd",
        mode: "Ocean",
        incoterm: "FOB",
        expected_qty: 3500,
        receiving_qty: 0,
        receiving_warehouse: "NRI US",
        etd: "2026-07-15",
        eta: "2026-08-10",
        booking_status: "Booking Approved",
        booking_number: "BKG-7721",
        vendor_name: "Green Fabrics Ltd",
        tentree_po_number: "PO-FW26-004",
        number_of_cartons: "50",
        cargo_ready_date: "2026-07-15",
        courier: "Maersk",
        tracking_number: "MSK12345678",
        submitted_at: new Date().toISOString(),
        expected_quantity: 1500,
        lot_number: 1,
        status: "Booking Approved",
        destination_warehouse: "NRI US"
    },
    {
        id: "ship_gfl_2",
        po_number: "PO-FW26-004",
        season: "FW26",
        trn_number: "TRN-1004",
        type: "mainline",
        supplier: "Green Fabrics Ltd",
        mode: "Ocean",
        incoterm: "FOB",
        expected_qty: 3500,
        receiving_qty: 0,
        receiving_warehouse: "NRI US",
        etd: "2026-07-20",
        eta: "2026-08-15",
        booking_status: "Booking Approved",
        booking_number: "BKG-7722",
        vendor_name: "Green Fabrics Ltd",
        tentree_po_number: "PO-FW26-004",
        number_of_cartons: "70",
        cargo_ready_date: "2026-07-20",
        courier: "Evergreen",
        tracking_number: "EVG98765432",
        submitted_at: new Date().toISOString(),
        expected_quantity: 2000,
        lot_number: 2,
        status: "Booking Approved",
        destination_warehouse: "NRI US"
    }
];

shipments.push(...newShipments);
fs.writeFileSync(shipmentsPath, JSON.stringify(shipments, null, 2));

// Update PO status
const posPath = path.join(process.cwd(), 'backend', 'data', 'purchase-orders.json');
let pos = JSON.parse(fs.readFileSync(posPath, 'utf8'));
const poIdx = pos.findIndex(p => p.po_number === 'PO-FW26-004');
if (poIdx > -1) {
    pos[poIdx].booking_status = "Booking Approved";
    pos[poIdx].booking_number = "BKG-7721, BKG-7722";
    fs.writeFileSync(posPath, JSON.stringify(pos, null, 2));
}

console.log('Successfully created 2 shipments for Green Fabrics Ltd to NRI US.');
