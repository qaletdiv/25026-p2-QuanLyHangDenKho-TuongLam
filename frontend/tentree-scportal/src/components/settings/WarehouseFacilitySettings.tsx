'use client';

// Destinations = `warehouse_facilities`, the physical places cargo is shipped to
// (NRI US, NRI CA, …) — the CONSIGNEE, which the PO names via facility_id. These
// fields are what the Commercial Invoice and Packing List print as the consignee
// block and port of discharge, in both modules; the legacy Warehouses table below
// is NOT read by either generator, which is why those cells came out blank on
// every downloaded document even though the addresses had been entered there.
// The Notify Party is NOT here — it is always tentree, so it is one row of its own
// (NotifyPartySettings) rather than the same value copied onto five destinations.
//
// EDIT ONLY, no Add/Delete: a destination is a foreign-key target for POs,
// shipments and SMS consignments, and rows are created by the PO ingestion. The
// backend refuses an id set that differs from what it holds, so the missing Add
// button here matches the server rule rather than merely hiding it.

import React, { useState, useEffect, useRef } from 'react';
import { getWarehouseFacilities, updateWarehouseFacilities } from '@/app/actions/master-data';
import { Input } from '@/components/ui/input';
import { toast } from 'sonner';
import { Building2 } from 'lucide-react';
import { EditLockActions } from './EditLockActions';
import { SettingsTable, type SettingsColumn } from './SettingsTable';
import { AddressInput } from './AddressInput';

export function WarehouseFacilitySettings() {
  const [facilities, setFacilities] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const saved = useRef<any[]>([]);

  useEffect(() => {
    getWarehouseFacilities().then(data => {
      const arr = Array.isArray(data) ? data : [];
      setFacilities(arr); saved.current = arr;
      setIsLoading(false);
    });
  }, []);

  const handleSave = async () => {
    const res = await updateWarehouseFacilities(facilities);
    if (res?.error) { toast.error(res.error); return; }
    saved.current = facilities; setEditing(false);
    toast.success('Destinations updated. Re-upload shipping data to regenerate documents with the new details.');
  };

  const handleCancel = () => { setFacilities(saved.current); setEditing(false); };

  const updateItem = (id: string, key: string, value: string) => {
    setFacilities(facilities.map(f => f.id === id ? { ...f, [key]: value } : f));
  };

  if (isLoading) return <div className="p-4 text-sm text-muted-foreground italic">Loading destinations...</div>;

  const textCol = (key: string, label: string): SettingsColumn<any> => ({
    key, label,
    cell: (f) => <Input value={f[key] || ''} onChange={(e) => updateItem(f.id, key, e.target.value)} className="h-8 text-sm" />,
  });

  const columns: SettingsColumn<any>[] = [
    textCol('name', 'Consignee Name'),
    textCol('country', 'Country'),
    textCol('city', 'City'),
    // Multi-line: this block carries the street address, a contact, a phone, an
    // email, the carrier-appointment address and the EIN. See AddressInput.
    {
      key: 'address', label: 'Consignee Address', sortable: false,
      cell: (f) => <AddressInput value={f.address} onChange={(v) => updateItem(f.id, 'address', v)}
        placeholder={'9988 Redwood Avenue LH Building\nFontana, California 92335, United States\nContact: …'} />,
    },
    textCol('port_of_discharge', 'Port of Discharge'),
  ];

  return (
    <div className="space-y-4 bg-card p-4 sm:p-6 rounded-xl border shadow-sm">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Building2 className="w-5 h-5 text-primary" />
          <div>
            <h2 className="text-lg font-semibold">Destinations</h2>
            <p className="text-sm text-muted-foreground">
              Printed on the Commercial Invoice and Packing List. Destinations are created by the PO
              import — these details are editable, the list itself is not.
            </p>
          </div>
        </div>
        <EditLockActions editing={editing} onEdit={() => setEditing(true)} onCancel={handleCancel} onSave={handleSave} />
      </div>
      <SettingsTable
        rows={facilities}
        columns={columns}
        rowKey={(f) => f.id}
        disabled={!editing}
        storageKey="settings-facilities-colorder"
        emptyText="No destinations — they appear once POs are imported."
      />
    </div>
  );
}
