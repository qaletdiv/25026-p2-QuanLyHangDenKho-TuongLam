'use client';

import React, { useEffect, useRef, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { toast } from 'sonner';
import { Percent } from 'lucide-react';
import { EditLockActions } from './EditLockActions';
import { getLandedCostRates, updateLandedCostRates } from '@/modules/landed-costs/actions';
import type { LandedCostRate } from '@/modules/landed-costs/types';

const MODULE_LABEL: Record<string, string> = { sms: 'SMS (courier)', mainline: 'Mainline (freight)' };

export function LandedCostSettings() {
  const [rates, setRates] = useState<LandedCostRate[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const saved = useRef<LandedCostRate[]>([]);

  useEffect(() => {
    getLandedCostRates().then((data) => {
      const arr = Array.isArray(data) ? data : [];
      setRates(arr); saved.current = arr; setLoading(false);
    });
  }, []);

  const update = (id: string, key: 'freight_pct' | 'duty_pct', value: string) =>
    setRates((rs) => rs.map((r) => (r.id === id ? { ...r, [key]: value === '' ? 0 : Number(value) } : r)));

  const handleSave = async () => {
    const res = await updateLandedCostRates(rates);
    if (res?.error) { toast.error(res.error); return; }
    saved.current = rates; setEditing(false);
    toast.success('Landed cost rates updated. New estimates use these immediately; already-posted amounts are unchanged.');
  };
  const handleCancel = () => { setRates(saved.current); setEditing(false); };

  if (loading) return <div className="p-4 text-sm text-muted-foreground italic">Loading rates…</div>;

  return (
    <div className="space-y-4 bg-card p-4 sm:p-6 rounded-xl border shadow-sm">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Percent className="w-5 h-5 text-primary" />
          <h2 className="text-lg font-semibold">Landed Cost Rates</h2>
        </div>
        <EditLockActions editing={editing} onEdit={() => setEditing(true)} onCancel={handleCancel} onSave={handleSave} />
      </div>
      <p className="text-sm text-muted-foreground">
        Freight and duty are estimated as a percentage of each shipment's commercial-invoice value.
        Editing a rate changes only future estimates — already-posted landed costs keep the rate they were posted with.
      </p>

      <fieldset disabled={!editing} className="m-0 p-0 min-w-0 border rounded-md overflow-hidden [&_input:disabled]:opacity-100 [&_input:disabled]:cursor-default [&_input:disabled]:border-transparent [&_input:disabled]:bg-transparent [&_input:disabled]:shadow-none">
        <Table>
          <TableHeader className="bg-muted/50">
            <TableRow>
              <TableHead>Module</TableHead>
              <TableHead className="w-40">Freight %</TableHead>
              <TableHead className="w-40">Duty %</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rates.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="font-medium">{MODULE_LABEL[r.module] ?? r.module}</TableCell>
                <TableCell className="p-2">
                  <Input type="number" min={0} step="0.1" value={r.freight_pct}
                    onChange={(e) => update(r.id, 'freight_pct', e.target.value)} className="h-8 text-sm" />
                </TableCell>
                <TableCell className="p-2">
                  <Input type="number" min={0} step="0.1" value={r.duty_pct}
                    onChange={(e) => update(r.id, 'duty_pct', e.target.value)} className="h-8 text-sm" />
                </TableCell>
              </TableRow>
            ))}
            {rates.length === 0 && (
              <TableRow><TableCell colSpan={3} className="text-center text-sm text-muted-foreground py-6">No rates configured.</TableCell></TableRow>
            )}
          </TableBody>
        </Table>
      </fieldset>
    </div>
  );
}
