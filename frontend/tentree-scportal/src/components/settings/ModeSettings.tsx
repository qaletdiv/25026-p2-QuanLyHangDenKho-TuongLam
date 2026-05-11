'use client';

import React, { useState, useEffect } from 'react';
import { getModes, updateModes } from '@/app/actions/master-data';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { toast } from 'sonner';
import { Save, Trash2, Plus, Ship } from 'lucide-react';

export function ModeSettings() {
  const [modes, setModes] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    getModes().then(data => {
      setModes(Array.isArray(data) ? data : []);
      setIsLoading(false);
    });
  }, []);

  const handleSave = async () => {
    try {
      await updateModes(modes);
      toast.success('Transport modes updated successfully.');
    } catch (e) {
      toast.error('Failed to update transport modes.');
    }
  };

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

  return (
    <div className="space-y-4 bg-card p-6 rounded-xl border shadow-sm">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Ship className="w-5 h-5 text-primary" />
          <h2 className="text-lg font-semibold">Transport Modes</h2>
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
              <TableHead className="w-[50px]"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {modes.map((m) => (
              <TableRow key={m.id}>
                <TableCell className="p-2">
                  <Input value={m.name} onChange={(e) => updateItem(m.id, 'name', e.target.value)} className="h-8 text-sm" />
                </TableCell>
                <TableCell className="p-2">
                  <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" onClick={() => removeItem(m.id)}>
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
