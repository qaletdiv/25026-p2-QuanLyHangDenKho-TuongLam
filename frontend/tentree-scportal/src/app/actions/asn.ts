'use server';

import { updateShipment } from './shipments';
import { revalidatePath } from 'next/cache';

export async function submitAsnWorkflow(formData: FormData) {
  const shipmentId = formData.get('shipmentId') as string;
  const receivedQuantity = formData.get('receivedQuantity') as string; // Cartons
  const receivedUnits = formData.get('receivedUnits') as string; // Units
  const invoiceValue = formData.get('invoiceValue') as string;
  const duty = formData.get('duty') as string;
  const freight = formData.get('freight') as string;
  const file = formData.get('invoiceFile') as File | null;

  if (!shipmentId) {
    return { error: 'Shipment ID is required' };
  }

  try {
    // 1. Upload file if present
    let ciUrl = '';
    if (file && file.size > 0) {
      console.log(`[UPLOAD] Uploading file: ${file.name} (${file.size} bytes)`);
      const { fetchApi } = await import('@/lib/api');
      const formDataUpload = new FormData();
      formDataUpload.append('file', file);
      
      const uploadRes = await fetchApi('/documents/upload', {
        method: 'POST',
        body: formDataUpload,
      });
      
      if (uploadRes && uploadRes.url) {
        ciUrl = uploadRes.url;
      } else {
        console.error('Failed to get url from upload endpoint');
      }
    }

    // 2. Fetch the existing shipment to check for splitting
    const { getShipments, createShipment } = await import('./shipments');
    const allShipments = await getShipments();
    const existing = allShipments.find((s: any) => s.id === shipmentId);

    if (!existing) {
      return { error: 'Shipment not found' };
    }

    const expUnits = parseInt(existing.expected_units || existing.expected_quantity || '0');
    const recUnits = parseInt(receivedUnits || '0');

    // 3. Update the current shipment
    const partialUpdate: any = {
      received_quantity: receivedQuantity || '',
      received_units: receivedUnits || '',
      invoice_value: invoiceValue || '',
      duty: duty || '',
      freight: freight || '',
      asn_sent: true,
      status: 'In-Transit',
      commercial_invoice_url: ciUrl || existing.commercial_invoice_url || ''
    };

    // If it's a split, mark as Lot 1 if not already
    if (recUnits > 0 && recUnits < expUnits) {
      partialUpdate.lot_number = existing.lot_number || 1;
      partialUpdate.expected_units = receivedUnits;
      partialUpdate.expected_quantity = receivedQuantity; // Adjust expected to what was actually shipped for this lot
      
      // 4. Create Lot 2 for the remainder
      const remainderUnits = expUnits - recUnits;
      const lot2 = {
        ...existing,
        id: undefined, // Let backend generate new ID
        lot_number: (existing.lot_number || 1) + 1,
        expected_units: remainderUnits.toString(),
        expected_quantity: (parseInt(existing.expected_quantity || '0') - parseInt(receivedQuantity || '0')).toString(),
        status: 'Ready to Ship',
        asn_sent: false,
        received_quantity: '',
        received_units: '',
        tracking_number: '',
        commercial_invoice_url: '',
        booking_number: '' // Remainder needs new booking/tracking
      };
      
      await createShipment(lot2);
      console.log(`[LOT SPLIT] Created Lot ${lot2.lot_number} for PO ${existing.po_number} with ${remainderUnits} units remaining.`);
    }

    // 5. Update the current record
    await updateShipment(shipmentId, partialUpdate);

    revalidatePath('/shipments');
    return { success: true, ciUrl: partialUpdate.commercial_invoice_url };
  } catch (error) {
    console.error('Error in submitAsnWorkflow:', error);
    return { error: 'Failed to process ASN workflow' };
  }
}
