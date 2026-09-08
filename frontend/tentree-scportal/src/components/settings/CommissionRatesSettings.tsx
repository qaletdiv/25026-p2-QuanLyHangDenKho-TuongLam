'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select';
import { toast } from 'sonner';
import { Percent, Plus, X } from 'lucide-react';
import { EditLockActions } from './EditLockActions';
import { SettingsTable, type SettingsColumn } from './SettingsTable';
import { getSuppliers } from '@/app/actions/master-data';
import { getCommissionRates, updateCommissionRates } from '@/modules/landed-costs/actions';
import type { LandedCostCommission } from '@/modules/landed-costs/types';

type Supplier = { id: string; name: string };

const MODULE_LABEL: Record<'sms' | 'mainline', string> = { sms: 'SMS (courier)', mainline: 'Mainline (freight)' };

// One module's per-supplier commission editor. SMS and mainline each get their
// OWN instance → OWN endpoint/table; the two are fully independent (no sharing).
function CommissionModuleEditor({ module, suppliers }: { module: 'sms' | 'mainline'; suppliers: Supplier[] }) {
  const [rows, setRows] = useState<LandedCostCommission[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [addSupplier, setAddSupplier] = useState('');
  const saved = useRef<LandedCostCommission[]>([]);

  useEffect(() => {
    getCommissionRates(module).then((data) => {
      const arr = Array.isArray(data) ? data : [];
      setRows(arr); saved.current = arr; setLoading(false);
    });
  }, [module]);

  const supName = useMemo(() => new Map(suppliers.map((s) => [String(s.id), s.name])), [suppliers]);
  // suppliers not already in the table (candidates for the Add dropdown)
  const available = useMemo(
    () => suppliers.filter((s) => !rows.some((r) => String(r.supplier_id) === String(s.id))),
    [suppliers, rows],
  );

  const updatePct = (id: string, value: string) =>
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, commission_pct: value === '' ? 0 : Number(value) } : r)));
  const removeRow = (id: string) => setRows((rs) => rs.filter((r) => r.id !== id));
  const addRow = () => {
    if (!addSupplier) return;
    setRows((rs) => [...rs, { id: `lcc_${module}_${addSupplier}`, supplier_id: addSupplier, commission_pct: 0 }]);
    setAddSupplier('');
  };

  const handleSave = async () => {
    const res = await updateCommissionRates(module, rows);
    if (res?.error) { toast.error(res.error); return; }
    saved.current = rows; setEditing(false);
    toast.success(`${MODULE_LABEL[module]} commission rates updated.`);
  };
  const handleCancel = () => { setRows(saved.current); setAddSupplier(''); setEditing(false); };

  if (loading) return <div className="p-4 text-sm text-muted-foreground italic">Loading {MODULE_LABEL[module]} commissions…</div>;

  const supLabel = (r: LandedCostCommission) => supName.get(String(r.supplier_id)) ?? `Supplier ${r.supplier_id}`;

  const columns: SettingsColumn<LandedCostCommission>[] = [
    { key: 'supplier', label: 'Supplier', cellClassName: 'font-medium', accessor: supLabel, cell: supLabel },
    {
      key: 'commission_pct', label: 'Commission %', headClassName: 'w-40',
      accessor: (r) => r.commission_pct,
      cell: (r) => (
        <Input type="number" min={0} step="0.1" value={r.commission_pct}
          onChange={(e) => updatePct(r.id, e.target.value)} className="h-8 text-sm" />
      ),
    },
    ...(editing ? [{
      key: 'actions', label: '', sortable: false, movable: false, headClassName: 'w-12', cellClassName: 'text-right',
      cell: (r: LandedCostCommission) => (
        <Button size="sm" variant="ghost" className="h-7 w-7 p-0" title="Remove" onClick={() => removeRow(r.id)}><X className="h-4 w-4" /></Button>
      ),
    } as SettingsColumn<LandedCostCommission>] : []),
  ];

  // trailing "add a supplier" row — rendered in whatever order the columns sit in
  const footerCells = editing ? {
    supplier: (
      <Select value={addSupplier} onValueChange={(v) => setAddSupplier(v ?? '')}>
        <SelectTrigger className="h-8 text-sm">{addSupplier ? (supName.get(addSupplier) ?? addSupplier) : 'Add supplier…'}</SelectTrigger>
        <SelectContent>
          {available.length === 0
            ? <SelectItem value="__none" disabled>All suppliers added</SelectItem>
            : available.map((s) => <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>)}
        </SelectContent>
      </Select>
    ),
    commission_pct: <span className="text-muted-foreground text-xs">defaults to 0%</span>,
    actions: (
      <Button size="sm" variant="outline" className="h-7" disabled={!addSupplier} onClick={addRow}><Plus className="h-3.5 w-3.5 mr-1" />Add</Button>
    ),
  } : undefined;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-muted-foreground">{MODULE_LABEL[module]}</h3>
        <EditLockActions editing={editing} onEdit={() => setEditing(true)} onCancel={handleCancel} onSave={handleSave} />
      </div>
      <SettingsTable
        rows={rows}
        columns={columns}
        rowKey={(r) => r.id}
        disabled={!editing}
        storageKey={`settings-commission-${module}-colorder`}
        emptyText="No commission rates — every supplier defaults to 0%."
        footerCells={footerCells}
      />
    </div>
  );
}

export function CommissionRatesSettings() {
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);

  useEffect(() => {
    getSuppliers().then((data) => setSuppliers(Array.isArray(data) ? data : []));
  }, []);

  return (
    <div className="space-y-6 bg-card p-4 sm:p-6 rounded-xl border shadow-sm">
      <div className="flex items-center gap-2">
        <Percent className="w-5 h-5 text-primary" />
        <h2 className="text-lg font-semibold">Commission Rates</h2>
      </div>
      <p className="text-sm text-muted-foreground">
        Commission is a percentage of each PO's commercial-invoice value, applied only to the listed suppliers
        (e.g. Pratibha 1.5%). It is pushed to NetSuite as a separate landed-cost category. SMS and mainline are
        configured independently.
      </p>
      <CommissionModuleEditor module="sms" suppliers={suppliers} />
      <CommissionModuleEditor module="mainline" suppliers={suppliers} />
    </div>
  );
}
