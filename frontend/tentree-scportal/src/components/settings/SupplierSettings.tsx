'use client';

import React, { useState, useEffect } from 'react';
import { getSuppliers, updateSuppliers } from '@/app/actions/master-data';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { toast } from 'sonner';
import { Save, Trash2, Plus, Users } from 'lucide-react';

export function SupplierSettings() {
  const [suppliers, setSuppliers] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    getSuppliers().then(data => {
      setSuppliers(Array.isArray(data) ? data : []);
      setIsLoading(false);
    });
  }, []);

  const handleSave = async () => {
    try {
      await updateSuppliers(suppliers);
      toast.success('Suppliers updated successfully.');
    } catch (e) {
      toast.error('Failed to update suppliers.');
    }
  };

  const addItem = () => {
    const id = Math.random().toString(36).substr(2, 9);
    setSuppliers([...suppliers, { id, name: '', country: '' }]);
  };

  const removeItem = (id: string) => {
    setSuppliers(suppliers.filter(i => i.id !== id));
  };

  const updateItem = (id: string, key: string, value: string) => {
    setSuppliers(suppliers.map(i => i.id === id ? { ...i, [key]: value } : i));
  };

  if (isLoading) return <div className="p-4 text-sm text-muted-foreground italic">Loading suppliers...</div>;

  return (
    <div className="space-y-4 bg-card p-6 rounded-xl border shadow-sm">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Users className="w-5 h-5 text-primary" />
          <h2 className="text-lg font-semibold">Suppliers</h2>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={addItem}>
            <Plus className="w-4 h-4 mr-1" /> Add
          </Button>
          <Button size="sm" onClick={handleSave}>
            <Save className="w-4 h-4 mr-1" /> Save
          </Button>
        </div>
      </div>
      <div className="border rounded-md overflow-hidden">
        <Table>
          <TableHeader className="bg-muted/50">
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Country</TableHead>
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
                  <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" onClick={() => removeItem(s.id)}>
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
