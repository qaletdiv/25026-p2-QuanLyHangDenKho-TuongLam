'use server';

import { updateShipment } from './shipments';
import { revalidatePath } from 'next/cache';

export async function submitAsnWorkflow(formData: FormData) {
  // Accept either shipmentIds (JSON array) or legacy single shipmentId
  const shipmentIdsRaw = formData.get('shipmentIds') as string;
  const legacyId = formData.get('shipmentId') as string;
  const ids: string[] = shipmentIdsRaw
    ? JSON.parse(shipmentIdsRaw)
    : legacyId ? [legacyId] : [];

  if (!ids.length) {
    return { error: 'Shipment ID is required' };
  }

  const receivedQuantity = formData.get('receivedQuantity') as string; // Cartons
  const receivedUnits    = formData.get('receivedUnits')    as string; // Units
  const invoiceValue     = formData.get('invoiceValue')     as string;
  const duty             = formData.get('duty')             as string;
  const freight          = formData.get('freight')          as string;
  const file             = formData.get('invoiceFile')      as File | null;

  try {
    // 1. Upload file if present
    let ciUrl = '';
    if (file && file.size > 0) {
      const { fetchApi } = await import('@/lib/api');
      const formDataUpload = new FormData();
      formDataUpload.append('file', file);
      const uploadRes = await fetchApi('/documents/upload', {
        method: 'POST',
        body: formDataUpload,
      });
      if (uploadRes && uploadRes.url) {
        ciUrl = uploadRes.url;
      }
    }

    const { getShipments, createShipment } = await import('./shipments');
    const allShipments = await getShipments();

    const baseUpdate: any = {
      received_quantity:       receivedQuantity || '',
      received_units:          receivedUnits    || '',
      invoice_value:           invoiceValue     || '',
      duty:                    duty             || '',
      freight:                 freight          || '',
      asn_sent:                true,
      status:                  'In-Transit',
    };

    if (ids.length === 1) {
      // ── Single shipment: apply lot-split logic as before ──────────────
      const existing = allShipments.find((s: any) => s.id === ids[0]);
      if (!existing) return { error: 'Shipment not found' };

      const expUnits = parseInt(existing.expected_units || existing.expected_quantity || '0');
      const recUnits = parseInt(receivedUnits || '0');

      const update = {
        ...baseUpdate,
        commercial_invoice_url: ciUrl || existing.commercial_invoice_url || '',
      };

      if (recUnits > 0 && recUnits < expUnits) {
        update.lot_number      = existing.lot_number || 1;
        update.expected_units  = receivedUnits;
        update.expected_quantity = receivedQuantity;

        const remainderUnits = expUnits - recUnits;
        const lot2 = {
          ...existing,
          id:                       undefined,
          lot_number:               (existing.lot_number || 1) + 1,
          expected_units:           remainderUnits.toString(),
          expected_quantity:        (parseInt(existing.expected_quantity || '0') - parseInt(receivedQuantity || '0')).toString(),
          status:                   'Ready to Ship',
          asn_sent:                 false,
          received_quantity:        '',
          received_units:           '',
          tracking_number:          '',
          commercial_invoice_url:   '',
          booking_number:           '',
        };
        await createShipment(lot2);
      }

      await updateShipment(ids[0], update);
    } else {
      // ── Multi-shipment booking: update all, no lot-split ─────────────
      await Promise.all(
        ids.map(async (id) => {
          const existing = allShipments.find((s: any) => s.id === id);
          if (!existing) return;
          await updateShipment(id, {
            ...baseUpdate,
            commercial_invoice_url: ciUrl || existing.commercial_invoice_url || '',
          });
        })
      );
    }

    revalidatePath('/shipments');
    return { success: true, ciUrl };
  } catch (error: any) {
    return { error: error?.message || 'Failed to process ASN workflow' };
  }
}
