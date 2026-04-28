'use client';

import React, { useState, useEffect } from 'react';
import { getBookings, updateBooking, createBooking, deleteBooking } from '../actions/bookings';
import { getSession } from '../actions/auth';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Search, Plus, Download, Settings2, Check, Clock, ArrowRight } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { format } from 'date-fns';
import SopPanel from '@/components/layout/SopPanel';
import BookingForm from '@/components/bookings/BookingForm';
import BookingDetailDrawer from '@/components/bookings/BookingDetailDrawer';

const CustomsPlaceholder = () => <div>Customs Line Optimizer Placeholder</div>;

function PendingPOsList({ user, onBookNow }: any) {
  const [pos, setPos] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const fetchPending = async () => {
    setIsLoading(true);
    try {
      const res = await fetch('http://127.0.0.1:5000/purchase-orders');
      const all = await res.json();
      // Filter for current vendor and status 'No Booking'
      const pending = all.filter((p: any) => {
        const isVendorMatch = !user || user.role !== 'Vendor' || p.supplier === user.supplier;
        const remaining = (parseInt(p.expected_qty) || 0) - (parseInt(p.booked_qty) || 0);
        return isVendorMatch && remaining > 0;
      });
      setPos(pending);
    } catch (e) {
      console.error(e);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchPending();
  }, [user]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold flex items-center gap-2">
          <Clock className="w-4 h-4 text-amber-500" />
          Pending Bookings ({pos.length})
        </h3>
      </div>

      <div className="border rounded-lg overflow-hidden bg-card shadow-sm">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/50">
              <TableHead className="w-[80px]">Season</TableHead>
              <TableHead>TRN No.</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>PO#</TableHead>
              <TableHead>Mode</TableHead>
              <TableHead>Incoterm</TableHead>
              <TableHead>Expected</TableHead>
              <TableHead>Booked</TableHead>
              <TableHead>Remaining</TableHead>
              <TableHead>Warehouse</TableHead>
              <TableHead>ETD</TableHead>
              <TableHead className="text-right">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={10} className="text-center py-10">Loading pending POs...</TableCell></TableRow>
            ) : pos.length === 0 ? (
              <TableRow><TableCell colSpan={10} className="text-center py-12 text-muted-foreground italic">No pending POs found.</TableCell></TableRow>
            ) : (
              pos.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="text-xs font-mono">{p.season || '—'}</TableCell>
                  <TableCell className="text-xs font-mono">{p.trn_number || '—'}</TableCell>
                  <TableCell className="text-xs capitalize">{p.type || 'mainline'}</TableCell>
                  <TableCell className="font-semibold text-sm">{p.po_number}</TableCell>
                  <TableCell className="text-xs">{p.mode || '—'}</TableCell>
                  <TableCell className="text-xs font-bold text-amber-700">{p.incoterm || '—'}</TableCell>
                  <TableCell className="text-sm font-semibold">{p.expected_qty}</TableCell>
                  <TableCell className="text-sm text-blue-600 font-medium">{p.booked_qty || 0}</TableCell>
                  <TableCell className="text-sm text-emerald-600 font-bold">
                    {(parseInt(p.expected_qty) || 0) - (parseInt(p.booked_qty) || 0)}
                  </TableCell>
                  <TableCell className="text-xs">{p.receiving_warehouse}</TableCell>
                  <TableCell className="text-xs">{p.etd}</TableCell>
                  <TableCell className="text-right">
                    <Button size="sm" variant="outline" className="h-8 gap-1 border-primary/30 text-primary hover:bg-primary/5" onClick={() => onBookNow(p)}>
                      Book Now <ArrowRight className="w-3 h-3" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

const statusColors: any = {
  'No Booking': 'bg-gray-100 text-gray-800',
  'Booking': 'bg-amber-100 text-amber-800',
  'Booking Approved': 'bg-blue-100 text-blue-800',
  'Declined': 'bg-red-100 text-red-800',
  'Customs Clearance': 'bg-purple-100 text-purple-800',
  'In-Transit': 'bg-yellow-100 text-yellow-800',
  'ASN Sent': 'bg-emerald-100 text-emerald-800',
  'Delivered': 'bg-green-100 text-green-800',
  'Draft': 'bg-gray-100 text-gray-700',
};

const sopSections = [
  {
    title: 'Booking Approval — Checklist',
    content: (
      <ul className="list-disc list-inside space-y-2 text-xs">
        <li>Verify destination warehouse is correct.</li>
        <li>Mode of transport matches shipment size.</li>
      </ul>
    ),
  }
];

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
  { id: 'submitted_at', label: 'Submitted' }
];

function BookingsList({ user, isHistory = false }: any) {
  const [search, setSearch] = useState('');
  const [filterStatus, setFilterStatus] = useState('All');
  const [bookings, setBookings] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedBooking, setSelectedBooking] = useState<any>(null);

  const [visibleColumns, setVisibleColumns] = useState<string[]>(ALL_COLUMNS.map(c => c.id));

  const fetchBookings = async () => {
    setIsLoading(true);
    try {
      const url = isHistory ? 'http://127.0.0.1:5000/history-bookings' : 'http://127.0.0.1:5000/bookings';
      const res = await fetch(url, { cache: 'no-store' });
      const data = await res.json();
      setBookings(data || []);
    } catch (e) {
      console.error(e);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchBookings();
  }, [isHistory]);

  const handleApprove = async (booking: any) => {
    // 1. Mark the booking as approved (Backend will automatically fan-out shipments)
    await updateBooking(booking.id, { booking_status: 'Booking Approved', approved_at: new Date().toISOString() });
    
    toast.success(`Booking ${booking.booking_number} approved.`);
    fetchBookings();
    setSelectedBooking(null);
  };

  const handleDecline = async (booking: any, reason: string) => {
    await updateBooking(booking.id, { booking_status: 'Declined', decline_reason: reason });
    fetchBookings();
    setSelectedBooking(null);
  };

  const filtered = bookings.filter(b => {
    const matchSearch = !search ||
      b.vendor_name?.toLowerCase().includes(search.toLowerCase()) ||
      b.tentree_po_number?.toLowerCase().includes(search.toLowerCase()) ||
      b.booking_number?.toLowerCase().includes(search.toLowerCase());
    const matchStatus = filterStatus === 'All' || b.booking_status === filterStatus;
    
    // Vendor isolation
    const matchVendor = !user || user.role !== 'Vendor' || b.vendor_name === user.supplier;
    
    return matchSearch && matchStatus && matchVendor;
  });

  const toggleColumn = (id: string) => {
    setVisibleColumns(prev => prev.includes(id) ? prev.filter(c => c !== id) : [...prev, id]);
  };

  const handleExport = (allColumns = false) => {
    if (filtered.length === 0) {
      toast.error('No data to export');
      return;
    }
    const csvData = filtered.map(s => {
      const row: any = {};
      if (allColumns) {
        Object.keys(s).forEach(key => {
          row[key] = s[key] !== null && s[key] !== undefined ? String(s[key]) : '';
        });
      } else {
        const columnsToExport = ALL_COLUMNS.filter(c => visibleColumns.includes(c.id));
        columnsToExport.forEach(col => {
          row[col.label] = s[col.id] !== null && s[col.id] !== undefined ? String(s[col.id]) : '';
        });
      }
      return row;
    });

    const Papa = require('papaparse');
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
              filtered.map(b => (
                <TableRow key={b.id} className="cursor-pointer hover:bg-muted/30 transition-colors" onClick={() => setSelectedBooking(b)}>
                  {ALL_COLUMNS.filter(c => visibleColumns.includes(c.id)).map(col => {
                    if (col.id === 'booking_number') {
                      return <TableCell key={col.id} className="font-mono text-xs font-medium">{b.booking_number || '—'}</TableCell>;
                    }
                    if (col.id === 'vendor_name') {
                      return <TableCell key={col.id} className="text-sm">{b.vendor_name || '—'}</TableCell>;
                    }
                    if (col.id === 'season') {
                      return <TableCell key={col.id} className="text-sm font-mono">{b.season || '—'}</TableCell>;
                    }
                    if (col.id === 'trn_number') {
                      return <TableCell key={col.id} className="text-sm font-mono">{b.trn_number || '—'}</TableCell>;
                    }
                    if (col.id === 'type') {
                      return <TableCell key={col.id} className="text-sm capitalize">{b.type || '—'}</TableCell>;
                    }
                    if (col.id === 'tentree_po_number') {
                      return <TableCell key={col.id} className="text-sm font-medium">{b.tentree_po_number || '—'}</TableCell>;
                    }
                    if (col.id === 'mode') {
                      return <TableCell key={col.id} className="text-sm">{b.mode || '—'}</TableCell>;
                    }
                    if (col.id === 'incoterm') {
                      return <TableCell key={col.id} className="text-sm font-bold text-amber-700">{b.incoterm || '—'}</TableCell>;
                    }
                    if (col.id === 'receiving_warehouse') {
                      return <TableCell key={col.id} className="text-sm">{b.receiving_warehouse || '—'}</TableCell>;
                    }
                    if (col.id === 'number_of_cartons') {
                      return <TableCell key={col.id} className="text-sm">{b.number_of_cartons ?? '—'}</TableCell>;
                    }
                    if (col.id === 'cargo_ready_date') {
                      return (
                        <TableCell key={col.id} className="text-sm">
                          {(() => {
                            try {
                              return b.cargo_ready_date ? format(new Date(b.cargo_ready_date + 'T12:00:00'), 'MMM d, yyyy') : '—';
                            } catch (e) {
                              return b.cargo_ready_date || '—';
                            }
                          })()}
                        </TableCell>
                      );
                    }
                    if (col.id === 'freight_forwarder') {
                      return <TableCell key={col.id} className="text-sm">{b.freight_forwarder || b.courier || '—'}</TableCell>;
                    }
                    if (col.id === 'booking_status') {
                      return (
                        <TableCell key={col.id}>
                          <Badge className={statusColors[b.booking_status] || 'bg-gray-100 text-gray-700'} variant="secondary">
                            {b.booking_status || 'Draft'}
                          </Badge>
                        </TableCell>
                      );
                    }
                    if (col.id === 'submitted_at') {
                      return (
                        <TableCell key={col.id} className="text-sm text-muted-foreground">
                          {b.submitted_at ? format(new Date(b.submitted_at), 'MMM d') : '—'}
                        </TableCell>
                      );
                    }
                    return <TableCell key={col.id}>—</TableCell>;
                  })}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <BookingDetailDrawer
        booking={selectedBooking}
        open={!!selectedBooking}
        onClose={() => setSelectedBooking(null)}
        onApprove={handleApprove}
        onDecline={handleDecline}
        user={user}
        onSuccess={fetchBookings}
      />
    </>
  );
}

export default function Bookings() {
  const [activeTab, setActiveTab] = useState('list');
  const [sopOpen, setSopOpen] = useState(false);
  const [user, setUser] = useState<any>(null);
  const [prefilledPO, setPrefilledPO] = useState<any>(null);

  useEffect(() => {
    function loadUser() {
      try {
        const cookies = document.cookie.split('; ');
        const sessionCookie = cookies.find(row => row.startsWith('session='));
        if (sessionCookie) {
          const value = decodeURIComponent(sessionCookie.split('=')[1]);
          setUser(JSON.parse(value));
        }
      } catch (e) {
        console.error('Failed to parse user session in Bookings page', e);
      }
    }
    loadUser();
  }, []);

  return (
    <div className="flex h-full">
      <div className="flex-1 overflow-y-auto p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-semibold font-inter">Bookings</h1>
          {activeTab === 'list' && (
            <Button onClick={() => setActiveTab('submit')}>
              <Plus className="w-4 h-4 mr-1.5" /> New Booking
            </Button>
          )}
        </div>

        <Tabs value={activeTab} onValueChange={(val) => setActiveTab(val || '')}>
          <TabsList>
            <TabsTrigger value="list">Active Bookings</TabsTrigger>
            <TabsTrigger value="pending" className="relative">
              Pending Bookings
              {user?.role === 'Vendor' && <Badge variant="secondary" className="ml-1.5 h-4 px-1 text-[8px] bg-amber-500 text-white border-0">Action Required</Badge>}
            </TabsTrigger>
            <TabsTrigger value="history">History</TabsTrigger>
            <TabsTrigger value="submit">Submit Booking</TabsTrigger>
            <TabsTrigger value="customs">Customs Line Optimizer</TabsTrigger>
          </TabsList>

          <TabsContent value="pending" className="mt-4">
            <PendingPOsList user={user} onBookNow={(po: any) => {
              setPrefilledPO(po);
              setActiveTab('submit');
            }} />
          </TabsContent>

          <TabsContent value="list" className="mt-4">
            <BookingsList user={user} isHistory={false} />
          </TabsContent>

          <TabsContent value="history" className="mt-4">
            <BookingsList user={user} isHistory={true} />
          </TabsContent>

          <TabsContent value="submit" className="mt-4">
            <BookingForm 
              prefilledPO={prefilledPO}
              onSuccess={() => {
                setPrefilledPO(null);
                setTimeout(() => setActiveTab('list'), 3000);
              }} 
            />
          </TabsContent>

          <TabsContent value="customs" className="mt-4">
            <CustomsPlaceholder />
          </TabsContent>
        </Tabs>
      </div>

      <SopPanel title="Booking SOP" sections={sopSections} isOpen={sopOpen} onToggle={() => setSopOpen(!sopOpen)} />
    </div>
  );
}
