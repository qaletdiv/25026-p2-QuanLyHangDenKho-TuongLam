'use client';

import React, { useState, useEffect, useRef } from 'react';
import { getSuppliers, updateSuppliers } from '@/app/actions/master-data';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { Trash2, Users } from 'lucide-react';
import { EditLockActions } from './EditLockActions';
import { SettingsTable, type SettingsColumn } from './SettingsTable';

export function SupplierSettings() {
  const [suppliers, setSuppliers] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const saved = useRef<any[]>([]);   // last-saved snapshot for Cancel

  useEffect(() => {
    getSuppliers().then(data => {
      const arr = Array.isArray(data) ? data : [];
      setSuppliers(arr); saved.current = arr;
      setIsLoading(false);
    });
  }, []);

  const handleSave = async () => {
    const res = await updateSuppliers(suppliers);
    if (res?.error) { toast.error(res.error); return; }
    saved.current = suppliers; setEditing(false);
    toast.success('Suppliers updated successfully.');
  };

  const handleCancel = () => { setSuppliers(saved.current); setEditing(false); };

  const addItem = () => {
    const id = Math.random().toString(36).substr(2, 9);
    setSuppliers([...suppliers, { id, name: '', country: '', address: '', port_of_loading: '' }]);
  };

  const removeItem = (id: string) => {
    setSuppliers(suppliers.filter(i => i.id !== id));
  };

  const updateItem = (id: string, key: string, value: string) => {
    setSuppliers(suppliers.map(i => i.id === id ? { ...i, [key]: value } : i));
  };

  if (isLoading) return <div className="p-4 text-sm text-muted-foreground italic">Loading suppliers...</div>;

  const textCol = (key: string, label: string): SettingsColumn<any> => ({
    key, label,
    cell: (s) => <Input value={s[key] || ''} onChange={(e) => updateItem(s.id, key, e.target.value)} className="h-8 text-sm" />,
  });

  const columns: SettingsColumn<any>[] = [
    textCol('name', 'Name'),
    textCol('country', 'Country'),
    textCol('address', 'Address'),
    textCol('port_of_loading', 'Port of Loading'),
    {
      key: 'actions', label: '', sortable: false, movable: false, headClassName: 'w-[50px]',
      cell: (s) => (
        <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" onClick={() => removeItem(s.id)}>
          <Trash2 className="w-4 h-4" />
        </Button>
      ),
    },
  ];

  return (
    <div className="space-y-4 bg-card p-4 sm:p-6 rounded-xl border shadow-sm">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Users className="w-5 h-5 text-primary" />
          <h2 className="text-lg font-semibold">Suppliers</h2>
        </div>
        <EditLockActions editing={editing} onEdit={() => setEditing(true)} onCancel={handleCancel} onAdd={addItem} onSave={handleSave} />
      </div>
      <SettingsTable
        rows={suppliers}
        columns={columns}
        rowKey={(s) => s.id}
        disabled={!editing}
        storageKey="settings-suppliers-colorder"
        emptyText="No suppliers yet — click Edit then Add."
      />
    </div>
  );
}
