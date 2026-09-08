'use client';

import React, { useEffect, useRef, useState } from 'react';
import { Input } from '@/components/ui/input';
import { toast } from 'sonner';
import { Percent } from 'lucide-react';
import { EditLockActions } from './EditLockActions';
import { SettingsTable, type SettingsColumn } from './SettingsTable';
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

  const pctCol = (key: 'freight_pct' | 'duty_pct', label: string): SettingsColumn<LandedCostRate> => ({
    key, label, headClassName: 'w-40',
    accessor: (r) => r[key],
    cell: (r) => (
      <Input type="number" min={0} step="0.1" value={r[key]}
        onChange={(e) => update(r.id, key, e.target.value)} className="h-8 text-sm" />
    ),
  });

  const columns: SettingsColumn<LandedCostRate>[] = [
    {
      key: 'module', label: 'Module', cellClassName: 'font-medium',
      accessor: (r) => MODULE_LABEL[r.module] ?? r.module,
      cell: (r) => MODULE_LABEL[r.module] ?? r.module,
    },
    pctCol('freight_pct', 'Freight %'),
    pctCol('duty_pct', 'Duty %'),
  ];

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
        Freight and duty are estimated as a percentage of each shipment&apos;s commercial-invoice value.
        Editing a rate changes only future estimates — already-posted landed costs keep the rate they were posted with.
      </p>
      {/* When each rate actually applies. The two modules decide it differently and
          deliberately stay separate; saying so here stops the rates reading as if
          they applied to every shipment. */}
      <p className="text-sm text-muted-foreground">
        A rate is used only when there is no traceable invoice to post instead.
        <br />
        <span className="text-foreground">Mainline</span> — used when the shipment&apos;s carrier does not invoice freight &amp; duty
        separately (FedEx / DHL). A freight-forwarder shipment posts the actual amounts entered on the shipment.
        <br />
        <span className="text-foreground">SMS</span> — used for a vendor-entered courier consignment. A booked consignment posts
        the actuals off the broker bill.
      </p>

      <SettingsTable
        rows={rates}
        columns={columns}
        rowKey={(r) => r.id}
        disabled={!editing}
        storageKey="settings-landed-cost-rates-colorder"
        emptyText="No rates configured."
      />
    </div>
  );
}
