'use client';

import React, { useState, useEffect, useRef } from 'react';
import { getModes, updateModes } from '@/app/actions/master-data';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { Trash2, Ship } from 'lucide-react';
import { EditLockActions } from './EditLockActions';
import { SettingsTable, type SettingsColumn } from './SettingsTable';

export function ModeSettings() {
  const [modes, setModes] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const saved = useRef<any[]>([]);

  useEffect(() => {
    getModes().then(data => {
      const arr = Array.isArray(data) ? data : [];
      setModes(arr); saved.current = arr;
      setIsLoading(false);
    });
  }, []);

  const handleSave = async () => {
    const res = await updateModes(modes);
    if (res?.error) { toast.error(res.error); return; }
    saved.current = modes; setEditing(false);
    toast.success('Transport modes updated successfully.');
  };

  const handleCancel = () => { setModes(saved.current); setEditing(false); };

  const addItem = () => {
    const id = Math.random().toString(36).substr(2, 9);
    setModes([...modes, { id, name: '' }]);
  };

  const removeItem = (id: string) => {
    setModes(modes.filter(i => i.id !== id));
  };

  const updateItem = (id: string, key: string, value: string) => {
    setModes(modes.map(i => i.id === id ? { ...i, [key]: value } : i));
  };

  if (isLoading) return <div className="p-4 text-sm text-muted-foreground italic">Loading transport modes...</div>;

  const columns: SettingsColumn<any>[] = [
    {
      key: 'name', label: 'Name',
      cell: (m) => <Input value={m.name} onChange={(e) => updateItem(m.id, 'name', e.target.value)} className="h-8 text-sm" />,
    },
    {
      key: 'actions', label: '', sortable: false, movable: false, headClassName: 'w-[50px]',
      cell: (m) => (
        <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" onClick={() => removeItem(m.id)}>
          <Trash2 className="w-4 h-4" />
        </Button>
      ),
    },
  ];

  return (
    <div className="space-y-4 bg-card p-4 sm:p-6 rounded-xl border shadow-sm">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Ship className="w-5 h-5 text-primary" />
          <h2 className="text-lg font-semibold">Transport Modes</h2>
        </div>
        <EditLockActions editing={editing} onEdit={() => setEditing(true)} onCancel={handleCancel} onAdd={addItem} onSave={handleSave} />
      </div>
      <SettingsTable
        rows={modes}
        columns={columns}
        rowKey={(m) => m.id}
        disabled={!editing}
        storageKey="settings-modes-colorder"
        emptyText="No transport modes yet — click Edit then Add."
      />
    </div>
  );
}
