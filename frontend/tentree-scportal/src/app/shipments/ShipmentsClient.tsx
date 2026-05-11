'use client';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import { getShipments, updateShipment, deleteShipment, createShipment, getShipmentLineItems } from '../actions/shipments';
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
import { Plus, Search, Ship, Plane, Truck, Package, ChevronUp, ChevronDown, ChevronsUpDown, ChevronRight, Upload, Download, RefreshCw, Settings2, Check, Archive } from 'lucide-react';
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
import BookingDetailDrawer from '@/components/bookings/BookingDetailDrawer';

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
  'In-Transit': 'bg-yellow-400 border border-yellow-500 text-yellow-950',
  'ASN Sent': 'bg-primary/20 border border-primary/40 text-primary-foreground',
  'Delivered': 'bg-blue-500/20 border border-blue-500/50 text-blue-600',
  'Ready to Ship': 'bg-green-500 border border-green-600 text-white',
  'Pending': 'bg-orange-500 border border-orange-600 text-white',
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
  { id: 'booked_qty', label: 'Booked Qty' },
  { id: 'expected_quantity', label: 'Expected Qty' },
  { id: 'destination_warehouse', label: 'Recv WH' },
  { id: 'etd', label: 'ETD' },
  { id: 'eta', label: 'ETA' },
  { id: 'status', label: 'Status' },
  { id: 'booking', label: 'Booking #' },
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
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  const [lineItemsCache, setLineItemsCache] = useState<Record<string, any[]>>({});
  const [allBookings, setAllBookings] = useState<any[]>([]);
  const [selectedBooking, setSelectedBooking] = useState<any>(null);

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

  const toggleGroup = (bookingNumber: string) => {
    setExpandedGroups(prev => {
      const next = new Set(prev);
      if (next.has(bookingNumber)) next.delete(bookingNumber);
      else next.add(bookingNumber);
      return next;
    });
  };

  const toggleRow = async (shipmentId: string) => {
    setExpandedRows(prev => {
      const next = new Set(prev);
      if (next.has(shipmentId)) {
        next.delete(shipmentId);
      } else {
        next.add(shipmentId);
        if (!lineItemsCache[shipmentId]) {
          getShipmentLineItems(shipmentId)
            .then(items => setLineItemsCache(c => ({ ...c, [shipmentId]: items })))
            .catch(() => setLineItemsCache(c => ({ ...c, [shipmentId]: [] })));
        }
      }
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
        // Re-fetch live shipment + PO data and merge (same logic as page.tsx RSC)
        const [shipmentData, poData, bookingData] = await Promise.all([
          getShipments(),
          getPurchaseOrders(),
          getBookings(),
        ]);
        setAllBookings(bookingData || []);
        const activeShipments = shipmentData || [];
        const activePOs = poData || [];
        const merged: any[] = [];
        const processedShipmentIds = new Set<string>();

        activePOs.forEach((po: any) => {
          const linked = activeShipments.filter((s: any) => s.po_number === po.po_number);
          const poExpected = parseInt(po.expected_qty || '0', 10);
          const totalExpectedInLots = linked.reduce((sum: number, s: any) => sum + (parseInt(s.expected_quantity || '0', 10)), 0);

          if (linked.length > 0) {
            linked.forEach((s: any) => {
              merged.push({
                ...po, ...s,
                expected_quantity: s.expected_quantity || po.expected_qty || '',
                destination_warehouse: s.destination_warehouse || po.receiving_warehouse || '',
                courier: s.courier || po.courier || '',
                type: s.type || po.type || (s.mode === 'Courier' ? 'sms' : 'mainline'),
              });
              processedShipmentIds.add(s.id);
            });
            if (totalExpectedInLots < poExpected) {
              merged.push({
                ...po,
                id: `po-${po.id}-unassigned`,
                status: 'No Booking',
                booking_status: 'No Booking',
                booking_number: '',
                expected_quantity: poExpected - totalExpectedInLots,
                destination_warehouse: po.receiving_warehouse || '',
                courier: po.courier || '',
                type: po.type || (po.mode === 'Courier' ? 'sms' : 'mainline'),
              });
            }
          } else {
            merged.push({
              ...po,
              id: `po-${po.id}`,
              status: 'No Booking',
              booking_status: po.booking_status || 'No Booking',
              booking_number: '',
              expected_quantity: po.expected_qty || '',
              destination_warehouse: po.receiving_warehouse || '',
              courier: po.courier || '',
              type: po.type || (po.mode === 'Courier' ? 'sms' : 'mainline'),
            });
          }
        });

        activeShipments.forEach((s: any) => {
          if (!processedShipmentIds.has(s.id)) {
            merged.push({ ...s, type: s.type || (s.mode === 'Courier' ? 'sms' : 'mainline') });
          }
        });

        setShipments(merged);
      }
    } catch {
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
    } catch {
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
      } catch { /* sync failure is non-critical */ }
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
    } catch {
      toast.error('Failed to track shipment.');
    } finally {
      setTrackingRows(prev => ({ ...prev, [shipment.id]: false }));
    }
  };

  const handleExport = (allColumns = false) => {
    const list = activeTab === 'sms' ? smsShipments : (activeTab === 'history' ? historyShipments : mainlineShipments);
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
  const historyShipments = applySorting(applyFilters(shipments));

  // Grouping logic for Mainline — group by po_number when multiple lots exist
  const groupedMainline: any[][] = [];
  const processedKeys = new Set<string>();

  mainlineShipments.forEach(s => {
    // First try grouping by booking_number (multi-PO bookings)
    if (s.booking_number) {
      if (!processedKeys.has(`bkg:${s.booking_number}`)) {
        const group = mainlineShipments.filter(item => item.booking_number === s.booking_number);
        groupedMainline.push(group);
        processedKeys.add(`bkg:${s.booking_number}`);
        // Also mark individual po_numbers as processed
        group.forEach(item => { if (item.po_number) processedKeys.add(`po:${item.po_number}`); });
      }
    } else if (s.po_number && !processedKeys.has(`po:${s.po_number}`)) {
      // Group by po_number for lot splits without booking
      const group = mainlineShipments.filter(item => !item.booking_number && item.po_number === s.po_number);
      groupedMainline.push(group);
      processedKeys.add(`po:${s.po_number}`);
    } else if (!s.po_number && !s.booking_number) {
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
            const list = tab === 'sms' ? smsShipments : (tab === 'history' ? historyShipments : mainlineShipments);
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
                        (tab === 'mainline' ? groupedMainline : (tab === 'sms' ? smsShipments.map((s: any) => [s]) : list.map((s: any) => [s]))).map((group: any[], index: number) => {
                          const first = group[0];
                          const bookingNumber = first.booking_number;
                          // Multi-PO: mainline group with 2+ POs sharing a booking number
                          const isMultiPO = tab === 'mainline' && group.length > 1 && !!bookingNumber;
                          const isExpanded = isMultiPO && expandedGroups.has(bookingNumber);
                          const isVirtualRow = String(first.id).startsWith('po-');
                          const isSms = tab === 'sms';
                          const statusOptions = isSms ? smsStatuses : mainlineStatuses;
                          const ModeIcon = modeIcons[first.mode] || Package;
                          const trackingUrl = getTrackingUrl(first.courier, first.tracking_number);
                          const totalQty = isMultiPO
                            ? group.reduce((sum: number, s: any) => sum + (parseInt(s.expected_quantity || '0') || 0), 0)
                            : null;

                          return (
                            <React.Fragment key={`${first.id || bookingNumber || 'row'}-${index}`}>
                              {/* ── Primary row (one per booking group) ── */}
                              <TableRow
                                className={cn(
                                  "transition-colors group",
                                  isVirtualRow ? "opacity-60" : "cursor-pointer hover:bg-primary/10",
                                  isExpanded && "bg-muted/20 border-b-0"
                                )}
                                onClick={() => {
                                  if (isVirtualRow) return;
                                  if (isMultiPO) {
                                    const booking = allBookings.find((b: any) => b.booking_number === bookingNumber);
                                    setSelectedBooking(booking || null);
                                  } else if (isSms) {
                                    setSelectedSmsShipment(first);
                                  } else {
                                    setSelectedShipment(first);
                                  }
                                }}
                              >
                                {visibleColumns.includes('season') && <TableCell className="text-xs font-mono py-3">{first.season || '—'}</TableCell>}
                                {visibleColumns.includes('trn_number') && <TableCell className="text-xs font-mono py-3">{first.trn_number || '—'}</TableCell>}
                                {visibleColumns.includes('po_number') && (
                                  <TableCell className="font-semibold text-sm py-3">
                                    <div className="flex items-center gap-1.5">
                                      {isMultiPO ? (
                                        <button
                                          onClick={(e) => { e.stopPropagation(); toggleGroup(bookingNumber); }}
                                          className="flex-shrink-0 w-5 h-5 flex items-center justify-center rounded text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors"
                                        >
                                          {isExpanded
                                            ? <ChevronDown className="w-3.5 h-3.5" />
                                            : <ChevronRight className="w-3.5 h-3.5" />
                                          }
                                        </button>
                                      ) : !isVirtualRow && Array.isArray(first.line_items) && first.line_items.length > 0 && (
                                        <button
                                          onClick={(e) => { e.stopPropagation(); toggleRow(first.id); }}
                                          className="flex-shrink-0 w-5 h-5 flex items-center justify-center rounded text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors"
                                        >
                                          {expandedRows.has(first.id)
                                            ? <ChevronDown className="w-3.5 h-3.5" />
                                            : <ChevronRight className="w-3.5 h-3.5" />
                                          }
                                        </button>
                                      )}
                                      {isMultiPO ? (
                                        <span className="text-xs font-semibold text-muted-foreground">
                                          {group.length} POs
                                          <span className="ml-1.5 font-normal opacity-60 font-mono hidden lg:inline">
                                            {group.map((s: any) => s.po_number).filter(Boolean).join(', ')}
                                          </span>
                                        </span>
                                      ) : (
                                        <span>{first.po_number}</span>
                                      )}
                                    </div>
                                  </TableCell>
                                )}
                                {visibleColumns.includes('lot_number') && (
                                  <TableCell className="py-3">
                                    {isMultiPO ? '—' : (
                                      !isVirtualRow && first.booking_number ? (
                                        first.lot_number != null ? (
                                          <Badge variant="outline" className="text-[10px] font-bold px-2 py-0.5 bg-amber-500/10 border-amber-500/30 text-amber-700">
                                            Lot {first.lot_number}
                                          </Badge>
                                        ) : (
                                          <Badge variant="outline" className="text-[10px] font-bold px-2 py-0.5 bg-emerald-500/10 border-emerald-500/30 text-emerald-700">
                                            Full
                                          </Badge>
                                        )
                                      ) : '—'
                                    )}
                                  </TableCell>
                                )}
                                {visibleColumns.includes('supplier') && <TableCell className="text-sm py-3">{first.supplier}</TableCell>}
                                {visibleColumns.includes('mode') && (
                                  <TableCell className="py-3">
                                    <div className="flex items-center gap-2">
                                      <ModeIcon className="w-3.5 h-3.5 text-muted-foreground" />
                                      <span className="text-sm">{first.mode}</span>
                                    </div>
                                  </TableCell>
                                )}
                                {visibleColumns.includes('courier') && <TableCell className="text-sm py-3">{first.courier || '—'}</TableCell>}
                                {visibleColumns.includes('incoterm') && <TableCell className="text-sm py-3 font-medium text-amber-700">{first.incoterm || '—'}</TableCell>}
                                {visibleColumns.includes('tracking_number') && (
                                  <TableCell className="text-xs font-mono py-3" onClick={(e: any) => trackingUrl && e.stopPropagation()}>
                                    {trackingUrl ? (
                                      <a href={trackingUrl} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline font-medium underline-offset-4 decoration-primary/30">{first.tracking_number}</a>
                                    ) : (first.tracking_number || '—')}
                                  </TableCell>
                                )}
                                {visibleColumns.includes('booked_qty') && (
                                  <TableCell className="text-sm font-semibold py-3 tabular-nums">
                                    {isMultiPO
                                      ? group.reduce((sum: number, s: any) => sum + (parseInt(s.booked_qty || s.expected_quantity || '0') || 0), 0).toLocaleString()
                                      : (first.booked_qty ? Number(first.booked_qty).toLocaleString() : '—')}
                                  </TableCell>
                                )}
                                {visibleColumns.includes('expected_quantity') && (
                                  <TableCell className="text-sm font-semibold text-blue-600/80 py-3">
                                    {isMultiPO ? totalQty!.toLocaleString() : (first.expected_quantity || '—')}
                                  </TableCell>
                                )}
                                {visibleColumns.includes('destination_warehouse') && <TableCell className="text-sm py-3">{first.destination_warehouse}</TableCell>}
                                {visibleColumns.includes('etd') && (
                                  <TableCell className="text-sm py-3">
                                    {(() => { try { return first.etd ? format(new Date(first.etd + 'T12:00:00'), 'MMM d') : '—'; } catch { return first.etd || '—'; } })()}
                                  </TableCell>
                                )}
                                {visibleColumns.includes('eta') && (
                                  <TableCell className="text-sm py-3">
                                    {(() => { try { return first.eta ? format(new Date(first.eta + 'T12:00:00'), 'MMM d') : '—'; } catch { return first.eta || '—'; } })()}
                                  </TableCell>
                                )}
                                {visibleColumns.includes('status') && (
                                  <TableCell className="py-3" onClick={(e: any) => e.stopPropagation()}>
                                    {canUpdateStatus && !isVirtualRow ? (
                                      <Select
                                        value={first.status}
                                        onValueChange={(val) => isMultiPO ? handleUpdateGroupStatus(group, val) : handleUpdateStatus(first, val)}
                                      >
                                        <SelectTrigger className={cn("h-7 w-fit text-[11px] font-bold px-3 py-0 rounded-full transition-all shadow-none", statusColors[first.status] || 'bg-background border-border text-foreground')}>
                                          <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                          {statusOptions.map(st => <SelectItem key={st} value={st} className="text-xs font-medium">{st}</SelectItem>)}
                                        </SelectContent>
                                      </Select>
                                    ) : (
                                      <Badge variant="outline" className={cn("h-7 text-[11px] font-bold px-3 py-0 rounded-full transition-all shadow-none", statusColors[first.status] || 'bg-background border-border text-foreground')}>
                                        {first.status}
                                      </Badge>
                                    )}
                                  </TableCell>
                                )}
                                {visibleColumns.includes('booking') && (
                                  <TableCell className="py-3">
                                    {bookingNumber ? (
                                      <Link
                                        href={`/bookings?bkg=${bookingNumber}`}
                                        onClick={(e) => e.stopPropagation()}
                                        className="text-xs font-mono font-semibold text-primary hover:underline underline-offset-4 decoration-primary/40"
                                      >
                                        {bookingNumber}
                                      </Link>
                                    ) : (
                                      <span className="text-xs text-muted-foreground">—</span>
                                    )}
                                  </TableCell>
                                )}
                                {visibleColumns.includes('asn') && (
                                  <TableCell className="py-3" onClick={(e: any) => e.stopPropagation()}>
                                    {(isMultiPO ? group.some((row: any) => row.asn_sent) : first.asn_sent) ? (
                                      <Badge variant="outline" className="h-6 text-[10px] bg-primary/20 text-primary-foreground border-primary/40 uppercase font-bold">
                                        ASN Sent
                                      </Badge>
                                    ) : !isVirtualRow ? (
                                      <Button
                                        size="sm"
                                        variant="outline"
                                        onClick={() => setAsnShipment(isMultiPO ? group : first)}
                                        className="h-7 text-xs border-primary text-primary hover:bg-primary/10"
                                      >
                                        Send ASN
                                      </Button>
                                    ) : null}
                                  </TableCell>
                                )}
                              </TableRow>

                              {/* ── Sub-rows (expanded multi-PO breakdown) ── */}
                              {isMultiPO && isExpanded && group.map((s: any) => (
                                <TableRow key={`sub-${s.id}`} className="bg-muted/10 border-l-2 border-l-primary/20 hover:bg-muted/20 transition-colors">
                                  <TableCell colSpan={visibleColumns.length} className="py-2 pl-10 pr-4">
                                    <div className="flex items-center gap-6 text-xs">
                                      <span className="font-mono font-semibold text-foreground w-32 shrink-0">{s.po_number}</span>
                                      <span className="text-muted-foreground">
                                        {parseInt(s.expected_quantity || '0').toLocaleString()} units
                                      </span>
                                      {s.lot_number != null ? (
                                        <Badge variant="outline" className="text-[9px] font-bold px-1.5 py-0 bg-amber-500/10 border-amber-500/30 text-amber-700">
                                          Lot {s.lot_number}
                                        </Badge>
                                      ) : (
                                        <Badge variant="outline" className="text-[9px] font-bold px-1.5 py-0 bg-emerald-500/10 border-emerald-500/30 text-emerald-700">
                                          Full
                                        </Badge>
                                      )}
                                    </div>
                                  </TableCell>
                                </TableRow>
                              ))}

                              {/* ── Expandable line-items row ── */}
                              {!isMultiPO && expandedRows.has(first.id) && (
                                <TableRow className="bg-muted/5 border-l-2 border-l-primary/20">
                                  <TableCell colSpan={visibleColumns.length} className="py-3 px-6">
                                    {lineItemsCache[first.id] ? (
                                      lineItemsCache[first.id].length > 0 ? (
                                        <div className="overflow-x-auto rounded-lg border border-border/50">
                                          <table className="w-full text-xs">
                                            <thead>
                                              <tr className="border-b border-border/50 bg-muted/30">
                                                <th className="text-left font-semibold text-muted-foreground px-3 py-1.5 uppercase tracking-wider">SKU</th>
                                                <th className="text-left font-semibold text-muted-foreground px-3 py-1.5 uppercase tracking-wider">Description</th>
                                                <th className="text-right font-semibold text-muted-foreground px-3 py-1.5 uppercase tracking-wider">Expected Qty</th>
                                                <th className="text-right font-semibold text-muted-foreground px-3 py-1.5 uppercase tracking-wider">Shipped Qty</th>
                                              </tr>
                                            </thead>
                                            <tbody>
                                              {lineItemsCache[first.id].map((item: any, idx: number) => (
                                                <tr key={item.sku_code || idx} className="border-b border-border/20 last:border-0">
                                                  <td className="px-3 py-1.5 font-mono font-semibold text-primary">{item.sku_code}</td>
                                                  <td className="px-3 py-1.5 text-foreground">{item.description || '—'}</td>
                                                  <td className="px-3 py-1.5 text-right tabular-nums font-semibold">{Number(item.expected_qty || 0).toLocaleString()}</td>
                                                  <td className="px-3 py-1.5 text-right tabular-nums">{Number(item.shipped_qty || 0).toLocaleString()}</td>
                                                </tr>
                                              ))}
                                            </tbody>
                                          </table>
                                        </div>
                                      ) : (
                                        <p className="text-xs text-muted-foreground italic">No line items for this shipment.</p>
                                      )
                                    ) : (
                                      <p className="text-xs text-muted-foreground italic">Loading line items...</p>
                                    )}
                                  </TableCell>
                                </TableRow>
                              )}
                            </React.Fragment>
                          );
                        })
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

      <BookingDetailDrawer
        booking={selectedBooking}
        open={!!selectedBooking}
        onClose={() => setSelectedBooking(null)}
        onApprove={async (b: any) => {
          await updateBooking(b.id, { booking_status: 'Booking Approved', approved_at: new Date().toISOString() });
          setSelectedBooking(null);
          fetchShipments();
        }}
        onDecline={async (b: any, reason: string) => {
          await updateBooking(b.id, { booking_status: 'Declined', decline_reason: reason });
          setSelectedBooking(null);
          fetchShipments();
        }}
        user={user}
        onSuccess={fetchShipments}
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
