'use client';

import React, { useState, useEffect } from 'react';
import { getShipments, updateShipment, deleteShipment, createShipment } from '../actions/shipments';
import { getPurchaseOrders } from '@/app/actions/purchase-orders';
import { getBookings, updateBooking } from '@/app/actions/bookings';
import { getHistoryShipments, runHistorySweep } from '@/app/actions/history';
import { syncNetSuite } from '@/app/actions/purchase-orders';
import { trackFedexShipment } from '../actions/fedex';
import { useSession } from '@/components/providers/SessionProvider';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Plus, Search, Ship, Plane, Truck, Package, ChevronUp, ChevronDown, ChevronsUpDown, Upload, Download, RefreshCw, Settings2, Check, Archive } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Checkbox } from '@/components/ui/checkbox';
import { format } from 'date-fns';
import { toast } from 'sonner';
import SopPanel from '@/components/layout/SopPanel';

import ShipmentDetailDrawer from '@/components/shipments/ShipmentDetailDrawer';
import SmsDetailDrawer from '@/components/shipments/SmsDetailDrawer';
import ShipmentForm from '@/components/shipments/ShipmentForm';
import SmsShipmentForm from '@/components/shipments/SmsShipmentForm';

// Placeholders for other missing subcomponents
import AsnEmailModal from '@/components/shipments/AsnEmailModal';
import SmsImportModal from '@/components/shipments/SmsImportModal';
const ReceivedQuantityModal = ({ open, onClose }: any) => null;
import { cn } from '@/lib/utils';

const statusColors: any = {
  'No Booking': 'bg-background border border-border text-muted-foreground',
  'Booking': 'bg-muted border border-border text-foreground',
  'Booking Approved': 'bg-secondary border border-border text-secondary-foreground',
  'Customs Clearance': 'bg-background border border-primary/30 text-primary',
  'In-Transit': 'bg-accent border border-border text-accent-foreground',
  'ASN Sent': 'bg-primary/20 border border-primary/40 text-primary-foreground',
  'Delivered': 'bg-primary border border-primary text-primary-foreground',
  'Ready to Ship': 'bg-secondary border border-border text-secondary-foreground',
  'Pending': 'bg-muted border border-border text-foreground',
  'Customs Issue': 'bg-destructive/20 border border-destructive/50 text-destructive-foreground',
};

const mainlineStatuses = ['No Booking', 'Booking', 'Booking Approved', 'Customs Clearance', 'In-Transit', 'Delivered'];
const smsStatuses = ['Ready to Ship', 'Pending', 'In-Transit', 'Customs Issue', 'Delivered'];

const modeIcons: any = { Ocean: Ship, Air: Plane, Courier: Truck, Truck: Truck };
const statuses = ['Shipment Status', ...mainlineStatuses];
const warehouses = ['Warehouse', 'NRI US', 'NRI CAN', 'Direct US', 'Direct CAN'];
const modes = ['Mode', 'Ocean', 'Air', 'Courier'];

const ALL_COLUMNS = [
  { id: 'season', label: 'Season' },
  { id: 'trn_number', label: 'TRN No.' },
  { id: 'po_number', label: 'PO' },
  { id: 'lot_number', label: 'Lot' },
  { id: 'supplier', label: 'Supplier' },
  { id: 'mode', label: 'Mode' },
  { id: 'courier', label: 'Courier' },
  { id: 'incoterm', label: 'Incoterm' },
  { id: 'tracking_number', label: 'Tracking #' },
  { id: 'expected_quantity', label: 'Expected Qty' },
  { id: 'destination_warehouse', label: 'Recv WH' },
  { id: 'etd', label: 'ETD' },
  { id: 'eta', label: 'ETA' },
  { id: 'status', label: 'Status' },
  { id: 'booking', label: 'Booking Status' },
  { id: 'asn', label: 'ASN' },
];

function getTrackingUrl(courier: string, trackingNumber: string) {
  if (!trackingNumber) return null;
  const c = (courier || '').toLowerCase();
  if (c.includes('fedex')) return `https://www.fedex.com/fedextrack/?trknbr=${trackingNumber}`;
  if (c.includes('dhl')) return `https://www.dhl.com/ca-en/home/tracking/tracking-express.html?submit=1&tracking-id=${trackingNumber}`;
  if (c.includes('avion')) return `https://link.cevalogistics.com/Search/Shipment?DynModel.NUM_HAWB=${trackingNumber}`;
  return null;
}

