const request = require('supertest');
const app = require('../server');
const driveStorage = require('../driveStorage');

jest.mock('../driveStorage');

describe('Booking Lifecycle & Lot Logic', () => {
    let mockPos = [
        { po_number: 'PO_FULL', expected_qty: 100, received_qty: 0, type: 'mainline' },
        { po_number: 'PO_PARTIAL', expected_qty: 100, received_qty: 0, type: 'sms' },
        { po_number: 'PO_LOT2', expected_qty: 100, received_qty: 20, type: 'mainline' }
    ];
    let mockShipments = [];
    let mockBookings = [];

    beforeEach(() => {
        mockShipments = [];
        mockBookings = [];
        driveStorage.readData.mockImplementation(async (filename) => {
            if (filename === 'purchase-orders.json') return mockPos;
            if (filename === 'shipments.json') return mockShipments;
            if (filename === 'bookings.json') return mockBookings;
            if (filename === 'history.json') return [];
            return [];
        });
        driveStorage.writeData.mockImplementation(async (filename, data) => {
            if (filename === 'shipments.json') mockShipments = data;
            if (filename === 'bookings.json') mockBookings = data;
        });
    });

    test('SMS booking should route directly to shipments and calculate Lot 1', async () => {
        const payload = {
            type: 'sms',
            vendor_name: 'Test Vendor',
            mode: 'Courier',
            po_details: [{ po_number: 'PO_PARTIAL', units: '40' }]
        };

        const res = await request(app).post('/bookings').send(payload);
        
        expect(res.statusCode).toBe(201);
        expect(mockBookings.length).toBe(0); // Should not create booking
        expect(mockShipments.length).toBe(1); // Should create shipment
        expect(mockShipments[0].lot_number).toBe(1); // Partial quantity, 0 received
    });

    test('Mainline booking should stay in bookings as Pending', async () => {
        const payload = {
            type: 'mainline',
            vendor_name: 'Test Vendor',
            mode: 'Ocean',
            po_details: [{ po_number: 'PO_FULL', units: '100' }]
        };

        const res = await request(app).post('/bookings').send(payload);
        
        expect(res.statusCode).toBe(201);
        expect(mockBookings.length).toBe(1);
        expect(mockBookings[0].booking_status).toBe('Booking Pending');
        expect(mockShipments.length).toBe(0); // Should not create shipment yet
    });

    test('Approval of Mainline booking should move it to shipments and calculate Lot 2', async () => {
        // Setup existing booking and shipment
        mockBookings = [{
            id: 'bkg_123',
            type: 'mainline',
            booking_status: 'Booking Pending',
            po_details: [{ po_number: 'PO_LOT2', units: '80' }]
        }];
        // Mock a previous shipment to Lot 2 logic works (80 units + 20 received = 100 total)
        mockPos[2].received_qty = 20; 
        // Also need to mock previously processed shipments if we used lot_number 1
        mockShipments = [{ po_number: 'PO_LOT2', received_quantity: 20, lot_number: 1 }];

        const res = await request(app)
            .put('/bookings/bkg_123')
            .send({ booking_status: 'Booking Approved' });

        expect(res.statusCode).toBe(200);
        // Should have 2 shipments now (original + new one from approval)
        expect(mockShipments.length).toBe(2);
        const newShipment = mockShipments.find(s => s.status === 'Booking Approved');
        expect(newShipment.lot_number).toBe(2); // 80 (booked) + 20 (received) == 100 (total)
    });

    test('Bulk submission should apply lot logic independently per PO', async () => {
        const payload = {
            type: 'sms',
            po_details: [
                { po_number: 'PO_PARTIAL', units: '40' }, // Lot 1
                { po_number: 'PO_FULL', units: '100' }   // No Lot
            ]
        };

        const res = await request(app).post('/bookings').send(payload);
        
        expect(res.statusCode).toBe(201);
        expect(mockShipments.length).toBe(2);
        
        const partial = mockShipments.find(s => s.po_number === 'PO_PARTIAL');
        const full = mockShipments.find(s => s.po_number === 'PO_FULL');
        
        expect(partial.lot_number).toBe(1);
        expect(full.lot_number).toBe(null);
    });
});
