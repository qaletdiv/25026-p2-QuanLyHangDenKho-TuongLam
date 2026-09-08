'use client';

import React, { useState, useEffect, useRef } from 'react';
import { getCouriers, updateCouriers } from '@/app/actions/master-data';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { Trash2, Truck } from 'lucide-react';
import { EditLockActions } from './EditLockActions';
import { SettingsTable, type SettingsColumn } from './SettingsTable';

export function CourierSettings() {
  const [couriers, setCouriers] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const saved = useRef<any[]>([]);

  useEffect(() => {
    getCouriers().then(data => {
      const arr = Array.isArray(data) ? data : [];
      setCouriers(arr); saved.current = arr;
      setIsLoading(false);
    });
  }, []);

  const handleSave = async () => {
    const res = await updateCouriers(couriers);
    if (res?.error) { toast.error(res.error); return; }
    saved.current = couriers; setEditing(false);
    toast.success('Couriers updated successfully.');
  };

  const handleCancel = () => { setCouriers(saved.current); setEditing(false); };

  const addItem = () => {
    const id = Math.random().toString(36).substr(2, 9);
    setCouriers([...couriers, { id, name: '' }]);
  };

  const removeItem = (id: string) => {
    setCouriers(couriers.filter(i => i.id !== id));
  };

  const updateItem = (id: string, key: string, value: string) => {
    setCouriers(couriers.map(i => i.id === id ? { ...i, [key]: value } : i));
  };

  if (isLoading) return <div className="p-4 text-sm text-muted-foreground italic">Loading couriers...</div>;

  const columns: SettingsColumn<any>[] = [
    {
      key: 'name', label: 'Courier Name',
      cell: (c) => <Input value={c.name} onChange={(e) => updateItem(c.id, 'name', e.target.value)} className="h-8 text-sm" />,
    },
    {
      key: 'actions', label: '', sortable: false, movable: false, headClassName: 'w-[50px]',
      cell: (c) => (
        <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" onClick={() => removeItem(c.id)}>
          <Trash2 className="w-4 h-4" />
        </Button>
      ),
    },
  ];

  return (
    <div className="space-y-4 bg-card p-4 sm:p-6 rounded-xl border shadow-sm">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Truck className="w-5 h-5 text-primary" />
          <h2 className="text-lg font-semibold">Couriers</h2>
        </div>
        <EditLockActions editing={editing} onEdit={() => setEditing(true)} onCancel={handleCancel} onAdd={addItem} onSave={handleSave} />
      </div>
      <SettingsTable
        rows={couriers}
        columns={columns}
        rowKey={(c) => c.id}
        disabled={!editing}
        storageKey="settings-couriers-colorder"
        emptyText="No couriers yet — click Edit then Add."
      />
    </div>
  );
}
