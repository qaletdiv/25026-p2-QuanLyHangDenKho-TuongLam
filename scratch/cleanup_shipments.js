const fs = require('fs');
const path = require('path');

const shipmentsPath = path.join(process.cwd(), 'backend', 'data', 'shipments.json');

try {
    let shipments = JSON.parse(fs.readFileSync(shipmentsPath, 'utf8'));
    
    // 1. Remove empty/ghost POs
    const beforeCount = shipments.length;
    shipments = shipments.filter(s => s.po_number && s.po_number.trim() !== '');
    const removedEmpty = beforeCount - shipments.length;

    // 2. Fix duplicate IDs by giving them new unique IDs
    const idSet = new Set();
    let fixedDuplicates = 0;
    
    shipments = shipments.map(s => {
        if (idSet.has(s.id)) {
            fixedDuplicates++;
            s.id = Date.now().toString() + Math.random().toString(36).substr(2, 5);
        }
        idSet.add(s.id);
        return s;
    });

    fs.writeFileSync(shipmentsPath, JSON.stringify(shipments, null, 2));
    console.log(`Cleanup complete! Removed ${removedEmpty} ghost shipments. Fixed ${fixedDuplicates} duplicate IDs.`);
} catch (e) {
    console.error('Error cleaning up data:', e);
}
