const fs = require('fs');
const path = require('path');

const dataDir = path.join(process.cwd(), 'backend', 'data');

const fixRecord = () => {
    const bookingsPath = path.join(dataDir, 'bookings.json');
    const shipmentsPath = path.join(dataDir, 'shipments.json');
    const posPath = path.join(dataDir, 'purchase-orders.json');

    let bookings = JSON.parse(fs.readFileSync(bookingsPath, 'utf8'));
    let shipments = JSON.parse(fs.readFileSync(shipmentsPath, 'utf8'));
    let pos = JSON.parse(fs.readFileSync(posPath, 'utf8'));

    // Find the rogue SMS booking
    const rogueIdx = bookings.findIndex(b => b.tentree_po_number === 'PO-SS26-002' && b.type === 'sms');
    if (rogueIdx > -1) {
        const b = bookings[rogueIdx];
        const po = pos.find(p => p.po_number === 'PO-SS26-002') || {};

        const newShipment = {
            id: Date.now().toString(),
            ...po,
            ...b,
            expected_quantity: b.po_details[0].units,
            lot_number: null, // 250 == 250, so null
            status: 'Ready to Ship',
            booking_status: 'No Booking',
            type: 'sms',
            etd: b.cargo_ready_date,
            supplier: b.vendor_name,
            destination_warehouse: b.receiving_warehouse
        };
        delete newShipment.po_details;
        
        shipments.push(newShipment);
        bookings.splice(rogueIdx, 1);

        fs.writeFileSync(bookingsPath, JSON.stringify(bookings, null, 2));
        fs.writeFileSync(shipmentsPath, JSON.stringify(shipments, null, 2));
        console.log('Fixed PO-SS26-002: Moved from bookings to shipments and mapped fields.');
    } else {
        console.log('Rogue record not found or already fixed.');
    }
};

fixRecord();