export default function ShipmentsClient({ initialShipments }: { initialShipments: any[] }) {
  const [search, setSearch] = useState('');
  const [filterStatus, setFilterStatus] = useState('All');
  const [filterWarehouse, setFilterWarehouse] = useState('All');
  const [filterMode, setFilterMode] = useState('All');
  const [selectedShipment, setSelectedShipment] = useState(null);
  const [selectedSmsShipment, setSelectedSmsShipment] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [showSmsForm, setShowSmsForm] = useState(false);
  const [editingShipment, setEditingShipment] = useState<any>(null);
  const [editingSmsShipment, setEditingSmsShipment] = useState<any>(null);
  const [showSmsImport, setShowSmsImport] = useState(false);
  const [asnShipment, setAsnShipment] = useState<any>(null);
  const [sopOpen, setSopOpen] = useState(false);
  const [activeTab, setActiveTab] = useState('mainline');
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState('asc');
  const [trackingRows, setTrackingRows] = useState<Record<string, boolean>>({});

  const [shipments, setShipments] = useState<any[]>(initialShipments);
  const { user } = useSession();
  const [isLoading, setIsLoading] = useState(false);

  // Column Visibility State
  const [visibleColumns, setVisibleColumns] = useState<string[]>([]);

  useEffect(() => {
    // Keep local state in sync with server props
    if (activeTab !== 'history') {
      setShipments(initialShipments);
    } else {
      fetchShipments();
    }
  }, [activeTab, initialShipments]);

  useEffect(() => {
    // Load column preferences
    const saved = localStorage.getItem('visible_columns');
    if (saved) {
      setVisibleColumns(JSON.parse(saved));
    } else {
      // Default columns
      setVisibleColumns(ALL_COLUMNS.map(c => c.id));
    }
  }, []);

  // PERMISSIONS
  const isAdminOrLogistics = ['Admin', 'Logistics Coordinator'].includes(user?.role || '');
  const isProduction = user?.role === 'Production';
  const isVendor = user?.role === 'Vendor';

  const canDelete = isAdminOrLogistics;
  const canImportExport = isAdminOrLogistics;
  const canCreateMainline = isAdminOrLogistics || isVendor;
  const canCreateSms = isAdminOrLogistics || isProduction;
  const canUpdateStatus = isAdminOrLogistics || isProduction;

  const toggleColumn = (id: string) => {
    setVisibleColumns(prev => {
      const next = prev.includes(id)
        ? prev.filter(c => c !== id)
        : [...prev, id];
      localStorage.setItem('visible_columns', JSON.stringify(next));
      return next;
    });
  };

  const fetchShipments = async () => {
    setIsLoading(true);
    try {
      if (activeTab === 'history') {
        const data = await getHistoryShipments();
        setShipments(Array.isArray(data) ? data : []);
      } else {
        // Mainline shipments are passed from RSC props and handled by Next.js revalidatePath
        // We do not need to fetch or merge here
      }
    } catch (e) {
      console.error(e);
      if (activeTab === 'history') setShipments([]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSyncNetSuite = async () => {
    toast.loading("Syncing with NetSuite...", { id: 'netsuite' });
    try {
      await syncNetSuite();
      toast.success("Successfully synced POs from NetSuite!", { id: 'netsuite' });
    } catch (e) {
      toast.error("Failed to sync NetSuite", { id: 'netsuite' });
    }
  };

  const handleSort = (key: string) => {
    if (sortKey === key) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  };

  const applyFilters = (list: any[]) => {
    return list.filter(s => {
      const matchesSearch = !search ||
        s.po_number?.toLowerCase().includes(search.toLowerCase()) ||
        s.supplier?.toLowerCase().includes(search.toLowerCase()) ||
        s.trn_number?.toLowerCase().includes(search.toLowerCase());

      const matchesStatus = filterStatus === 'All' || s.status === filterStatus;
      const matchesWarehouse = filterWarehouse === 'All' || s.destination_warehouse === filterWarehouse;
      const matchesMode = filterMode === 'All' || s.mode === filterMode;

      // Vendor isolation
      const matchesVendor = !user || user.role !== 'Vendor' || s.supplier === user.supplier;

      return matchesSearch && matchesStatus && matchesWarehouse && matchesMode && matchesVendor;
    });
  };

  const applySorting = (list: any[]) => {
    if (!sortKey) return list;
    return [...list].sort((a, b) => {
      const valA = a[sortKey] || '';
      const valB = b[sortKey] || '';
      if (valA < valB) return sortDir === 'asc' ? -1 : 1;
      if (valA > valB) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });
  };

  const mapShipmentStatusToBookingStatus = (status: string): string => {
    const map: Record<string, string> = {
      'Booking Approved': 'Booking Approved',
      'Customs Clearance': 'Customs Clearance',
      'In-Transit': 'In-Transit',
      'Delivered': 'Delivered',
    };
    return map[status] || status;
  };

  const handleUpdateGroupStatus = async (group: any[], newStatus: string) => {
    toast.loading(`Updating status for booking ${group[0].booking_number || 'shipment'}...`, { id: 'status-update' });
    try {
      // 1. Update every shipment row in the group
      await Promise.all(
        group.map(row => updateShipment(row.id, { ...row, status: newStatus }))
      );

      // 2. Sync back to the parent booking
      const bookingNumber = group[0].booking_number;
      if (bookingNumber) {
        const bookings = await getBookings() || [];
        const linked = bookings.find((b: any) => b.booking_number === bookingNumber);
        if (linked) {
          const bookingStatus = mapShipmentStatusToBookingStatus(newStatus);
          await updateBooking(linked.id, { ...linked, booking_status: bookingStatus, shipment_status: newStatus });
        }
      }
      toast.success("Status updated and synced with booking.", { id: 'status-update' });
      fetchShipments();
    } catch (e) {
      console.error('Failed to update group status', e);
      toast.error("Failed to update status", { id: 'status-update' });
    }
  };

  const handleUpdateStatus = async (shipment: any, newStatus: string) => {
    await updateShipment(shipment.id, { ...shipment, status: newStatus });
    if (shipment.booking_number) {
      try {
        const bookings = await getBookings() || [];
        const linkedBooking = bookings.find((b: any) => b.booking_number === shipment.booking_number);
        if (linkedBooking) {
          await updateBooking(linkedBooking.id, { ...linkedBooking, shipment_status: newStatus, booking_status: mapShipmentStatusToBookingStatus(newStatus) });
        }
      } catch (e) { console.error('Failed to sync booking', e); }
    }
    fetchShipments();
  };

  const handleTrackRow = async (e: any, shipment: any) => {
    e.stopPropagation();
    if (!shipment.tracking_number) return;

    setTrackingRows(prev => ({ ...prev, [shipment.id]: true }));
    try {
      const result = await trackFedexShipment(shipment.tracking_number);
      if (result.error) {
        toast.error(result.error);
      } else {
        toast.success(`Tracked ${shipment.po_number}: ${result.status}`);
        if (result.eta) {
          await updateShipment(shipment.id, { eta: result.eta });
          fetchShipments();
        }
      }
    } catch (err) {
      console.error(err);
      toast.error('Failed to track shipment.');
    } finally {
      setTrackingRows(prev => ({ ...prev, [shipment.id]: false }));
    }
  };

  const handleExport = (allColumns = false) => {
    const list = activeTab === 'sms' ? smsShipments : (activeTab === 'history' ? shipments : mainlineShipments);
    if (list.length === 0) {
      toast.error('No data to export');
      return;
    }

    const csvData = list.map(s => {
      const row: any = {};
      if (allColumns) {
        Object.keys(s).forEach(key => {
          row[key] = s[key] !== null && s[key] !== undefined ? String(s[key]) : '';
        });
      } else {
        const columnsToExport = ALL_COLUMNS.filter(c => visibleColumns.includes(c.id) && !['booking'].includes(c.id));
        columnsToExport.forEach(col => {
          row[col.label] = s[col.id] !== null && s[col.id] !== undefined ? String(s[col.id]) : '';
        });
      }
      return row;
    });

    // Use PapaParse to generate CSV
    const Papa = require('papaparse');
    const csv = Papa.unparse(csvData);

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `tentree_shipments_${activeTab}_${format(new Date(), 'yyyy-MM-dd')}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    toast.success(`Exported ${list.length} shipments to CSV`);
  };

  const smsShipments = applySorting(applyFilters(shipments.filter(s =>
    (s.type === 'sms' || s.type === 'SMS') && !s.archived
  )));
  const mainlineShipments = applySorting(applyFilters(shipments.filter(s =>
    (s.type === 'mainline' || !s.type) && !s.archived
  )));

  // Grouping logic for Mainline
  const groupedMainline: any[][] = [];
  const processedBookingNumbers = new Set<string>();

  mainlineShipments.forEach(s => {
    if (s.booking_number) {
      if (!processedBookingNumbers.has(s.booking_number)) {
        const group = mainlineShipments.filter(item => item.booking_number === s.booking_number);
        groupedMainline.push(group);
        processedBookingNumbers.add(s.booking_number);
      }
    } else {
      groupedMainline.push([s]);
    }
  });

  return (
    <div className="flex h-full">
      <div className="flex-1 overflow-y-auto p-6 space-y-4">
        {/* Filters and Column Selector */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[200px] max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input placeholder="Search by PO, TRN or Supplier..." className="pl-9" value={search} onChange={(e: any) => setSearch(e.target.value)} />
          </div>
          <Select value={filterStatus} onValueChange={(val) => setFilterStatus(val || 'All')}>
            <SelectTrigger className="w-40"><SelectValue placeholder="Status" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="All">All Statuses</SelectItem>
              {statuses.filter(s => s !== 'Shipement Status').map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={filterWarehouse} onValueChange={(val) => setFilterWarehouse(val || 'All')}>
            <SelectTrigger className="w-36"><SelectValue placeholder="Warehouse" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="All">All Warehouses</SelectItem>
              {warehouses.filter(w => w !== 'Warehouse').map(w => <SelectItem key={w} value={w}>{w}</SelectItem>)}
            </SelectContent>
          </Select>

          <div className="flex items-center gap-3">
            <Button variant="outline" className="h-10 border-primary/20 hover:bg-primary/5" onClick={handleSyncNetSuite}>
              <RefreshCw className="w-4 h-4 mr-2" />
              NetSuite Sync
            </Button>
            {canImportExport && (
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" className="h-10 border-primary/20 hover:bg-primary/5 gap-2">
                    <Download className="w-4 h-4" />
                    Export
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-48 p-2" align="start">
                  <div className="flex flex-col gap-1">
                    <Button variant="ghost" size="sm" className="justify-start font-medium" onClick={() => handleExport(false)}>
                      Export Current View
                    </Button>
                    <Button variant="ghost" size="sm" className="justify-start font-medium" onClick={() => handleExport(true)}>
                      Export All Fields
                    </Button>
                  </div>
                </PopoverContent>
              </Popover>
            )}
          </div>

          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline" size="sm" className="h-10 gap-2 border-dashed">
                <Settings2 className="w-4 h-4" />
                Columns
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-56 p-2" align="start">
              <div className="space-y-1">
                <h4 className="text-xs font-bold px-2 py-1.5 uppercase text-muted-foreground tracking-wider">Display Fields</h4>
                <div className="max-h-[300px] overflow-y-auto">
                  {ALL_COLUMNS.map(col => (
                    <div
                      key={col.id}
                      className="flex items-center gap-2 px-2 py-1.5 hover:bg-muted rounded-md cursor-pointer transition-colors"
                      onClick={() => toggleColumn(col.id)}
                    >
                      <div className={cn(
                        "w-4 h-4 rounded border border-primary flex items-center justify-center transition-colors",
                        visibleColumns.includes(col.id) ? "bg-primary border-primary" : "bg-transparent border-input"
                      )}>
                        {visibleColumns.includes(col.id) && <Check className="w-3 h-3 text-white" />}
                      </div>
                      <span className="text-sm font-medium">{col.label}</span>
                    </div>
                  ))}
                </div>
              </div>
            </PopoverContent>
          </Popover>

          <div className="ml-auto flex gap-2">
            {activeTab === 'sms' && canCreateSms && (
              <>
                {canImportExport && (
                  <Button variant="outline" onClick={() => setShowSmsImport(true)}>
                    <Upload className="w-4 h-4 mr-1.5" /> Import
                  </Button>
                )}
                <Button variant="outline" onClick={() => { setEditingSmsShipment(null); setShowSmsForm(true); }}>
                  <Plus className="w-4 h-4 mr-1.5" /> New SMS
                </Button>
              </>
            )}
            {activeTab === 'mainline' && canCreateMainline && (
              <>
                <Button onClick={() => { setEditingShipment(null); setShowForm(true); }}>
                  <Plus className="w-4 h-4 mr-1.5" /> New Mainline
                </Button>
              </>
            )}
            {activeTab === 'history' && isAdminOrLogistics && (
              <Button variant="outline" className="text-primary border-primary hover:bg-primary/10" onClick={async () => {
                toast.loading('Running history sweep...', { id: 'sweep' });
                try {
                  const data = await runHistorySweep();
                  toast.success(`Sweep complete! Archived ${data.count} shipments.`, { id: 'sweep' });
                  fetchShipments();
                } catch (e) {
                  toast.error('Sweep failed', { id: 'sweep' });
                }
              }}>
                <Archive className="w-4 h-4 mr-1.5" /> Force Sweep
              </Button>
            )}
          </div>
        </div>

        {/* Tabs */}
        <Tabs value={activeTab} onValueChange={(val) => setActiveTab(val || 'mainline')}>
          <TabsList className="bg-muted/30 h-10 p-1 rounded-lg inline-flex items-center">
            <TabsTrigger value="mainline" className="px-6 h-8 rounded-md data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-sm transition-all font-medium">
              Mainline Tracker
            </TabsTrigger>
            <TabsTrigger value="sms" className="px-6 h-8 rounded-md data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-sm transition-all font-medium">
              SMS Tracker
            </TabsTrigger>
            <TabsTrigger value="history" className="px-6 h-8 rounded-md data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-sm transition-all font-medium">
              History
            </TabsTrigger>
          </TabsList>

          {['mainline', 'sms', 'history'].map(tab => {
            const list = tab === 'sms' ? smsShipments : (tab === 'history' ? shipments : mainlineShipments);
            return (
              <TabsContent key={tab} value={tab} className="mt-4">
                <div className="bg-card rounded-xl border border-border overflow-hidden shadow-sm">
                  <Table>
                    <TableHeader>
                      <TableRow className="bg-muted/50 hover:bg-muted/50">
                        {ALL_COLUMNS.filter(col => visibleColumns.includes(col.id)).map(({ label, id }) => (
                          <TableHead
                            key={id}
                            className={cn(
                              "font-semibold h-11",
                              !['booking'].includes(id) && "cursor-pointer select-none hover:bg-muted transition-colors"
                            )}
                            onClick={() => !['booking'].includes(id) && handleSort(id)}
                          >
                            <div className="flex items-center gap-1.5">
                              {label}
                              {!['booking'].includes(id) && (
                                sortKey === id
                                  ? sortDir === 'asc'
                                    ? <ChevronUp className="w-3.5 h-3.5 text-primary" />
                                    : <ChevronDown className="w-3.5 h-3.5 text-primary" />
                                  : <ChevronsUpDown className="w-3 h-3 text-muted-foreground/30" />
                              )}
                            </div>
                          </TableHead>
                        ))}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {isLoading ? (
                        <TableRow><TableCell colSpan={visibleColumns.length} className="text-center py-12 text-muted-foreground"><RefreshCw className="w-6 h-6 animate-spin mx-auto mb-2 opacity-20" />Loading shipments...</TableCell></TableRow>
                      ) : (tab === 'mainline' ? groupedMainline : (tab === 'sms' ? smsShipments.map(s => [s]) : list.map(s => [s]))).length === 0 ? (
                        <TableRow><TableCell colSpan={visibleColumns.length} className="text-center py-12 text-muted-foreground font-medium italic">No shipments match your current filters.</TableCell></TableRow>
                      ) : (
                        (tab === 'mainline' ? groupedMainline : (tab === 'sms' ? smsShipments.map(s => [s]) : list.map(s => [s]))).map((group: any[]) => (
                          group.map((s, rowIndex) => {
                            const ModeIcon = modeIcons[s.mode] || Package;
                            const trackingUrl = getTrackingUrl(s.courier, s.tracking_number);
                            const isSms = tab === 'sms';
                            const statusOptions = isSms ? smsStatuses : mainlineStatuses;

                            return (
                              <TableRow key={s.id} className="cursor-pointer hover:bg-muted/30 transition-colors group" onClick={() => isSms ? setSelectedSmsShipment(s) : setSelectedShipment(s)}>
                                {visibleColumns.includes('season') && <TableCell className="text-xs font-mono py-3">{s.season || '—'}</TableCell>}
                                {visibleColumns.includes('trn_number') && <TableCell className="text-xs font-mono py-3">{s.trn_number || '—'}</TableCell>}
                                {visibleColumns.includes('po_number') && <TableCell className="font-semibold text-sm py-3">{s.po_number}</TableCell>}
                                {visibleColumns.includes('lot_number') && <TableCell className="text-sm py-3">{s.lot_number ? `Lot ${s.lot_number}` : '—'}</TableCell>}
                                {visibleColumns.includes('supplier') && <TableCell className="text-sm py-3">{s.supplier}</TableCell>}
                                {visibleColumns.includes('mode') && (
                                  <TableCell className="py-3">
                                    <div className="flex items-center gap-2">
                                      <ModeIcon className="w-3.5 h-3.5 text-muted-foreground" />
                                      <span className="text-sm">{s.mode}</span>
                                    </div>
                                  </TableCell>
                                )}
                                {visibleColumns.includes('courier') && <TableCell className="text-sm py-3">{s.courier || '—'}</TableCell>}
                                {visibleColumns.includes('incoterm') && <TableCell className="text-sm py-3 font-medium text-amber-700">{s.incoterm || '—'}</TableCell>}
                                {visibleColumns.includes('tracking_number') && (
                                  <TableCell className="text-xs font-mono py-3" onClick={(e: any) => trackingUrl && e.stopPropagation()}>
                                    {trackingUrl ? (
                                      <a href={trackingUrl} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline font-medium underline-offset-4 decoration-primary/30">{s.tracking_number}</a>
                                    ) : (s.tracking_number || '—')}
                                  </TableCell>
                                )}
                                {visibleColumns.includes('expected_quantity') && <TableCell className="text-sm font-semibold text-blue-600/80 py-3">{s.expected_quantity || '—'}</TableCell>}
                                {visibleColumns.includes('destination_warehouse') && <TableCell className="text-sm py-3">{s.destination_warehouse}</TableCell>}
                                {visibleColumns.includes('etd') && (
                                  <TableCell className="text-sm py-3">
                                    {(() => {
                                      try {
                                        return s.etd ? format(new Date(s.etd + 'T12:00:00'), 'MMM d') : '—';
                                      } catch (e) {
                                        return s.etd || '—';
                                      }
                                    })()}
                                  </TableCell>
                                )}
                                {visibleColumns.includes('eta') && (
                                  <TableCell className="text-sm py-3">
                                    {(() => {
                                      try {
                                        return s.eta ? format(new Date(s.eta + 'T12:00:00'), 'MMM d') : '—';
                                      } catch (e) {
                                        return s.eta || '—';
                                      }
                                    })()}
                                  </TableCell>
                                )}
                                {visibleColumns.includes('status') && (
                                  rowIndex === 0 || tab !== 'mainline' ? (
                                    <TableCell
                                      className="py-3"
                                      onClick={(e: any) => e.stopPropagation()}
                                      rowSpan={tab === 'mainline' && s.booking_number ? group.length : 1}
                                    >
                                      {canUpdateStatus ? (
                                        <Select
                                          value={s.status}
                                          onValueChange={(val) => tab === 'mainline' && s.booking_number ? handleUpdateGroupStatus(group, val) : handleUpdateStatus(s, val)}
                                        >
                                          <SelectTrigger className={cn("h-7 w-fit text-[11px] font-bold px-3 py-0 rounded-full transition-all shadow-none", statusColors[s.status] || 'bg-background border-border text-foreground')}>
                                            <SelectValue />
                                          </SelectTrigger>
                                          <SelectContent>
                                            {statusOptions.map(st => <SelectItem key={st} value={st} className="text-xs font-medium">{st}</SelectItem>)}
                                          </SelectContent>
                                        </Select>
                                      ) : (
                                        <Badge variant="outline" className={cn("h-7 text-[11px] font-bold px-3 py-0 rounded-full transition-all shadow-none", statusColors[s.status] || 'bg-background border-border text-foreground')}>
                                          {s.status}
                                        </Badge>
                                      )}
                                    </TableCell>
                                  ) : null
                                )}
                                {visibleColumns.includes('booking') && (
                                  rowIndex === 0 || tab !== 'mainline' ? (
                                    <TableCell
                                      className="py-3"
                                      rowSpan={tab === 'mainline' && s.booking_number ? group.length : 1}
                                    >
                                      <div className="flex flex-col gap-1.5 items-start">
                                        <span className="text-xs font-mono text-primary/80">{s.booking_number || '—'}</span>
                                        <Badge variant="outline" className={cn("h-5 text-[10px] uppercase font-bold", ['Booking Approved', 'Customs Clearance', 'In-Transit', 'Delivered'].includes(s.booking_status) ? "bg-primary/10 text-primary border-primary/30" : "bg-background text-muted-foreground border-border")}>
                                          {s.booking_status || 'No Booking'}
                                        </Badge>
                                      </div>
                                    </TableCell>
                                  ) : null
                                )}
                                {visibleColumns.includes('asn') && (
                                  <TableCell className="py-3" onClick={(e: any) => e.stopPropagation()}>
                                    {!s.asn_sent ? (
                                      <Button
                                        size="sm"
                                        variant="outline"
                                        onClick={() => setAsnShipment(s)}
                                        className="h-7 text-xs border-primary text-primary hover:bg-primary/10"
                                      >
                                        Send ASN
                                      </Button>
                                    ) : (
                                      <Badge variant="outline" className="h-6 text-[10px] bg-primary/20 text-primary-foreground border-primary/40 uppercase font-bold">
                                        ASN Sent
                                      </Badge>
                                    )}
                                  </TableCell>
                                )}
                              </TableRow>
                            );
                          })
                        ))
                      )}
                    </TableBody>
                  </Table>
                </div>
              </TabsContent>
            );
          })}
        </Tabs>
      </div>

      {/* Right SOP Sidebar */}
      <SopPanel
        title={activeTab === 'sms' ? 'SMS Tracking SOP' : 'Mainline Shipping SOP'}
        isOpen={sopOpen}
        onToggle={() => setSopOpen(!sopOpen)}
      />

      {/* Drawers and Modals */}
      <ShipmentDetailDrawer
        open={selectedShipment}
        onClose={() => setSelectedShipment(null)}
        onSuccess={fetchShipments}
        onSendAsn={(s: any) => setAsnShipment(s)}
        user={user}
      />

      <SmsDetailDrawer
        open={selectedSmsShipment}
        onClose={() => setSelectedSmsShipment(null)}
        onSuccess={fetchShipments}
        onSendAsn={(s: any) => setAsnShipment(s)}
        onNewShipment={() => { setEditingSmsShipment(null); setShowSmsForm(true); }}
        user={user}
      />



      <ShipmentForm
        open={showForm}
        onClose={() => setShowForm(false)}
        onSuccess={fetchShipments}
        initialData={editingShipment}
      />

      <SmsShipmentForm
        open={showSmsForm}
        onClose={() => setShowSmsForm(false)}
        onSuccess={fetchShipments}
        initialData={editingSmsShipment}
      />

      <SmsImportModal
        open={showSmsImport}
        onClose={() => setShowSmsImport(false)}
        onSuccess={fetchShipments}
      />

      <AsnEmailModal
        open={asnShipment}
        onClose={() => setAsnShipment(null)}
        onSuccess={fetchShipments}
        shipment={asnShipment}
      />
    </div>
  );
}
