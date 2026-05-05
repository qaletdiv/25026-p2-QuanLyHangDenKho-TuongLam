'use client';

import React, { useState, useEffect, useRef } from 'react';
import { getPurchaseOrders, createPurchaseOrder, updatePurchaseOrder, deletePurchaseOrder, bulkCreatePurchaseOrders, duplicatePurchaseOrder } from '@/app/actions/purchase-orders';
import { useSession } from '@/components/providers/SessionProvider';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Search, Plus, Upload, Download, Trash2, Edit3, X, Settings2, Check } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import PoDetailDrawer from '@/components/purchase-orders/PoDetailDrawer';
import { toast } from 'sonner';
import { format, parse } from 'date-fns';
import { getSuppliers, getCouriers, getIncoterms, getStatuses } from '@/app/actions/master-data';
import { cn } from '@/lib/utils';

const EMPTY_PO = {
  season: '', trn_number: '', po_number: '', supplier: '',
  mode: '', expected_qty: '', receiving_warehouse: '', etd: '',
  type: 'mainline', incoterm: 'FOB',
};

const ALL_COLUMNS = [
  { id: 'season', label: 'Season' },
  { id: 'trn_number', label: 'TRN No.' },
  { id: 'type', label: 'Type' },
  { id: 'po_number', label: 'PO#' },
  { id: 'supplier', label: 'Supplier' },
  { id: 'mode', label: 'Mode' },
  { id: 'incoterm', label: 'Incoterm' },
  { id: 'expected_qty', label: 'Exp. Qty' },
  { id: 'received_qty', label: 'Rcv. Qty' },
  { id: 'receiving_warehouse', label: 'Warehouse' },
  { id: 'etd', label: 'CRD' },
  { id: 'eta', label: 'Exp. Recv Date' },
  { id: 'actual_receive_date', label: 'Actual Recv Date' }
];

