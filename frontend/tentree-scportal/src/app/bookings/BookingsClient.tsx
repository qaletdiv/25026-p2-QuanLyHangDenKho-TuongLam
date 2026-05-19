'use client';

import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { getBookings, getHistoryBookings } from '../actions/bookings';
import { getPurchaseOrders } from '../actions/purchase-orders';
import { useSession } from '@/components/providers/SessionProvider';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Search, Download, Settings2, Check, Clock, ArrowRight, FileSpreadsheet, ChevronLeft, ChevronRight } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { format } from 'date-fns';
import BookingForm from '@/components/bookings/BookingForm';
import Papa from 'papaparse';

// ─── Pending POs ────────────────────────────────────────────────────────────

const PAGE_SIZE = 10;

function PendingPOsList({ user, initialPendingPOs }: any) {
  const router = useRouter();
  const [pos, setPos] = useState<any[]>(initialPendingPOs || []);
  const [isLoading, setIsLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [filterStatus, setFilterStatus] = useState('All');
  const [confirmPO, setConfirmPO] = useState<any>(null);
  const [page, setPage] = useState(1);

  const fetchPending = async () => {
    setIsLoading(true);
    try {
      const all = await getPurchaseOrders() || [];
      const pending = all.filter((p: any) => {
        const isVendorMatch = !user || user.role !== 'Vendor' || p.supplier === user.supplier;
        const remaining = (parseInt(p.expected_qty) || 0) - (parseInt(p.booked_qty) || 0);
        return isVendorMatch && remaining > 0;
      });
      setPos(pending);
    } catch (e) {
      console.error('Failed to fetch pending POs:', e);
      toast.error('Failed to load pending POs. Please refresh.');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchPending();
  }, [user]);

  useEffect(() => { setPage(1); }, [search, filterStatus]);

  const filtered = pos.filter((p) => {
    const q = search.toLowerCase();
    const matchSearch = !q ||
      p.po_number?.toLowerCase().includes(q) ||
      p.trn_number?.toLowerCase().includes(q) ||
      p.supplier?.toLowerCase().includes(q);
    const matchStatus =
      filterStatus === 'All' ||
      (filterStatus === 'No Status' ? !p.booking_status : p.booking_status === filterStatus);
    const matchVendor = !user || user.role !== 'Vendor' || p.supplier === user.supplier;
    return matchSearch && matchStatus && matchVendor;
  });

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const paginated = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  return (
    <>
      <div className="space-y-4">
        <div className="flex flex-wrap gap-3 items-center">
          <h3 className="text-sm font-semibold flex items-center gap-2 mr-2">
            <Clock className="w-4 h-4 text-amber-500" />
            Pending Bookings ({filtered.length}{filtered.length !== pos.length ? ` of ${pos.length}` : ''})
          </h3>
          <div className="relative flex-1 min-w-[200px] max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              placeholder="Search by PO#, TRN#, vendor..."
              className="pl-9"
              value={search}
              onChange={(e: any) => setSearch(e.target.value)}
            />
          </div>
          <Select value={filterStatus} onValueChange={(val) => setFilterStatus(val || 'All')}>
            <SelectTrigger className="w-44"><SelectValue placeholder="Status" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="All">All Statuses</SelectItem>
              <SelectItem value="Booking Pending">Pending Approval</SelectItem>
              <SelectItem value="Declined">Declined</SelectItem>
              <SelectItem value="No Status">No Status</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="border rounded-lg overflow-hidden bg-card shadow-sm">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/50">
                <TableHead className="w-[80px]">Season</TableHead>
                <TableHead>TRN No.</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>PO#</TableHead>
                {user?.role !== 'Vendor' && <TableHead>Vendor</TableHead>}
                <TableHead>Mode</TableHead>
                <TableHead>Incoterm</TableHead>
                <TableHead>Expected</TableHead>
                <TableHead>Booked</TableHead>
                <TableHead>Remaining</TableHead>
                <TableHead>Warehouse</TableHead>
                <TableHead>ETD</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow><TableCell colSpan={user?.role !== 'Vendor' ? 14 : 13} className="text-center py-10">Loading pending POs...</TableCell></TableRow>
              ) : filtered.length === 0 ? (
                <TableRow><TableCell colSpan={user?.role !== 'Vendor' ? 14 : 13} className="text-center py-12 text-muted-foreground italic">{pos.length === 0 ? 'No pending POs found.' : 'No results match your search.'}</TableCell></TableRow>
              ) : (
                paginated.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell className="text-xs font-mono">{p.season || '—'}</TableCell>
                    <TableCell className="text-xs font-mono">{p.trn_number || '—'}</TableCell>
                    <TableCell className="text-xs capitalize">{p.type || 'mainline'}</TableCell>
                    <TableCell className="font-semibold text-sm">{p.po_number}</TableCell>
                    {user?.role !== 'Vendor' && <TableCell className="text-xs">{p.supplier || '—'}</TableCell>}
                    <TableCell className="text-xs">{p.mode || '—'}</TableCell>
                    <TableCell className="text-xs font-bold text-amber-700">{p.incoterm || '—'}</TableCell>
                    <TableCell className="text-sm font-semibold">{p.expected_qty}</TableCell>
                    <TableCell className="text-sm text-blue-600 font-medium">{p.booked_qty || 0}</TableCell>
                    <TableCell className="text-sm text-emerald-600 font-bold">
                      {(parseInt(p.expected_qty) || 0) - (parseInt(p.booked_qty) || 0)}
                    </TableCell>
                    <TableCell className="text-xs">{p.receiving_warehouse}</TableCell>
                    <TableCell className="text-xs">{p.etd}</TableCell>
                    <TableCell>
                      {p.booking_status === 'Booking Pending' ? (
                        <Badge variant="secondary" className="bg-amber-100 text-amber-800 whitespace-nowrap">Pending Approval</Badge>
                      ) : p.booking_status === 'Declined' ? (
                        <Badge variant="secondary" className="bg-red-100 text-red-800 whitespace-nowrap">Declined</Badge>
                      ) : (
                        <span className="text-muted-foreground text-xs">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button size="sm" variant="outline" className="h-8 gap-1 border-primary/30 text-primary hover:bg-primary/5 whitespace-nowrap" onClick={() => setConfirmPO(p)}>
                        Book Now <ArrowRight className="w-3 h-3" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between mt-3 px-1">
            <p className="text-xs text-muted-foreground">
              {filtered.length} result{filtered.length !== 1 ? 's' : ''} · Page {safePage} of {totalPages}
            </p>
            <div className="flex items-center gap-1">
              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setPage(p => Math.max(1, p - 1))} disabled={safePage <= 1}>
                <ChevronLeft className="w-4 h-4" />
              </Button>
              {Array.from({ length: totalPages }, (_, i) => i + 1)
                .filter(n => n === 1 || n === totalPages || Math.abs(n - safePage) <= 1)
                .reduce<(number | string)[]>((acc, n, idx, arr) => {
                  if (idx > 0 && n - (arr[idx - 1] as number) > 1) acc.push('…');
                  acc.push(n);
                  return acc;
                }, [])
                .map((n, i) =>
                  typeof n === 'string' ? (
                    <span key={`ellipsis-${i}`} className="px-1 text-xs text-muted-foreground">…</span>
                  ) : (
                    <Button
                      key={n}
                      variant={safePage === n ? 'default' : 'ghost'}
                      size="icon"
                      className="h-8 w-8 text-xs"
                      onClick={() => setPage(n)}
                    >
                      {n}
                    </Button>
                  )
                )}
              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={safePage >= totalPages}>
                <ChevronRight className="w-4 h-4" />
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Confirm single-PO dialog */}
      <Dialog open={!!confirmPO} onOpenChange={(open) => { if (!open) setConfirmPO(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Single PO Booking</DialogTitle>
            <DialogDescription asChild>
              <div>
                <p>This will open a booking form for <span className="font-semibold font-mono">{confirmPO?.po_number}</span>, which supports a <span className="font-semibold">single PO only</span>.</p>
                <p className="mt-3">If you need to ship multiple POs together, please use <span className="font-semibold">Submit Booking</span> instead.</p>
              </div>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmPO(null)}>Cancel</Button>
            <Button onClick={() => {
              router.push(`/bookings/submit?po=${encodeURIComponent(confirmPO.po_number)}`);
              setConfirmPO(null);
            }}>
              Continue with Single PO
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ─── Status Colors ───────────────────────────────────────────────────────────

const statusColors: any = {
  'No Booking': 'bg-background border border-border text-muted-foreground',
  'Booking': 'bg-muted border border-border text-foreground',
  'Booking Approved': 'bg-secondary border border-border text-secondary-foreground',
  'Declined': 'bg-destructive/20 border border-destructive/50 text-destructive-foreground',
  'Customs Clearance': 'bg-background border border-primary/30 text-primary',
  'In-Transit': 'bg-yellow-400 border border-yellow-500 text-yellow-950',
  'ASN Sent': 'bg-primary/20 border border-primary/40 text-primary-foreground',
  'Delivered': 'bg-blue-500/20 border border-blue-500/50 text-blue-600',
  'Ready to Ship': 'bg-green-500 border border-green-600 text-white',
  'Pending': 'bg-orange-500 border border-orange-600 text-white',
  'Draft': 'bg-background border border-border text-muted-foreground',
};

// ─── Column Definitions ──────────────────────────────────────────────────────

const ALL_COLUMNS = [
  { id: 'booking_number', label: 'Booking #' },
  { id: 'vendor_name', label: 'Vendor' },
  { id: 'season', label: 'Season' },
  { id: 'trn_number', label: 'TRN #' },
  { id: 'type', label: 'Type' },
  { id: 'tentree_po_number', label: 'PO Number' },
  { id: 'mode', label: 'Mode' },
  { id: 'incoterm', label: 'Incoterm' },
  { id: 'receiving_warehouse', label: 'Warehouse' },
  { id: 'number_of_cartons', label: 'Cartons' },
  { id: 'cargo_ready_date', label: 'Cargo Ready' },
  { id: 'freight_forwarder', label: 'Forwarder' },
  { id: 'booking_status', label: 'Status' },
  { id: 'commercial_invoice', label: 'CI File' },
  { id: 'submitted_at', label: 'Submitted' },
];

// ─── Bookings List ───────────────────────────────────────────────────────────

function BookingsList({ user, initialBookings, isHistory = false, initialBkg }: any) {
  const router = useRouter();
  const [search, setSearch] = useState('');
  const [filterStatus, setFilterStatus] = useState('All');
  const [bookings, setBookings] = useState<any[]>(initialBookings || []);
  const [isLoading, setIsLoading] = useState(false);
  const [visibleColumns, setVisibleColumns] = useState<string[]>(ALL_COLUMNS.map(c => c.id));
  const [page, setPage] = useState(1);

  useEffect(() => {
    if (initialBkg && bookings.length > 0) {
      const match = bookings.find((b: any) => b.booking_number === initialBkg);
      if (match) router.push(`/bookings/active/${match.id}`);
    }
  }, [initialBkg, bookings]);

  const fetchBookings = async () => {
    setIsLoading(true);
    try {
      const data = isHistory ? await getHistoryBookings() : await getBookings();
      setBookings(data || []);
    } catch (e) {
      console.error('Failed to fetch bookings:', e);
      toast.error('Failed to load bookings. Please refresh.');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchBookings();
  }, [isHistory]);

  useEffect(() => { setPage(1); }, [search, filterStatus]);

  const filtered = bookings.filter(b => {
    const q = search.toLowerCase();
    const matchSearch = !q ||
      b.vendor_name?.toLowerCase().includes(q) ||
      b.tentree_po_number?.toLowerCase().includes(q) ||
      b.booking_number?.toLowerCase().includes(q) ||
      b.season?.toLowerCase().includes(q) ||
      b.trn_number?.toLowerCase().includes(q) ||
      b.freight_forwarder?.toLowerCase().includes(q) ||
      b.courier?.toLowerCase().includes(q);
    const matchStatus = filterStatus === 'All' || b.booking_status === filterStatus;
    const matchVendor = !user || user.role !== 'Vendor' || b.vendor_name === user.supplier;
    return matchSearch && matchStatus && matchVendor;
  });

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const paginated = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  const toggleColumn = (id: string) => {
    setVisibleColumns(prev => prev.includes(id) ? prev.filter(c => c !== id) : [...prev, id]);
  };

  const handleExport = (allColumns = false) => {
    if (filtered.length === 0) { toast.error('No data to export'); return; }
    const csvData = filtered.map(s => {
      const row: any = {};
      if (allColumns) {
        Object.keys(s).forEach(key => { row[key] = s[key] !== null && s[key] !== undefined ? String(s[key]) : ''; });
      } else {
        ALL_COLUMNS.filter(c => visibleColumns.includes(c.id)).forEach(col => {
          row[col.label] = s[col.id] !== null && s[col.id] !== undefined ? String(s[col.id]) : '';
        });
      }
      return row;
    });
    const csv = Papa.unparse(csvData);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `tentree_bookings_${isHistory ? 'history' : 'active'}_${format(new Date(), 'yyyy-MM-dd')}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    toast.success(`Exported ${filtered.length} bookings to CSV`);
  };

  return (
    <>
      <div className="flex flex-wrap gap-3 mb-4">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input placeholder="Search by vendor, PO, booking #..." className="pl-9" value={search} onChange={(e: any) => setSearch(e.target.value)} />
        </div>
        <Select value={filterStatus} onValueChange={(val) => setFilterStatus(val || '')}>
          <SelectTrigger className="w-44"><SelectValue placeholder="Status" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="All">All Statuses</SelectItem>
            <SelectItem value="Booking">Booking</SelectItem>
            <SelectItem value="Booking Approved">Booking Approved</SelectItem>
            <SelectItem value="Customs Clearance">Customs Clearance</SelectItem>
            <SelectItem value="In-Transit">In-Transit</SelectItem>
            <SelectItem value="Delivered">Delivered</SelectItem>
            <SelectItem value="Declined">Declined</SelectItem>
            <SelectItem value="Draft">Draft</SelectItem>
          </SelectContent>
        </Select>
        <div className="flex items-center gap-2 ml-auto">
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline" className="h-10 border-primary/20 hover:bg-primary/5 gap-2">
                <Download className="w-4 h-4" /> Export
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-48 p-2" align="end">
              <div className="flex flex-col gap-1">
                <Button variant="ghost" size="sm" className="justify-start font-medium" onClick={() => handleExport(false)}>Export Current View</Button>
                <Button variant="ghost" size="sm" className="justify-start font-medium" onClick={() => handleExport(true)}>Export All Fields</Button>
              </div>
            </PopoverContent>
          </Popover>
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
                    <div key={col.id} className="flex items-center gap-2 px-2 py-1.5 hover:bg-muted rounded-md cursor-pointer" onClick={() => toggleColumn(col.id)}>
                      <div className={cn('w-4 h-4 rounded border border-primary flex items-center justify-center transition-colors', visibleColumns.includes(col.id) ? 'bg-primary' : 'bg-transparent border-input')}>
                        {visibleColumns.includes(col.id) && <Check className="w-3 h-3 text-white" />}
                      </div>
                      <span className="text-sm font-medium">{col.label}</span>
                    </div>
                  ))}
                </div>
              </div>
            </PopoverContent>
          </Popover>
        </div>
      </div>

      <div className="bg-card rounded-xl border border-border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/50">
              {ALL_COLUMNS.filter(c => visibleColumns.includes(c.id)).map(col => (
                <TableHead key={col.id} className="font-semibold">{col.label}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={visibleColumns.length} className="text-center py-8 text-muted-foreground">Loading...</TableCell></TableRow>
            ) : filtered.length === 0 ? (
              <TableRow><TableCell colSpan={visibleColumns.length} className="text-center py-8 text-muted-foreground">No bookings found</TableCell></TableRow>
            ) : (
              paginated.map(b => (
                <TableRow key={b.id} className="cursor-pointer hover:bg-primary/10 transition-colors" onClick={() => router.push((isHistory ? '/bookings/history/' : '/bookings/active/') + b.id)}>
                  {ALL_COLUMNS.filter(c => visibleColumns.includes(c.id)).map(col => {
                    if (col.id === 'booking_number') return <TableCell key={col.id} className="font-mono text-xs font-medium">{b.booking_number || '—'}</TableCell>;
                    if (col.id === 'vendor_name') return <TableCell key={col.id} className="text-sm">{b.vendor_name || '—'}</TableCell>;
                    if (col.id === 'season') return <TableCell key={col.id} className="text-sm font-mono">{b.season || '—'}</TableCell>;
                    if (col.id === 'trn_number') return <TableCell key={col.id} className="text-sm font-mono">{b.trn_number || '—'}</TableCell>;
                    if (col.id === 'type') return <TableCell key={col.id} className="text-sm capitalize">{b.type || '—'}</TableCell>;
                    if (col.id === 'tentree_po_number') return <TableCell key={col.id} className="text-sm font-medium">{b.tentree_po_number || '—'}</TableCell>;
                    if (col.id === 'mode') return <TableCell key={col.id} className="text-sm">{b.mode || '—'}</TableCell>;
                    if (col.id === 'incoterm') return <TableCell key={col.id} className="text-sm font-bold text-amber-700">{b.incoterm || '—'}</TableCell>;
                    if (col.id === 'receiving_warehouse') return <TableCell key={col.id} className="text-sm">{b.receiving_warehouse || '—'}</TableCell>;
                    if (col.id === 'number_of_cartons') return <TableCell key={col.id} className="text-sm">{b.number_of_cartons ?? '—'}</TableCell>;
                    if (col.id === 'cargo_ready_date') return (
                      <TableCell key={col.id} className="text-sm">
                        {(() => { try { return b.cargo_ready_date ? format(new Date(b.cargo_ready_date + 'T12:00:00'), 'MMM d, yyyy') : '—'; } catch { return b.cargo_ready_date || '—'; } })()}
                      </TableCell>
                    );
                    if (col.id === 'freight_forwarder') return <TableCell key={col.id} className="text-sm">{b.freight_forwarder || b.courier || '—'}</TableCell>;
                    if (col.id === 'booking_status') return (
                      <TableCell key={col.id}>
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <Badge className={statusColors[b.booking_status] || 'bg-gray-100 text-gray-700'} variant="secondary">
                            {b.booking_status || 'Draft'}
                          </Badge>
                          {b.overbooked && (
                            <Badge variant="outline" className="text-[10px] font-bold px-1.5 py-0 bg-amber-500/10 border-amber-500/40 text-amber-700">
                              Overbooked
                            </Badge>
                          )}
                        </div>
                      </TableCell>
                    );
                    if (col.id === 'commercial_invoice') {
                      const fileUrl = b.commercial_invoice?.file_url;
                      if (!fileUrl) return <TableCell key={col.id} className="text-sm text-muted-foreground">—</TableCell>;
                      const raw = fileUrl.split('/').pop() || '';
                      const displayName = raw.replace(/^ci_\d+_/, '');
                      return (
                        <TableCell key={col.id}>
                          <button
                            onClick={(e) => { e.stopPropagation(); router.push((isHistory ? '/bookings/history/' : '/bookings/active/') + b.id); }}
                            className="inline-flex items-center gap-1 text-xs text-primary hover:underline font-medium max-w-[160px] truncate"
                            title={displayName}
                          >
                            <FileSpreadsheet className="w-3.5 h-3.5 shrink-0" />
                            {displayName}
                          </button>
                        </TableCell>
                      );
                    }
                    if (col.id === 'submitted_at') return (
                      <TableCell key={col.id} className="text-sm text-muted-foreground">
                        {b.submitted_at ? format(new Date(b.submitted_at), 'MMM d') : '—'}
                      </TableCell>
                    );
                    return <TableCell key={col.id}>—</TableCell>;
                  })}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-3 px-1">
          <p className="text-xs text-muted-foreground">
            {filtered.length} result{filtered.length !== 1 ? 's' : ''} · Page {safePage} of {totalPages}
          </p>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setPage(p => Math.max(1, p - 1))} disabled={safePage <= 1}>
              <ChevronLeft className="w-4 h-4" />
            </Button>
            {Array.from({ length: totalPages }, (_, i) => i + 1)
              .filter(n => n === 1 || n === totalPages || Math.abs(n - safePage) <= 1)
              .reduce<(number | string)[]>((acc, n, idx, arr) => {
                if (idx > 0 && n - (arr[idx - 1] as number) > 1) acc.push('…');
                acc.push(n);
                return acc;
              }, [])
              .map((n, i) =>
                typeof n === 'string' ? (
                  <span key={`ellipsis-${i}`} className="px-1 text-xs text-muted-foreground">…</span>
                ) : (
                  <Button
                    key={n}
                    variant={safePage === n ? 'default' : 'ghost'}
                    size="icon"
                    className="h-8 w-8 text-xs"
                    onClick={() => setPage(n)}
                  >
                    {n}
                  </Button>
                )
              )}
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={safePage >= totalPages}>
              <ChevronRight className="w-4 h-4" />
            </Button>
          </div>
        </div>
      )}
    </>
  );
}

// ─── Main Orchestrator ───────────────────────────────────────────────────────

interface BookingsClientProps {
  tab: 'pending' | 'list' | 'history' | 'submit';
  initialActive?: any[];
  initialHistory?: any[];
  initialPending?: any[];
  initialBkg?: string;
  prefilledPO?: any;
}

export default function BookingsClient({
  tab,
  initialActive = [],
  initialHistory = [],
  initialPending = [],
  initialBkg,
  prefilledPO,
}: BookingsClientProps) {
  const router = useRouter();
  const { user } = useSession();

  return (
    <div className="p-6 space-y-4">
      {tab === 'pending' && (
        <PendingPOsList user={user} initialPendingPOs={initialPending} />
      )}

      {tab === 'list' && (
        <BookingsList user={user} initialBookings={initialActive} isHistory={false} initialBkg={initialBkg} />
      )}

      {tab === 'history' && (
        <BookingsList user={user} initialBookings={initialHistory} isHistory={true} />
      )}

      {tab === 'submit' && (
        <BookingForm
          prefilledPO={prefilledPO}
          onSuccess={() => {
            setTimeout(() => router.push('/bookings/active'), 1500);
          }}
          onSwitchToMultiPO={() => {
            router.push('/bookings/submit');
          }}
        />
      )}
    </div>
  );
}
