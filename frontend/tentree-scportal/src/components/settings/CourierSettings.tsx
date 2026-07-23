'use client';

import React, { useState, useEffect, useRef } from 'react';
import { getCouriers, updateCouriers } from '@/app/actions/master-data';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { Trash2, Truck } from 'lucide-react';
import { EditLockActions } from './EditLockActions';

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

  return (
    <div className="space-y-4 bg-card p-4 sm:p-6 rounded-xl border shadow-sm">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Truck className="w-5 h-5 text-primary" />
          <h2 className="text-lg font-semibold">Couriers</h2>
        </div>
        <EditLockActions editing={editing} onEdit={() => setEditing(true)} onCancel={handleCancel} onAdd={addItem} onSave={handleSave} />
      </div>
      <fieldset disabled={!editing} className="m-0 p-0 min-w-0 border rounded-md overflow-hidden [&_input:disabled]:opacity-100 [&_input:disabled]:cursor-default [&_input:disabled]:border-transparent [&_input:disabled]:bg-transparent [&_input:disabled]:shadow-none">
        <Table>
          <TableHeader className="bg-muted/50">
            <TableRow>
              <TableHead>Courier Name</TableHead>
              <TableHead className="w-[50px]"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {couriers.map((c) => (
              <TableRow key={c.id}>
                <TableCell className="p-2">
                  <Input value={c.name} onChange={(e) => updateItem(c.id, 'name', e.target.value)} className="h-8 text-sm" />
                </TableCell>
                <TableCell className="p-2">
                  <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" onClick={() => removeItem(c.id)}>
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </fieldset>
    </div>
  );
}
