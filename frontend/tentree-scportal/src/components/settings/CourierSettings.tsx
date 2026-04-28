'use client';

import React, { useState, useEffect } from 'react';
import { getCouriers, updateCouriers } from '@/app/actions/master-data';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { toast } from 'sonner';
import { Save, Trash2, Plus, Truck } from 'lucide-react';

export function CourierSettings() {
  const [couriers, setCouriers] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    getCouriers().then(data => {
      setCouriers(data || []);
      setIsLoading(false);
    });
  }, []);

  const handleSave = async () => {
    try {
      await updateCouriers(couriers);
      toast.success('Couriers updated successfully.');
    } catch (e) {
      toast.error('Failed to update couriers.');
    }
  };

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
    <div className="space-y-4 bg-card p-6 rounded-xl border shadow-sm">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Truck className="w-5 h-5 text-primary" />
          <h2 className="text-lg font-semibold">Couriers</h2>
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
      </div>
    </div>
  );
}
