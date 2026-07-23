'use client';

import React, { useState, useEffect, useRef } from 'react';
import { getProductionSchedules, updateProductionSchedules, createSeason } from '@/app/actions/master-data';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { toast } from 'sonner';
import { CalendarClock, Plus } from 'lucide-react';
import { EditLockActions } from './EditLockActions';

type ScheduleRow = { season_id: string; season: string; ontime_by: string | null; atrisk_by: string | null };

// Per-season delivery KPI gates. E-DEL ≤ On Time cutoff → On Time; ≤ At Risk
// cutoff → At Risk; later → Late. Seasons appear automatically as PO/WIP syncs
// create them — the team fills in the two dates each season.
export function ProductionScheduleSettings() {
  const [rows, setRows] = useState<ScheduleRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [newCode, setNewCode] = useState('');
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(false);
  const saved = useRef<ScheduleRow[]>([]);   // last-saved snapshot for Cancel

  const load = () => getProductionSchedules().then((data: any) => {
    const arr = Array.isArray(data) ? data : [];
    setRows(arr); saved.current = arr;
    setIsLoading(false);
  });
  useEffect(() => { load(); }, []);

  const setField = (season_id: string, key: 'ontime_by' | 'atrisk_by', value: string) =>
    setRows(rows.map((r) => (r.season_id === season_id ? { ...r, [key]: value || null } : r)));

  // Pre-load next season before its POs exist. The row is created in the SEASONS
  // table (3NF — the schedule stays keyed on season_id); later WIP/NetSuite syncs
  // match it by code instead of creating a duplicate.
  const addSeason = async () => {
    const code = newCode.trim();
    if (!code) { toast.error('Enter a season code, e.g. SS27'); return; }
    setAdding(true);
    const res = await createSeason(code);
    setAdding(false);
    if (res?.error) { toast.error(res.error); return; }
    toast.success(`Season ${code.toUpperCase()} added — set its cutoffs and Save.`);
    setNewCode('');
    load();
  };

  const handleSave = async () => {
    const bad = rows.find((r) => r.ontime_by && r.atrisk_by && r.atrisk_by < r.ontime_by);
    if (bad) { toast.error(`${bad.season}: At Risk cutoff cannot be before On Time cutoff`); return; }
    const res = await updateProductionSchedules(rows.map(({ season_id, ontime_by, atrisk_by }) => ({ season_id, ontime_by, atrisk_by })));
    if (res?.error) { toast.error(res.error); return; }
    saved.current = rows; setEditing(false);
    toast.success('Production schedule updated — the season KPI report now grades against it.');
  };

  const handleCancel = () => { setRows(saved.current); setEditing(false); };

  if (isLoading) return <div className="p-4 text-sm text-muted-foreground italic">Loading production schedules...</div>;

  return (
    <div className="space-y-4 bg-card p-4 sm:p-6 rounded-xl border shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <CalendarClock className="w-5 h-5 text-primary" />
          <h2 className="text-lg font-semibold">Production Schedule</h2>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {editing && (
            <>
              <Input
                value={newCode}
                onChange={(e) => setNewCode(e.target.value.toUpperCase())}
                onKeyDown={(e) => { if (e.key === 'Enter') addSeason(); }}
                placeholder="New season, e.g. SS27"
                className="h-8 w-full sm:w-44 text-sm"
              />
              <Button size="sm" variant="outline" disabled={adding} onClick={addSeason}>
                <Plus className="w-4 h-4 mr-1" /> {adding ? 'Adding…' : 'Add Season'}
              </Button>
            </>
          )}
          <EditLockActions editing={editing} onEdit={() => setEditing(true)} onCancel={handleCancel} onSave={handleSave} />
        </div>
      </div>
      <p className="text-sm text-muted-foreground">
        The delivery KPI gates per season: E-DEL on or before the <span className="font-medium text-green-600">On Time</span> cutoff
        grades On Time; on or before the <span className="font-medium text-amber-600">At Risk</span> cutoff grades At Risk; anything
        later is <span className="font-medium text-red-600">Late</span>. Use <span className="font-medium">Add Season</span> to record next
        season&apos;s schedule before its POs arrive — seasons from PO/WIP syncs also appear here automatically.
      </p>
      <fieldset disabled={!editing} className="m-0 p-0 min-w-0 border rounded-md overflow-hidden [&_input:disabled]:opacity-100 [&_input:disabled]:cursor-default [&_input:disabled]:border-transparent [&_input:disabled]:bg-transparent [&_input:disabled]:shadow-none">
        <Table>
          <TableHeader className="bg-muted/50">
            <TableRow>
              <TableHead>Season</TableHead>
              <TableHead>On Time — deliver by</TableHead>
              <TableHead>At Risk — deliver by</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 && (
              <TableRow><TableCell colSpan={3} className="text-center text-muted-foreground py-6">No seasons yet — sync POs first</TableCell></TableRow>
            )}
            {rows.map((r) => (
              <TableRow key={r.season_id}>
                <TableCell className="p-2 font-medium">{r.season}</TableCell>
                <TableCell className="p-2">
                  <Input type="date" value={r.ontime_by ?? ''} onChange={(e) => setField(r.season_id, 'ontime_by', e.target.value)} className="h-8 text-sm w-44" />
                </TableCell>
                <TableCell className="p-2">
                  <Input type="date" value={r.atrisk_by ?? ''} onChange={(e) => setField(r.season_id, 'atrisk_by', e.target.value)} className="h-8 text-sm w-44" />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </fieldset>
    </div>
  );
}
