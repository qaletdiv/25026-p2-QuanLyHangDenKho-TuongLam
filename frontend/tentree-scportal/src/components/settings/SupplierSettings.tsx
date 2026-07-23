'use client';

import React, { useState, useEffect, useRef } from 'react';
import { getSuppliers, updateSuppliers } from '@/app/actions/master-data';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { Trash2, Users } from 'lucide-react';
import { EditLockActions } from './EditLockActions';

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

  return (
    <div className="space-y-4 bg-card p-4 sm:p-6 rounded-xl border shadow-sm">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Users className="w-5 h-5 text-primary" />
          <h2 className="text-lg font-semibold">Suppliers</h2>
        </div>
        <EditLockActions editing={editing} onEdit={() => setEditing(true)} onCancel={handleCancel} onAdd={addItem} onSave={handleSave} />
      </div>
      <fieldset disabled={!editing} className="m-0 p-0 min-w-0 border rounded-md overflow-hidden [&_input:disabled]:opacity-100 [&_input:disabled]:cursor-default [&_input:disabled]:border-transparent [&_input:disabled]:bg-transparent [&_input:disabled]:shadow-none">
        <Table>
          <TableHeader className="bg-muted/50">
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Country</TableHead>
              <TableHead>Address</TableHead>
              <TableHead>Port of Loading</TableHead>
              <TableHead className="w-[50px]"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {suppliers.map((s) => (
              <TableRow key={s.id}>
                <TableCell className="p-2">
                  <Input value={s.name} onChange={(e) => updateItem(s.id, 'name', e.target.value)} className="h-8 text-sm" />
                </TableCell>
                <TableCell className="p-2">
                  <Input value={s.country} onChange={(e) => updateItem(s.id, 'country', e.target.value)} className="h-8 text-sm" />
                </TableCell>
                <TableCell className="p-2">
                  <Input value={s.address || ''} onChange={(e) => updateItem(s.id, 'address', e.target.value)} className="h-8 text-sm" />
                </TableCell>
                <TableCell className="p-2">
                  <Input value={s.port_of_loading || ''} onChange={(e) => updateItem(s.id, 'port_of_loading', e.target.value)} className="h-8 text-sm" />
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
    </div>
  );
}
