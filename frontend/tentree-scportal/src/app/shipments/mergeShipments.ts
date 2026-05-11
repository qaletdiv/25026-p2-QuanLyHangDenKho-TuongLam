/** Merges active POs and shipments into a unified list for the tracker. */
export function mergeShipmentsAndPOs(shipmentData: any[], poData: any[]): any[] {
  const activeShipments = shipmentData || [];
  const activePOs = poData || [];
  const merged: any[] = [];
  const processedShipmentIds = new Set<string>();

  activePOs.forEach((po: any) => {
    const linked = activeShipments.filter((s: any) => s.po_number === po.po_number);
    const poExpected = parseInt(po.expected_qty || '0', 10);
    const totalExpectedInLots = linked.reduce(
      (sum: number, s: any) => sum + parseInt(s.expected_quantity || '0', 10),
      0
    );

    if (linked.length > 0) {
      linked.forEach((s: any) => {
        merged.push({
          ...po,
          ...s,
          expected_quantity: s.expected_quantity || po.expected_qty || '',
          destination_warehouse: s.destination_warehouse || po.receiving_warehouse || '',
          courier: s.courier || po.courier || '',
          type: s.type || po.type || (s.mode === 'Courier' ? 'sms' : 'mainline'),
        });
        processedShipmentIds.add(s.id);
      });

      if (totalExpectedInLots < poExpected) {
        merged.push({
          ...po,
          id: `po-${po.id}-unassigned`,
          status: 'No Booking',
          booking_status: 'No Booking',
          booking_number: '',
          expected_quantity: poExpected - totalExpectedInLots,
          destination_warehouse: po.receiving_warehouse || '',
          courier: po.courier || '',
          type: po.type || (po.mode === 'Courier' ? 'sms' : 'mainline'),
        });
      }
    } else {
      merged.push({
        ...po,
        id: `po-${po.id}`,
        status: 'No Booking',
        booking_status: po.booking_status || 'No Booking',
        booking_number: '',
        expected_quantity: po.expected_qty || '',
        destination_warehouse: po.receiving_warehouse || '',
        courier: po.courier || '',
        type: po.type || (po.mode === 'Courier' ? 'sms' : 'mainline'),
      });
    }
  });

  activeShipments.forEach((s: any) => {
    if (!processedShipmentIds.has(s.id)) {
      merged.push({ ...s, type: s.type || (s.mode === 'Courier' ? 'sms' : 'mainline') });
    }
  });

  return merged;
}
