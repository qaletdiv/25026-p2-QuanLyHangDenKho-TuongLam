'use client';

import React, { useState, useEffect, useRef } from 'react';
import { getIncoterms, updateIncoterms } from '@/app/actions/master-data';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { Trash2, FileText } from 'lucide-react';
import { EditLockActions } from './EditLockActions';
import { SettingsTable, type SettingsColumn } from './SettingsTable';

export function IncotermSettings() {
  const [incoterms, setIncoterms] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const saved = useRef<any[]>([]);

  useEffect(() => {
    getIncoterms().then(data => {
      const arr = Array.isArray(data) ? data : [];
      setIncoterms(arr); saved.current = arr;
      setIsLoading(false);
    });
  }, []);

  const handleSave = async () => {
    const res = await updateIncoterms(incoterms);
    if (res?.error) { toast.error(res.error); return; }
    saved.current = incoterms; setEditing(false);
    toast.success('Incoterms updated successfully.');
  };

  const handleCancel = () => { setIncoterms(saved.current); setEditing(false); };

  const addItem = () => {
    const id = Math.random().toString(36).substr(2, 9);
    setIncoterms([...incoterms, { id, name: '' }]);
  };

  const removeItem = (id: string) => {
    setIncoterms(incoterms.filter(i => i.id !== id));
  };

  const updateItem = (id: string, key: string, value: string) => {
    setIncoterms(incoterms.map(i => i.id === id ? { ...i, [key]: value } : i));
  };

  if (isLoading) return <div className="p-4 text-sm text-muted-foreground italic">Loading incoterms...</div>;

  const columns: SettingsColumn<any>[] = [
    {
      key: 'name', label: 'Incoterm Code',
      cell: (i) => <Input value={i.name} onChange={(e) => updateItem(i.id, 'name', e.target.value)} className="h-8 text-sm" />,
    },
    {
      key: 'actions', label: '', sortable: false, movable: false, headClassName: 'w-[50px]',
      cell: (i) => (
        <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" onClick={() => removeItem(i.id)}>
          <Trash2 className="w-4 h-4" />
        </Button>
      ),
    },
  ];

  return (
    <div className="space-y-4 bg-card p-4 sm:p-6 rounded-xl border shadow-sm">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <FileText className="w-5 h-5 text-primary" />
          <h2 className="text-lg font-semibold">Incoterms</h2>
        </div>
        <EditLockActions editing={editing} onEdit={() => setEditing(true)} onCancel={handleCancel} onAdd={addItem} onSave={handleSave} />
      </div>
      <SettingsTable
        rows={incoterms}
        columns={columns}
        rowKey={(i) => i.id}
        disabled={!editing}
        storageKey="settings-incoterms-colorder"
        emptyText="No incoterms yet — click Edit then Add."
      />
    </div>
  );
}
