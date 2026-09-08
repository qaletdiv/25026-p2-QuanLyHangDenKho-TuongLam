'use client';

import React, { useState, useEffect, useRef } from 'react';
import { getStatuses, updateStatuses } from '@/app/actions/master-data';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { Trash2, Palette } from 'lucide-react';
import { EditLockActions } from './EditLockActions';
import { SettingsTable, type SettingsColumn } from './SettingsTable';

export function StatusSettings() {
  const [statuses, setStatuses] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const saved = useRef<any[]>([]);

  useEffect(() => {
    getStatuses().then(data => {
      const arr = Array.isArray(data) ? data : [];
      setStatuses(arr); saved.current = arr;
      setIsLoading(false);
    });
  }, []);

  const handleSave = async () => {
    const res = await updateStatuses(statuses);
    if (res?.error) { toast.error(res.error); return; }
    saved.current = statuses; setEditing(false);
    toast.success('Statuses updated successfully.');
  };

  const handleCancel = () => { setStatuses(saved.current); setEditing(false); };

  const addItem = () => {
    const id = Math.random().toString(36).substr(2, 9);
    setStatuses([...statuses, { id, name: '', color: 'bg-gray-100 text-gray-700' }]);
  };

  const removeItem = (id: string) => {
    setStatuses(statuses.filter(i => i.id !== id));
  };

  const updateItem = (id: string, key: string, value: string) => {
    setStatuses(statuses.map(i => i.id === id ? { ...i, [key]: value } : i));
  };

  if (isLoading) return <div className="p-4 text-sm text-muted-foreground italic">Loading statuses...</div>;

  const columns: SettingsColumn<any>[] = [
    {
      key: 'name', label: 'Status Name', headClassName: 'w-1/3',
      cell: (s) => <Input value={s.name} onChange={(e) => updateItem(s.id, 'name', e.target.value)} className="h-8 text-sm" />,
    },
    {
      key: 'color', label: 'Tailwind Classes (Badge Style)',
      cell: (s) => <Input value={s.color} onChange={(e) => updateItem(s.id, 'color', e.target.value)} className="h-8 text-sm font-mono" />,
    },
    {
      key: 'preview', label: 'Preview', sortable: false, headClassName: 'w-[100px]',
      cell: (s) => (
        <div className={`px-2 py-0.5 rounded-full text-[10px] font-bold border text-center ${s.color}`}>
          {s.name || 'Preview'}
        </div>
      ),
    },
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
          <Palette className="w-5 h-5 text-primary" />
          <h2 className="text-lg font-semibold">Booking Statuses & Badge Colors</h2>
        </div>
        <EditLockActions editing={editing} onEdit={() => setEditing(true)} onCancel={handleCancel} onAdd={addItem} onSave={handleSave} />
      </div>
      <SettingsTable
        rows={statuses}
        columns={columns}
        rowKey={(s) => s.id}
        disabled={!editing}
        storageKey="settings-statuses-colorder"
        emptyText="No statuses yet — click Edit then Add."
      />
      <p className="text-[10px] text-muted-foreground italic">Note: Colors use standard Tailwind classes (e.g., bg-blue-100 text-blue-700).</p>
    </div>
  );
}
