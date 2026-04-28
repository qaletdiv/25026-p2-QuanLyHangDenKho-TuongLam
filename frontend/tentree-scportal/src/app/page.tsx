import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Package, FileText, Shield, CalendarCheck, Ship, Plane, Truck, ArrowRight } from 'lucide-react';
import Link from 'next/link';
import { format } from 'date-fns';
import { getShipments } from './actions/shipments';
import { getBookings } from './actions/bookings';
import { getEomTasks } from './actions/tasks';

const statusColors: any = {
  'Booking Received': 'bg-amber-100 text-amber-800',
  'Booking Approved': 'bg-blue-100 text-blue-800',
  'Docs Sent': 'bg-indigo-100 text-indigo-800',
  'Customs Cleared': 'bg-purple-100 text-purple-800',
  'In Transit': 'bg-cyan-100 text-cyan-800',
  'ASN Sent': 'bg-emerald-100 text-emerald-800',
  'Received': 'bg-green-100 text-green-800',
};

const modeIcons: any = { Ocean: Ship, Air: Plane, Courier: Truck, DDP: Truck };

export default async function Dashboard() {
  const currentMonth = format(new Date(), 'yyyy-MM');
  
  // Fetch data on the server
  const [shipments, bookings, eomTasks] = await Promise.all([
    getShipments(),
    getBookings(),
    getEomTasks(currentMonth)
  ]);

  const activeShipments = shipments.filter((s: any) => s.status !== 'Received');
  const pendingBookings = bookings.filter((b: any) => b.decision === 'Pending');
  const monthTasks = eomTasks.filter((t: any) => t.month === currentMonth);
  const completedTasks = monthTasks.filter((t: any) => t.status === 'Done').length;
  const totalTasks = monthTasks.length;

  const statsByStatus: any = {};
  activeShipments.forEach((s: any) => {
    statsByStatus[s.status] = (statsByStatus[s.status] || 0) + 1;
  });

  return (
    <div className="p-6 space-y-6">
      {/* Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <Link href="/shipments">
          <Card className="hover:shadow-md transition-shadow cursor-pointer border-l-4 border-l-primary">
            <CardContent className="p-5">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Active Shipments</p>
                  <p className="text-3xl font-bold text-foreground mt-1">{activeShipments.length}</p>
                </div>
                <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
                  <Package className="w-5 h-5 text-primary" />
                </div>
              </div>
            </CardContent>
          </Card>
        </Link>
        <Link href="/bookings">
          <Card className="hover:shadow-md transition-shadow cursor-pointer border-l-4 border-l-amber-500">
            <CardContent className="p-5">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Pending Bookings</p>
                  <p className="text-3xl font-bold text-foreground mt-1">{pendingBookings.length}</p>
                </div>
                <div className="w-10 h-10 rounded-xl bg-amber-50 flex items-center justify-center">
                  <FileText className="w-5 h-5 text-amber-600" />
                </div>
              </div>
            </CardContent>
          </Card>
        </Link>
        <Link href="/asn">
          <Card className="hover:shadow-md transition-shadow cursor-pointer border-l-4 border-l-emerald-500">
            <CardContent className="p-5">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">ASN Pending</p>
                  <p className="text-3xl font-bold text-foreground mt-1">
                    {activeShipments.filter((s:any) => !s.asn_sent && ['In Transit', 'Customs Cleared'].includes(s.status)).length}
                  </p>
                </div>
                <div className="w-10 h-10 rounded-xl bg-emerald-50 flex items-center justify-center">
                  <Shield className="w-5 h-5 text-emerald-600" />
                </div>
              </div>
            </CardContent>
          </Card>
        </Link>
        <Link href="/eom">
          <Card className="hover:shadow-md transition-shadow cursor-pointer border-l-4 border-l-purple-500">
            <CardContent className="p-5">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">EoM Progress</p>
                  <p className="text-3xl font-bold text-foreground mt-1">
                    {totalTasks ? `${completedTasks}/${totalTasks}` : '—'}
                  </p>
                </div>
                <div className="w-10 h-10 rounded-xl bg-purple-50 flex items-center justify-center">
                  <CalendarCheck className="w-5 h-5 text-purple-600" />
                </div>
              </div>
            </CardContent>
          </Card>
        </Link>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Status Breakdown */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold">Shipment Pipeline</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {Object.entries(statsByStatus).length === 0 && (
              <p className="text-sm text-muted-foreground">No active shipments</p>
            )}
            {Object.entries(statsByStatus).map(([status, count]: any) => (
              <div key={status} className="flex items-center justify-between py-1.5">
                <Badge className={statusColors[status] || 'bg-muted text-muted-foreground'} variant="secondary">
                  {status}
                </Badge>
                <span className="text-sm font-semibold text-foreground">{count}</span>
              </div>
            ))}
          </CardContent>
        </Card>

        {/* Recent Shipments */}
        <Card className="lg:col-span-2">
          <CardHeader className="pb-3 flex flex-row items-center justify-between">
            <CardTitle className="text-sm font-semibold">Recent Shipments</CardTitle>
            <Link href="/shipments" className="text-xs text-primary hover:underline flex items-center gap-1">
              View all <ArrowRight className="w-3 h-3" />
            </Link>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {activeShipments.slice(0, 6).map((s: any) => {
                const ModeIcon = modeIcons[s.mode] || Package;
                return (
                  <div key={s.id} className="flex items-center gap-3 p-2.5 rounded-lg hover:bg-muted/50 transition-colors">
                    <div className="w-8 h-8 rounded-lg bg-muted flex items-center justify-center">
                      <ModeIcon className="w-4 h-4 text-muted-foreground" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-foreground truncate">{s.supplier} — {s.po_number}</p>
                      <p className="text-xs text-muted-foreground">{s.destination_warehouse} • ETA {s.eta ? format(new Date(s.eta), 'MMM d') : '—'}</p>
                    </div>
                    <Badge className={statusColors[s.status] || 'bg-muted'} variant="secondary">
                      {s.status}
                    </Badge>
                  </div>
                );
              })}
              {activeShipments.length === 0 && (
                <p className="text-sm text-muted-foreground py-4 text-center">No active shipments yet</p>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
