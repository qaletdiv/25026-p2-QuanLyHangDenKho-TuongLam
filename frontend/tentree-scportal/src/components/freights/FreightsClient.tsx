'use client';

import React, { useCallback, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  AlertTriangle, Download, FileSpreadsheet, Globe, RefreshCw,
  Search, Trash2, Upload, X,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { format } from 'date-fns';
import { docHref } from '@/lib/api';
import {
  parseFreightTemplate,
  exportFreightRecord,
  deleteFreightRecord,
  getFreightRecord,
} from '@/app/actions/freights';

// ── Types ────────────────────────────────────────────────────────────────────

interface FreightRate {
  origin: string;
  destination: string;
  containerType: string;
  moveType: 'FCL' | 'LCL';
  rateUSD: number;
  transitDays: string;
  changePercent: number | null;
  unit: string;
}

interface FreightRecord {
  id: string;
  forwarder: string;
  region: string;
  quote_ref: string | null;
  effective_date: string | null;
  expiry_date: string | null;
  rates: FreightRate[];
  file_name: string;
  parsed_at: string;
  rate_count?: number;
}

type SortField = 'origin' | 'destination' | 'containerType' | 'rateUSD' | 'transitDays' | 'changePercent';
type SortDir   = 'asc' | 'desc';
type FilterMode = 'all' | 'FCL' | 'LCL';

// ── Main Component ────────────────────────────────────────────────────────────

export default function FreightsClient({ initialRecords = [] }: { initialRecords: any[] }) {
  const inputRef = useRef<HTMLInputElement>(null);

  // Upload / parse state
  const [isDragging, setIsDragging]   = useState(false);
  const [isParsing, setIsParsing]     = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [error, setError]             = useState<string | null>(null);
  const [fileName, setFileName]       = useState<string | null>(null);

  // Metadata fields (filled by user before upload)
  const [forwarder,     setForwarder]     = useState('');
  const [region,        setRegion]        = useState('');
  const [quoteRef,      setQuoteRef]      = useState('');
  const [effectiveDate, setEffectiveDate] = useState('');
  const [expiryDate,    setExpiryDate]    = useState('');

  // Current parsed / viewed record
  const [currentRecord, setCurrentRecord] = useState<FreightRecord | null>(null);

  // History
  const [records,   setRecords]   = useState<any[]>(initialRecords);
  const [loadingId, setLoadingId] = useState<string | null>(null);

  // Table filter / sort
  const [filterMode,  setFilterMode]  = useState<FilterMode>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [sortField,   setSortField]   = useState<SortField>('origin');
  const [sortDir,     setSortDir]     = useState<SortDir>('asc');

  // ── Template download ────────────────────────────────────────────────────────

  // Goes through our own /api/documents proxy, which authenticates via the httpOnly
  // cookie. Previously this called a server action that RETURNED the raw JWT so this
  // client code could set an Authorization header — which put the token in browser
  // JavaScript and undid the httpOnly cookie entirely (any XSS could read it).
  const handleDownloadTemplate = async () => {
    const res = await fetch(docHref('/freights/template'));
    if (!res.ok) { toast.error('Failed to download template'); return; }
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'freight_rate_template.xlsx';
    a.click();
    URL.revokeObjectURL(a.href);
  };

  // ── File processing ──────────────────────────────────────────────────────────

  const processFile = async (file: File) => {
    const allowed = ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                     'application/vnd.ms-excel', 'text/csv'];
    const extOk = /\.(xlsx|xls|csv)$/i.test(file.name);
    if (!allowed.includes(file.type) && !extOk) {
      setError('Only Excel (.xlsx, .xls) or CSV files are supported.');
      return;
    }

    setIsParsing(true);
    setError(null);
    setCurrentRecord(null);
    setFileName(file.name);
    setFilterMode('all');
    setSearchQuery('');

    try {
      const fd = new FormData();
      fd.append('file',           file);
      fd.append('forwarder',      forwarder.trim()     || 'Unknown');
      fd.append('region',         region.trim()        || 'Unknown');
      fd.append('quote_ref',      quoteRef.trim());
      fd.append('effective_date', effectiveDate.trim());
      fd.append('expiry_date',    expiryDate.trim());

      const record = await parseFreightTemplate(fd);
      if (record?.error) throw new Error(record.error);

      setCurrentRecord(record);
      setRecords(prev => [{ ...record, rate_count: record.rates?.length ?? 0 }, ...prev.filter(r => r.id !== record.id)]);
      toast.success(`Imported ${record.rates?.length ?? 0} rates from ${file.name}`);
    } catch (err: any) {
      setError(err.message || 'Import failed');
    } finally {
      setIsParsing(false);
    }
  };

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) processFile(file);
  }, [forwarder, region, quoteRef, effectiveDate, expiryDate]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) processFile(file);
    e.target.value = '';
  };

  // ── Export ───────────────────────────────────────────────────────────────────

  const handleExport = async (record: FreightRecord) => {
    setIsExporting(true);
    try {
      const { file_url } = await exportFreightRecord(record.id);
      const a = document.createElement('a');
      a.href = docHref(file_url);
      a.download = file_url.split('/').pop() || 'freight.xlsx';
      a.click();
      toast.success('Excel exported');
    } catch (err: any) {
      toast.error(err.message || 'Export failed');
    } finally {
      setIsExporting(false);
    }
  };

  // ── Delete ───────────────────────────────────────────────────────────────────

  const handleDelete = async (id: string) => {
    try {
      await deleteFreightRecord(id);
      setRecords(prev => prev.filter(r => r.id !== id));
      if (currentRecord?.id === id) setCurrentRecord(null);
      toast.success('Record deleted');
    } catch (err: any) {
      toast.error(err.message || 'Delete failed');
    }
  };

  // ── Load saved record ────────────────────────────────────────────────────────

  const loadRecord = async (id: string) => {
    if (currentRecord?.id === id) return;
    setLoadingId(id);
    try {
      const record = await getFreightRecord(id);
      setCurrentRecord(record);
      setFilterMode('all');
      setSearchQuery('');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err: any) {
      toast.error(err.message || 'Failed to load record');
    } finally {
      setLoadingId(null);
    }
  };

  // ── Table logic ──────────────────────────────────────────────────────────────

  const handleSort = (field: SortField) => {
    if (sortField === field) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortField(field); setSortDir('asc'); }
  };

  const rates = currentRecord?.rates ?? [];

  const filteredRates = rates
    .filter(r => filterMode === 'all' || r.moveType === filterMode)
    .filter(r => {
      if (!searchQuery) return true;
      const q = searchQuery.toLowerCase();
      return r.origin.toLowerCase().includes(q) ||
        r.destination.toLowerCase().includes(q) ||
        r.containerType.toLowerCase().includes(q);
    })
    .sort((a, b) => {
      let va: any = (a as any)[sortField] ?? '';
      let vb: any = (b as any)[sortField] ?? '';
      if (typeof va === 'string') va = va.toLowerCase();
      if (typeof vb === 'string') vb = vb.toLowerCase();
      if (va === null || va === '') va = -Infinity;
      if (vb === null || vb === '') vb = -Infinity;
      return sortDir === 'asc' ? (va < vb ? -1 : va > vb ? 1 : 0) : (va > vb ? -1 : va < vb ? 1 : 0);
    });

  const fclCount = rates.filter(r => r.moveType === 'FCL').length;
  const lclCount = rates.filter(r => r.moveType === 'LCL').length;
  const avgRate  = rates.length ? Math.round(rates.reduce((s, r) => s + r.rateUSD, 0) / rates.length) : 0;

  const SortIcon = ({ field }: { field: SortField }) => (
    <span className={cn('ml-1 text-[10px]', sortField === field ? 'opacity-100' : 'opacity-25')}>
      {sortField === field ? (sortDir === 'asc' ? '↑' : '↓') : '↕'}
    </span>
  );

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <div className="p-4 md:p-6 space-y-6 max-w-[1400px] mx-auto">

      {/* Page header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Globe className="w-5 h-5 text-primary" />
          <h1 className="text-xl font-semibold">Freight Rates</h1>
        </div>
        <Button variant="outline" size="sm" className="gap-2" onClick={handleDownloadTemplate}>
          <Download className="w-3.5 h-3.5" />
          Download Template
        </Button>
      </div>

      {/* Upload section */}
      {!currentRecord && !isParsing && (
        <div className="space-y-4">

          {/* Metadata row */}
          <div className="grid grid-cols-1 sm:grid-cols-3 lg:grid-cols-5 gap-3">
            <div className="space-y-1">
              <Label className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Forwarder</Label>
              <Input placeholder="e.g. CEVA" value={forwarder} onChange={e => setForwarder(e.target.value)} className="h-9" />
            </div>
            <div className="space-y-1">
              <Label className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Region</Label>
              <Input placeholder="e.g. Vancouver" value={region} onChange={e => setRegion(e.target.value)} className="h-9" />
            </div>
            <div className="space-y-1">
              <Label className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Quote Ref</Label>
              <Input placeholder="Optional" value={quoteRef} onChange={e => setQuoteRef(e.target.value)} className="h-9" />
            </div>
            <div className="space-y-1">
              <Label className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Effective</Label>
              <Input type="date" value={effectiveDate} onChange={e => setEffectiveDate(e.target.value)} className="h-9" />
            </div>
            <div className="space-y-1">
              <Label className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Expiry</Label>
              <Input type="date" value={expiryDate} onChange={e => setExpiryDate(e.target.value)} className="h-9" />
            </div>
          </div>

          {/* Drop zone */}
          <div
            onDragOver={e => { e.preventDefault(); setIsDragging(true); }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={handleDrop}
            onClick={() => inputRef.current?.click()}
            className={cn(
              'flex flex-col items-center justify-center gap-3 border-2 border-dashed rounded-xl px-4 py-10 sm:px-8 sm:py-14',
              'cursor-pointer transition-all duration-200 select-none',
              isDragging
                ? 'border-primary bg-primary/5 scale-[1.01]'
                : 'border-border bg-muted/10 hover:border-primary/50 hover:bg-muted/20',
            )}
          >
            <input ref={inputRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={handleFileChange} />
            <FileSpreadsheet className={cn('w-10 h-10', isDragging ? 'text-primary' : 'text-muted-foreground/40')} />
            <div className="text-center">
              <p className="text-sm font-semibold">Drop filled template here</p>
              <p className="text-xs text-muted-foreground mt-1">
                Accepts .xlsx, .xls, .csv · <button type="button" className="text-primary underline-offset-2 hover:underline" onClick={e => { e.stopPropagation(); handleDownloadTemplate(); }}>Download template</button> to get started
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Parsing loader */}
      {isParsing && (
        <div className="flex flex-col items-center justify-center gap-4 border border-border rounded-xl px-8 py-14 bg-muted/10">
          <RefreshCw className="w-8 h-8 text-primary animate-spin" />
          <div className="text-center">
            <p className="text-sm font-semibold">Importing {fileName}…</p>
            <p className="text-xs text-muted-foreground mt-1">Reading rows and saving record</p>
          </div>
        </div>
      )}

      {/* Error banner */}
      {error && (
        <div className="flex items-start justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          <span className="flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
            {error}
          </span>
          <Button variant="ghost" size="sm" className="h-6 px-2 text-destructive hover:text-destructive shrink-0" onClick={() => { setError(null); setFileName(null); }}>
            <X className="w-3 h-3" />
          </Button>
        </div>
      )}

      {/* Results */}
      {currentRecord && (
        <div className="space-y-4">

          {/* Result header */}
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold">{currentRecord.forwarder} · {currentRecord.region}</span>
              {currentRecord.quote_ref && (
                <Badge variant="outline" className="text-xs font-mono">REF: {currentRecord.quote_ref}</Badge>
              )}
              {currentRecord.effective_date && (
                <span className="text-xs text-muted-foreground">
                  {currentRecord.effective_date} → {currentRecord.expiry_date || '?'}
                </span>
              )}
              <span className="text-xs text-muted-foreground italic">{currentRecord.file_name}</span>
            </div>
            <div className="flex items-center gap-2 ml-auto">
              <Button variant="outline" size="sm" className="h-8 gap-1.5" onClick={() => handleExport(currentRecord)} disabled={isExporting}>
                {isExporting ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
                Export XLSX
              </Button>
              <Button variant="ghost" size="sm" className="h-8 gap-1.5 text-muted-foreground"
                onClick={() => { setCurrentRecord(null); setFileName(null); setError(null); setSearchQuery(''); setFilterMode('all'); }}>
                <Upload className="w-3.5 h-3.5" />
                New Upload
              </Button>
            </div>
          </div>

          {/* Stats */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              { label: 'Total Rates', value: rates.length,                    color: 'text-foreground'   },
              { label: 'FCL Rates',   value: fclCount,                        color: 'text-blue-600'     },
              { label: 'LCL Rates',   value: lclCount,                        color: 'text-emerald-600'  },
              { label: 'Avg Rate',    value: `$${avgRate.toLocaleString()}`,   color: 'text-foreground'   },
            ].map(s => (
              <div key={s.label} className="rounded-lg border border-border bg-card px-4 py-3">
                <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{s.label}</p>
                <p className={cn('text-2xl font-semibold mt-1', s.color)}>{s.value}</p>
              </div>
            ))}
          </div>

          {/* Toolbar */}
          <div className="flex flex-wrap items-center gap-3 rounded-t-lg border border-border bg-muted/20 px-3 py-2.5">
            <div className="flex items-center gap-1">
              {(['all', 'FCL', 'LCL'] as FilterMode[]).map(mode => (
                <Button key={mode} variant={filterMode === mode ? 'default' : 'ghost'} size="sm"
                  className="h-7 px-3 text-xs font-semibold" onClick={() => setFilterMode(mode)}>
                  {mode === 'all' ? 'All' : mode}
                </Button>
              ))}
            </div>
            <div className="relative flex-1 min-w-[160px] max-w-xs">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
              <Input placeholder="Search origin, destination..." value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)} className="pl-8 h-7 text-xs" />
            </div>
            <span className="ml-auto text-[11px] text-muted-foreground tabular-nums">
              {filteredRates.length} of {rates.length} rates
            </span>
          </div>

          {/* Rates table */}
          <div className="rounded-b-lg border border-t-0 border-border overflow-hidden bg-card">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/40">
                    {([
                      { label: 'Origin',      field: 'origin'        },
                      { label: 'Destination', field: 'destination'   },
                      { label: 'Type',        field: 'containerType' },
                      { label: 'Container',   field: 'containerType' },
                      { label: 'Rate (USD)',  field: 'rateUSD'       },
                      { label: 'Unit',        field: 'containerType' },
                      { label: 'Transit',     field: 'transitDays'   },
                      { label: 'Δ Chg',       field: 'changePercent' },
                    ] as { label: string; field: SortField }[]).map(col => (
                      <TableHead key={col.label}
                        className="text-[10px] font-bold uppercase tracking-wider cursor-pointer select-none whitespace-nowrap"
                        onClick={() => handleSort(col.field)}>
                        {col.label}<SortIcon field={col.field} />
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredRates.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={8} className="text-center py-10 text-muted-foreground text-sm">
                        No rates match your filter
                      </TableCell>
                    </TableRow>
                  ) : (
                    filteredRates.map((rate, i) => {
                      const chg = rate.changePercent;
                      const chgClass = chg === null ? 'text-muted-foreground'
                        : chg > 0 ? 'text-destructive font-semibold'
                        : chg < 0 ? 'text-emerald-600 font-semibold'
                        : 'text-muted-foreground';
                      return (
                        <TableRow key={i} className="text-xs">
                          <TableCell className="font-medium max-w-[160px] truncate">{rate.origin}</TableCell>
                          <TableCell className="text-muted-foreground max-w-[140px] truncate">{rate.destination}</TableCell>
                          <TableCell>
                            <Badge variant="secondary" className={cn('text-[10px] font-semibold px-1.5',
                              rate.moveType === 'FCL'
                                ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400'
                                : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400')}>
                              {rate.moveType}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-muted-foreground">{rate.containerType}</TableCell>
                          <TableCell className="font-semibold tabular-nums">${rate.rateUSD.toLocaleString()}</TableCell>
                          <TableCell className="text-muted-foreground text-[11px]">{rate.unit}</TableCell>
                          <TableCell className="text-muted-foreground whitespace-nowrap">{rate.transitDays || '—'}</TableCell>
                          <TableCell className={cn('whitespace-nowrap tabular-nums', chgClass)}>
                            {chg !== null ? `${chg > 0 ? '+' : ''}${chg}%` : '—'}
                          </TableCell>
                        </TableRow>
                      );
                    })
                  )}
                </TableBody>
              </Table>
            </div>
          </div>
        </div>
      )}

      {/* History */}
      {records.length > 0 && (
        <div className="space-y-2">
          <h2 className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">Saved Records</h2>
          <div className="rounded-lg border border-border overflow-hidden bg-card">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/40">
                  <TableHead className="text-[10px] font-bold uppercase tracking-wider">Forwarder</TableHead>
                  <TableHead className="text-[10px] font-bold uppercase tracking-wider">Region</TableHead>
                  <TableHead className="text-[10px] font-bold uppercase tracking-wider">Quote Ref</TableHead>
                  <TableHead className="text-[10px] font-bold uppercase tracking-wider">Validity</TableHead>
                  <TableHead className="text-[10px] font-bold uppercase tracking-wider text-right">Rates</TableHead>
                  <TableHead className="text-[10px] font-bold uppercase tracking-wider">Source File</TableHead>
                  <TableHead className="text-[10px] font-bold uppercase tracking-wider">Parsed</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {records.map(r => (
                  <TableRow key={r.id}
                    className={cn('text-xs cursor-pointer hover:bg-primary/5 transition-colors',
                      currentRecord?.id === r.id && 'bg-primary/10')}
                    onClick={() => loadRecord(r.id)}>
                    <TableCell className="font-semibold">{r.forwarder}</TableCell>
                    <TableCell>{r.region}</TableCell>
                    <TableCell className="font-mono text-muted-foreground">{r.quote_ref || '—'}</TableCell>
                    <TableCell className="text-muted-foreground whitespace-nowrap">
                      {r.effective_date ? `${r.effective_date} → ${r.expiry_date || '?'}` : '—'}
                    </TableCell>
                    <TableCell className="text-right tabular-nums font-semibold">{r.rate_count ?? '—'}</TableCell>
                    <TableCell className="text-muted-foreground max-w-[160px] truncate">{r.file_name}</TableCell>
                    <TableCell className="text-muted-foreground whitespace-nowrap">
                      {(() => { try { return format(new Date(r.parsed_at), 'MMM d, yyyy'); } catch { return r.parsed_at; } })()}
                    </TableCell>
                    <TableCell onClick={e => e.stopPropagation()}>
                      <div className="flex items-center gap-1 justify-end">
                        {loadingId === r.id && <RefreshCw className="w-3 h-3 animate-spin text-muted-foreground" />}
                        <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                          onClick={() => handleDelete(r.id)}>
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}
    </div>
  );
}
