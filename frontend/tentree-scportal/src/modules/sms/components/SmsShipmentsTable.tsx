'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Plus, RadioTower } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useSession } from '@/components/providers/SessionProvider';
// Generic UI primitive shared across modules (no mainline data coupling)
import DataTable, { type DataColumn } from '@/modules/mainline/components/DataTable';
import { pollSmsTracking } from '@/modules/sms/actions';
import SmsShipmentForm from './SmsShipmentForm';
import { SMS_STATUS_STYLES, facilityLabel } from './smsStatus';
import { SeasonScopeFilter, seasonsFrom, applySeasonScope, type Scope } from '@/components/SeasonScopeFilter';
import type { SmsShipment, SmsPo, CourierOption } from '@/modules/sms/types';

const dim = (v: string | null) => <span className="text-muted-foreground">{v ?? '—'}</span>;

// An SMS shipment is done once Delivered (courier dropped it off) or Received (also
// booked into NetSuite). Exception stays "active" — it needs attention.
const SMS_SHIP_DONE = new Set(['Delivered', 'Received']);

export default function SmsShipmentsTable({ shipments, pos, couriers }: {
  shipments: SmsShipment[];
  pos: SmsPo[];
  couriers: CourierOption[];
}) {
  const router = useRouter();
  const { user } = useSession();
  const isVendor = user?.role === 'Vendor';
  const [open, setOpen] = useState(false);
  const [polling, setPolling] = useState(false);

  // Season + Active/All filter (default: current season + not-yet-delivered).
  const seasonOptions = useMemo(() => seasonsFrom(shipments), [shipments]);
  const [season, setSeason] = useState('all');
  const [scope, setScope] = useState<Scope>('active');
  useEffect(() => { setSeason((cur) => (cur === 'all' && seasonOptions.length ? seasonOptions[0] : cur)); }, [seasonOptions]);
  const visibleShipments = useMemo(
    () => applySeasonScope(shipments, { season, scope, isCompleted: (s) => SMS_SHIP_DONE.has(s.status || '') }),
    [shipments, season, scope],
  );

  async function onPoll() {
    setPolling(true);
    const r = await pollSmsTracking();
    setPolling(false);
    if (r?.fetch_error) return void toast.error(`FedEx: ${r.fetch_error}`);
    if (r?.error) return void toast.error(r.error);
    toast.success(`Tracking poll: ${r.polled ?? 0} shipment${(r.polled ?? 0) === 1 ? '' : 's'} checked, ${r.events_added ?? 0} new event${(r.events_added ?? 0) === 1 ? '' : 's'}`);
    router.refresh();
  }

  const columns: DataColumn<SmsShipment>[] = [
    { key: 'tracking_number', label: 'Tracking #', accessor: (s) => s.tracking_number, render: (s) => (
      <span className="font-medium font-mono text-xs">{s.tracking_number || `Shipment ${s.id}`}</span>
    ) },
    { key: 'courier', label: 'Courier', accessor: (s) => s.courier, render: (s) => dim(s.courier) },
    // Mode is set on booked consignments (copied from the booking); a vendor-entered
    // parcel leaves it null and posts to NetSuite as Courier.
    { key: 'mode', label: 'Mode', defaultVisible: false, accessor: (s) => s.mode, render: (s) => dim(s.mode) },
    { key: 'supplier', label: 'Supplier', accessor: (s) => s.supplier, render: (s) => dim(s.supplier) },
    { key: 'ship_date', label: 'Ship Date', accessor: (s) => s.ship_date, render: (s) => dim(s.ship_date) },
    { key: 'facility', label: 'Destination', accessor: (s) => facilityLabel(s.facility), render: (s) => dim(facilityLabel(s.facility)) },
    { key: 'season', label: 'Season', defaultVisible: false, accessor: (s) => s.season, render: (s) => dim(s.season) },
    { key: 'pos', label: 'POs (lots)', sortable: false,
      accessor: (s) => s.pos.map((p) => p.po_number).join(', '),
      render: (s) => <span className="text-xs">{s.pos.map((p) => `${p.po_number} (lot ${p.lot_number})`).join(', ') || '—'}</span> },
    { key: 'total_units', label: 'Units', align: 'right', accessor: (s) => s.total_units, render: (s) => s.total_units.toLocaleString() },
    { key: 'total_cartons', label: 'Cartons', align: 'right', defaultVisible: false, accessor: (s) => s.total_cartons, render: (s) => s.total_cartons ? s.total_cartons.toLocaleString() : '—' },
    { key: 'status', label: 'Status', accessor: (s) => s.status, render: (s) => (
      <>
        <Badge variant="outline" className={cn(SMS_STATUS_STYLES[s.status || ''])}>{s.status ?? '—'}</Badge>
        {s.status_source === 'manual' && <span className="ml-1.5 text-[10px] uppercase tracking-wider text-muted-foreground/70">manual</span>}
      </>
    ) },
    // Received-in-NetSuite date (the IR date) — off by default; the Received badge
    // above already says it happened, this says when the warehouse booked it in.
    { key: 'received_date', label: 'Received (NS)', defaultVisible: false,
      accessor: (s) => s.received_date, render: (s) => dim(s.received_date) },
    { key: 'events', label: 'Scans', align: 'right', defaultVisible: false, accessor: (s) => s.tracking_events.length, render: (s) => s.tracking_events.length.toLocaleString() },
  ];

  const toolbar = (
    <>
      <SeasonScopeFilter season={season} seasons={seasonOptions} onSeason={setSeason} scope={scope} onScope={setScope} activeLabel="In Transit" />
      {!isVendor && (
        <Button variant="outline" size="sm" disabled={polling} onClick={onPoll} title="Pull the latest FedEx scan events now (also runs automatically every 4 hours)">
          <RadioTower className={cn('h-4 w-4 mr-1.5', polling && 'animate-pulse')} />{polling ? 'Polling…' : 'Poll Tracking'}
        </Button>
      )}
      <Button size="sm" onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4 mr-1" /> New Shipment
      </Button>
    </>
  );

  return (
    <>
      <DataTable
        rows={visibleShipments} columns={columns} rowKey={(s) => s.id}
        noun="shipment" searchPlaceholder="Search tracking #, PO…"
        toolbar={toolbar} emptyText="No shipments yet — vendors add one with New Shipment after handing boxes to the courier"
        storageKey="sms_shipment_columns"
        onRowClick={(s) => router.push(`/sms/shipments/${s.id}`)}
      />
      <SmsShipmentForm open={open} onClose={() => setOpen(false)} pos={pos} couriers={couriers} />
    </>
  );
}
