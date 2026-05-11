const xlsx = require('xlsx');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, '../data');
const posFile = path.join(dataDir, 'purchase-orders.json');
const pos = JSON.parse(fs.readFileSync(posFile, 'utf8'));

function createTemplate(filename, invoiceNumber, posToInclude) {
    const wb = xlsx.utils.book_new();
    const wsData = [
        ['Invoice Information', '', '', ''], // Row 1
        ['Invoice #', invoiceNumber, 'Date', '2026-05-08'], // Row 2
        ['', '', '', ''], // Row 3
        ['SKU Code', 'Description', 'Quantity', 'Unit Price', 'Total Price'], // Row 4 (Headers)
    ];
    
    // Row 5+ (Data)
    posToInclude.forEach(poNum => {
        const po = pos.find(p => p.po_number === poNum);
        if (po && po.line_items) {
            po.line_items.forEach(item => {
                wsData.push([
                    item.sku_code, 
                    item.description, 
                    item.expected_qty, 
                    item.unit_price, 
                    item.expected_qty * item.unit_price
                ]);
            });
        }
    });
    
    const ws = xlsx.utils.aoa_to_sheet(wsData);
    xlsx.utils.book_append_sheet(wb, ws, 'Sheet1');
    
    const outPath = path.join(dataDir, filename);
    xlsx.writeFile(wb, outPath);
    console.log(`Created ${outPath}`);
}

// Single PO data (PO-FW26-001)
createTemplate('ci_template_test.xlsx', 'INV-FW26-001', ['PO-FW26-001']);

// Multi PO data (PO-FW26-002 and PO-FW26-003)
createTemplate('ci_template_multi.xlsx', 'INV-MULTI-FW26', ['PO-FW26-002', 'PO-FW26-003']);
