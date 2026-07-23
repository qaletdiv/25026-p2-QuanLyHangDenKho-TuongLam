'use client';

import React, { useState, useEffect, useRef } from 'react';
import { getStatuses, updateStatuses } from '@/app/actions/master-data';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { Trash2, Palette } from 'lucide-react';
import { EditLockActions } from './EditLockActions';

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

  return (
    <div className="space-y-4 bg-card p-4 sm:p-6 rounded-xl border shadow-sm">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Palette className="w-5 h-5 text-primary" />
          <h2 className="text-lg font-semibold">Booking Statuses & Badge Colors</h2>
        </div>
        <EditLockActions editing={editing} onEdit={() => setEditing(true)} onCancel={handleCancel} onAdd={addItem} onSave={handleSave} />
      </div>
      <fieldset disabled={!editing} className="m-0 p-0 min-w-0 border rounded-md overflow-hidden [&_input:disabled]:opacity-100 [&_input:disabled]:cursor-default [&_input:disabled]:border-transparent [&_input:disabled]:bg-transparent [&_input:disabled]:shadow-none">
        <Table>
          <TableHeader className="bg-muted/50">
            <TableRow>
              <TableHead className="w-1/3">Status Name</TableHead>
              <TableHead>Tailwind Classes (Badge Style)</TableHead>
              <TableHead className="w-[100px]">Preview</TableHead>
              <TableHead className="w-[50px]"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {statuses.map((s) => (
              <TableRow key={s.id}>
                <TableCell className="p-2">
                  <Input value={s.name} onChange={(e) => updateItem(s.id, 'name', e.target.value)} className="h-8 text-sm" />
                </TableCell>
                <TableCell className="p-2">
                  <Input value={s.color} onChange={(e) => updateItem(s.id, 'color', e.target.value)} className="h-8 text-sm font-mono" />
                </TableCell>
                <TableCell className="p-2">
                  <div className={`px-2 py-0.5 rounded-full text-[10px] font-bold border text-center ${s.color}`}>
                    {s.name || 'Preview'}
                  </div>
                </TableCell>
                <TableCell className="p-2">
                  <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" onClick={() => removeItem(s.id)}>
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </fieldset>
      <p className="text-[10px] text-muted-foreground italic">Note: Colors use standard Tailwind classes (e.g., bg-blue-100 text-blue-700).</p>
    </div>
  );
}
