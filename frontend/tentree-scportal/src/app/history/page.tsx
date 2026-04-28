'use client';

import React, { useState, useEffect } from 'react';
import { getShipments } from '../actions/shipments';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Search, Archive, Download } from 'lucide-react';
import { format } from 'date-fns';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';

const statusColors: any = {
  'Received': 'bg-green-100 text-green-800',
  'Delivered': 'bg-blue-100 text-blue-800',
};

function HistoryTable({ list, isLoading, columns }: any) {
  return (
    <div className="bg-card rounded-xl border border-border overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow className="bg-muted/50">
            {columns.map((c: string) => <TableHead key={c} className="font-semibold">{c}</TableHead>)}
          </TableRow>
        </TableHeader>
        <TableBody>
          {isLoading ? (
            <TableRow><TableCell colSpan={columns.length} className="text-center py-8 text-muted-foreground">Loading...</TableCell></TableRow>
          ) : list.length === 0 ? (
            <TableRow><TableCell colSpan={columns.length} className="text-center py-8 text-muted-foreground">No archived shipments</TableCell></TableRow>
          ) : (
            list.map((s: any) => (
              <TableRow key={s.id}>
                <TableCell className="text-sm font-mono text-xs">{s.season || '—'}</TableCell>
                <TableCell className="font-medium text-sm">{s.po_number || '-'}</TableCell>
                <TableCell className="font-medium text-sm">{s.lot_number || '-'}</TableCell>
                <TableCell className="text-sm font-mono text-xs">{s.trn_number || '—'}</TableCell>
                <TableCell className="text-sm">{s.supplier}</TableCell>
                <TableCell className="text-sm">{s.mode}</TableCell>                
                <TableCell className="text-sm">{s.courier}</TableCell>
                <TableCell className="text-sm">{s.origin}</TableCell>
                <TableCell className="text-sm">{s.destination_warehouse}</TableCell>
                <TableCell className="text-sm">{s.tracking_number}</TableCell>
                <TableCell className="text-sm">{s.eta ? format(new Date(s.eta + 'T12:00:00'), 'MMM d, yyyy') : '—'}</TableCell>
                <TableCell>
                  <Badge className={statusColors[s.status] || 'bg-gray-100 text-gray-800'} variant="secondary">{s.status}</Badge>
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}

export default function History() {
  const [search, setSearch] = useState('');
  const [filterWarehouse, setFilterWarehouse] = useState('All');
  const [activeTab, setActiveTab] = useState('mainline');
  const [shipments, setShipments] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    getShipments().then(data => {
      // client-side filter for archived
      setShipments((data || []).filter((s:any) => s.archived));
      setIsLoading(false);
    });
  }, []);

  const applyFilters = (list: any[]) => list.filter(s => {
    const matchSearch = !search ||
      s.po_number?.toLowerCase().includes(search.toLowerCase()) ||
      s.supplier?.toLowerCase().includes(search.toLowerCase()) ||
      s.trn_number?.toLowerCase().includes(search.toLowerCase());
    const matchWarehouse = filterWarehouse === 'All' || s.destination_warehouse === filterWarehouse;
    return matchSearch && matchWarehouse;
  });

  const mainlineList = applyFilters(shipments.filter(s => s.mode !== 'Courier'));
  const smsList = applyFilters(shipments.filter(s => s.mode === 'Courier'));
  const activeList = activeTab === 'mainline' ? mainlineList : smsList;

  const sharedColumns = ['Season', 'PO Number', 'Lot', 'TRN No.', 'Mode', 'Courier', 'Supplier', 'Origin', 'Warehouse', 'Tracking No.', 'ETA', 'Status'];

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center gap-3">
        <Archive className="w-5 h-5 text-primary" />
        <h1 className="text-xl font-semibold font-inter">Shipment History</h1>
        <div className="ml-auto">
          <Button variant="outline" size="sm">
            <Download className="w-4 h-4 mr-1.5" /> Export
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input placeholder="Search by PO, Supplier, TRN..." className="pl-9" value={search} onChange={(e: any) => setSearch(e.target.value)} />
        </div>
        <Select value={filterWarehouse} onValueChange={(val) => setFilterWarehouse(val || '')}>
          <SelectTrigger className="w-36"><SelectValue placeholder="Warehouse" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="All">All Warehouses</SelectItem>
            <SelectItem value="NRI Canada">NRI Canada</SelectItem>
            <SelectItem value="NRI US">NRI US</SelectItem>
            <SelectItem value="GoBolt">GoBolt</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <Tabs value={activeTab} onValueChange={(val) => setActiveTab(val || '')}>
        <TabsList>
          <TabsTrigger value="mainline">Mainline ({mainlineList.length})</TabsTrigger>
          <TabsTrigger value="sms">SMS ({smsList.length})</TabsTrigger>
        </TabsList>
        <TabsContent value="mainline">
          <HistoryTable list={mainlineList} isLoading={isLoading} columns={sharedColumns} />
        </TabsContent>
        <TabsContent value="sms">
          <HistoryTable list={smsList} isLoading={isLoading} columns={sharedColumns} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
