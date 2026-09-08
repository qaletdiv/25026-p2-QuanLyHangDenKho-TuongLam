'use client';

import React, { useState, useEffect, useRef } from 'react';
import { getWarehouses, updateWarehouses } from '@/app/actions/master-data';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { Trash2, Warehouse } from 'lucide-react';
import { EditLockActions } from './EditLockActions';
import { SettingsTable, type SettingsColumn } from './SettingsTable';

export function WarehouseSettings() {
  const [warehouses, setWarehouses] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const saved = useRef<any[]>([]);

  useEffect(() => {
    getWarehouses().then(data => {
      const arr = Array.isArray(data) ? data : [];
      setWarehouses(arr); saved.current = arr;
      setIsLoading(false);
    });
  }, []);

  const handleSave = async () => {
    const res = await updateWarehouses(warehouses);
    if (res?.error) { toast.error(res.error); return; }
    saved.current = warehouses; setEditing(false);
    toast.success('Warehouses updated successfully.');
  };

  const handleCancel = () => { setWarehouses(saved.current); setEditing(false); };

  const addItem = () => {
    const id = Math.random().toString(36).substr(2, 9);
    setWarehouses([...warehouses, { id, name: '', country: '', city: '', address: '', port_of_discharge: '' }]);
  };

  const removeItem = (id: string) => {
    setWarehouses(warehouses.filter(i => i.id !== id));
  };

  const updateItem = (id: string, key: string, value: string) => {
    setWarehouses(warehouses.map(i => i.id === id ? { ...i, [key]: value } : i));
  };

  if (isLoading) return <div className="p-4 text-sm text-muted-foreground italic">Loading warehouses...</div>;

  const textCol = (key: string, label: string): SettingsColumn<any> => ({
    key, label,
    cell: (w) => <Input value={w[key] || ''} onChange={(e) => updateItem(w.id, key, e.target.value)} className="h-8 text-sm" />,
  });

  const columns: SettingsColumn<any>[] = [
    textCol('name', 'Name'),
    textCol('country', 'Country'),
    textCol('city', 'City'),
    textCol('address', 'Address'),
    textCol('port_of_discharge', 'Port of Discharge'),
    {
      key: 'actions', label: '', sortable: false, movable: false, headClassName: 'w-[50px]',
      cell: (w) => (
        <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" onClick={() => removeItem(w.id)}>
          <Trash2 className="w-4 h-4" />
        </Button>
      ),
    },
  ];

  return (
    <div className="space-y-4 bg-card p-4 sm:p-6 rounded-xl border shadow-sm">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Warehouse className="w-5 h-5 text-primary" />
          <h2 className="text-lg font-semibold">Warehouses</h2>
        </div>
        <EditLockActions editing={editing} onEdit={() => setEditing(true)} onCancel={handleCancel} onAdd={addItem} onSave={handleSave} />
      </div>
      <SettingsTable
        rows={warehouses}
        columns={columns}
        rowKey={(w) => w.id}
        disabled={!editing}
        storageKey="settings-warehouses-colorder"
        emptyText="No warehouses yet — click Edit then Add."
      />
    </div>
  );
}