export default function PurchaseOrdersClient({ initialPOs }: { initialPOs: any[] }) {
  const [pos, setPos] = useState<any[]>(initialPOs);
  const [isLoading, setIsLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [filterStatus, setFilterStatus] = useState('All');
  const [filterSeason, setFilterSeason] = useState('All');
  const [filterType, setFilterType] = useState('All');
  const [selectedPO, setSelectedPO] = useState<any>(null);
  const [isSaving, setIsSaving] = useState(false);
  const { user } = useSession();
  const [suppliers, setSuppliers] = useState<any[]>([]);
  const [couriers, setCouriers] = useState<any[]>([]);
  const [incoterms, setIncoterms] = useState<any[]>([]);
  const [statuses, setStatuses] = useState<any[]>([]);
  const [visibleColumns, setVisibleColumns] = useState<string[]>(['season', 'po_number', 'supplier', 'mode', 'incoterm', 'expected_qty', 'received_qty', 'etd', 'eta', 'actual_receive_date']);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const fetchPOs = async () => {
    setIsLoading(true);
    try {
      const [data, s, c, i, st] = await Promise.all([
        getPurchaseOrders(),
        getSuppliers(),
        getCouriers(),
        getIncoterms(),
        getStatuses()
      ]);
      setPos(data || []);
      setSuppliers(s || []);
      setCouriers(c || []);
      setIncoterms(i || []);
      setStatuses(st || []);
    } catch (e) {
      console.error(e);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => { fetchPOs(); }, []);

  const seasons = [...new Set(pos.map((p: any) => p.season).filter(Boolean))];

  const filtered = pos.filter((p: any) => {
    const matchSearch = !search ||
      p.po_number?.toLowerCase().includes(search.toLowerCase()) ||
      p.supplier?.toLowerCase().includes(search.toLowerCase()) ||
      p.trn_number?.toLowerCase().includes(search.toLowerCase());
    const matchSeason = filterSeason === 'All' || p.season === filterSeason;
    const matchType = filterType === 'All' || p.type === filterType;
    
    // Vendor isolation
    const matchVendor = !user || user.role !== 'Vendor' || p.supplier === user.supplier;
    
    return matchSearch && matchSeason && matchType && matchVendor;
  });

  const openAdd = () => { setSelectedPO(true); };
  const openEdit = (po: any) => { setSelectedPO(po); };

  const handleSave = async (data: any) => {
    setIsSaving(true);
    try {
      if (data.id) {
        await updatePurchaseOrder(data.id, data);
        toast.success(`PO ${data.po_number} updated.`);
      } else {
        await createPurchaseOrder(data);
        toast.success(`PO ${data.po_number} added.`);
      }
      fetchPOs();
    } catch (e) {
      toast.error('Failed to save PO.');
      throw e;
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async (po: any) => {
    if (!window.confirm(`Delete PO ${po.po_number}?`)) return;
    await deletePurchaseOrder(po.id);
    toast.success(`PO ${po.po_number} deleted.`);
    fetchPOs();
    setSelectedPO(null);
  };

  const handleDuplicate = async (po: any) => {
    try {
      await duplicatePurchaseOrder(po);
      toast.success(`PO ${po.po_number} duplicated.`);
      fetchPOs();
      setSelectedPO(null);
    } catch (e) {
      toast.error('Failed to duplicate PO.');
    }
  };

  const handleExport = () => {
    if (filtered.length === 0) { toast.error('No data to export'); return; }
    const Papa = require('papaparse');
    const csv = Papa.unparse(filtered.map((p: any) => ({
      Season: p.season, 'TRN No.': p.trn_number, 'Type': p.type || 'mainline', 'PO#': p.po_number,
      Supplier: p.supplier, Mode: p.mode, Incoterm: p.incoterm || '',
      'Expected Qty': p.expected_qty, 'Receiving Qty': p.received_qty, 'Warehouse': p.receiving_warehouse,
      'CRD': p.etd,
      'Exp. Recv Date': p.eta,
      'Actual Recv Date': p.actual_receive_date || ''
    })));
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url;
    a.download = `po_master_${format(new Date(), 'yyyy-MM-dd')}.csv`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    toast.success(`Exported ${filtered.length} POs.`);
  };

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const Papa = require('papaparse');
    Papa.parse(file, {
      header: true, skipEmptyLines: true,
      complete: async (result: any) => {
        const rows = result.data.map((r: any) => ({
          season: r['Season'] || r['season'] || '',
          trn_number: r['TRN No.'] || r['trn_number'] || '',
          type: r['Type'] || r['type'] || 'mainline',
          po_number: r['PO#'] || r['po_number'] || '',
          supplier: r['Supplier'] || r['supplier'] || '',
          mode: r['Mode'] || r['mode'] || '',
          courier: r['Courier'] || r['courier'] || '',
          incoterm: r['Incoterm'] || r['incoterm'] || '',
          expected_qty: r['Expected Qty'] || r['expected_qty'] || '',
          receiving_warehouse: r['Warehouse'] || r['receiving_warehouse'] || '',
          etd: r['ETD'] || r['etd'] || '',
          eta: r['Exp. Recv Date'] || r['eta'] || '',
          actual_receive_date: r['Actual Recv Date'] || r['actual_receive_date'] || ''
        })).filter((r: any) => r.po_number);
        if (rows.length === 0) { toast.error('No valid PO rows found in file.'); return; }
        try {
          const result = await bulkCreatePurchaseOrders(rows);
          toast.success(`Import success: ${result.added} new POs added, ${result.updated} existing POs updated.`);
          fetchPOs();
        } catch (e) { toast.error('Import failed.'); }
      },
    });
    e.target.value = '';
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold font-inter">Purchase Orders</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Season master list — the starting point for the booking lifecycle.</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={handleExport}>
            <Download className="w-4 h-4 mr-1.5" /> Export
          </Button>
          <Button variant="outline" onClick={() => fileInputRef.current?.click()}>
            <Upload className="w-4 h-4 mr-1.5" /> Import CSV
          </Button>
          <input ref={fileInputRef} type="file" accept=".csv" className="hidden" onChange={handleImport} />
          <Button onClick={openAdd}>
            <Plus className="w-4 h-4 mr-1.5" /> Add PO
          </Button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input placeholder="Search PO#, supplier, TRN..." className="pl-9" value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <Select value={filterSeason} onValueChange={v => setFilterSeason(v || 'All')}>
          <SelectTrigger className="w-36"><SelectValue placeholder="Season" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="All">All Seasons</SelectItem>
            {seasons.map((s: any) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={filterType} onValueChange={v => setFilterType(v || 'All')}>
          <SelectTrigger className="w-36"><SelectValue placeholder="Type" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="All">All Types</SelectItem>
            <SelectItem value="mainline">Mainline</SelectItem>
            <SelectItem value="sms">SMS</SelectItem>
          </SelectContent>
        </Select>
        <div className="flex items-center gap-2 ml-auto">
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline" size="sm" className="h-10 gap-2 border-dashed">
                <Settings2 className="w-4 h-4" /> Columns
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-56 p-2" align="end">
              <div className="space-y-1">
                <h4 className="text-xs font-bold px-2 py-1.5 uppercase text-muted-foreground tracking-wider">Display Fields</h4>
                <div className="max-h-[300px] overflow-y-auto">
                  {ALL_COLUMNS.map(col => (
                    <div key={col.id} className="flex items-center gap-2 px-2 py-1.5 hover:bg-muted rounded-md cursor-pointer" onClick={() => {
                      setVisibleColumns(prev => prev.includes(col.id) ? prev.filter(c => c !== col.id) : [...prev, col.id]);
                    }}>
                      <div className={cn("w-4 h-4 rounded border border-primary flex items-center justify-center transition-colors", visibleColumns.includes(col.id) ? "bg-primary" : "bg-transparent border-input")}>
                        {visibleColumns.includes(col.id) && <Check className="w-3 h-3 text-white" />}
                      </div>
                      <span className="text-sm font-medium">{col.label}</span>
                    </div>
                  ))}
                </div>
              </div>
            </PopoverContent>
          </Popover>
          <div className="text-[10px] text-muted-foreground font-bold uppercase tracking-wider ml-2">
            {filtered.length} / {pos.length} Records
          </div>
        </div>
      </div>

      {/* Table */}
      <div className="bg-card rounded-xl border border-border overflow-hidden shadow-sm">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/50">
              {ALL_COLUMNS.filter(c => visibleColumns.includes(c.id)).map(col => (
                <TableHead key={col.id} className={cn("font-semibold", (col.id === 'expected_qty' || col.id === 'received_qty') && "text-right")}>
                  {col.label}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={12} className="text-center py-10 text-muted-foreground">Loading...</TableCell></TableRow>
            ) : filtered.length === 0 ? (
              <TableRow>
                <TableCell colSpan={12} className="text-center py-12 text-muted-foreground italic">
                  {pos.length === 0
                    ? 'No POs yet. Import a CSV from NetSuite or add manually.'
                    : 'No POs match your filters.'}
                </TableCell>
              </TableRow>
            ) : (
              filtered.map((p: any) => (
                <TableRow key={p.id} className="cursor-pointer hover:bg-muted/30 transition-colors" onClick={() => openEdit(p)}>
                  {visibleColumns.includes('season') && <TableCell className="text-xs font-mono">{p.season || '—'}</TableCell>}
                  {visibleColumns.includes('trn_number') && <TableCell className="text-xs font-mono">{p.trn_number || '—'}</TableCell>}
                  {visibleColumns.includes('type') && <TableCell className="text-xs font-mono capitalize">{p.type || 'mainline'}</TableCell>}
                  {visibleColumns.includes('po_number') && <TableCell className="text-sm font-semibold">{p.po_number || '—'}</TableCell>}
                  {visibleColumns.includes('supplier') && <TableCell className="text-sm">{p.supplier || '—'}</TableCell>}
                  {visibleColumns.includes('mode') && <TableCell className="text-sm">{p.mode || '—'}</TableCell>}
                  {visibleColumns.includes('incoterm') && <TableCell className="text-sm font-medium text-amber-700">{p.incoterm || '—'}</TableCell>}
                  {visibleColumns.includes('expected_qty') && <TableCell className="text-sm text-right font-semibold">{p.expected_qty || '—'}</TableCell>}
                  {visibleColumns.includes('received_qty') && <TableCell className="text-sm text-right">{p.received_qty || '0'}</TableCell>}
                  {visibleColumns.includes('receiving_warehouse') && <TableCell className="text-sm">{p.receiving_warehouse || '—'}</TableCell>}
                  {visibleColumns.includes('etd') && <TableCell className="text-sm">{p.etd || '—'}</TableCell>}
                  {visibleColumns.includes('eta') && <TableCell className="text-sm">{p.eta || '—'}</TableCell>}
                  {visibleColumns.includes('actual_receive_date') && (
                    <TableCell className="text-sm font-bold text-emerald-600">
                      {p.actual_receive_date || '—'}
                    </TableCell>
                  )}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <PoDetailDrawer
        open={selectedPO}
        onClose={() => setSelectedPO(null)}
        onSave={handleSave}
        onDelete={handleDelete}
        onDuplicate={handleDuplicate}
        suppliers={suppliers}
        incoterms={incoterms}
        isLoading={isSaving}
        user={user}
      />
    </div>
  );
}
