'use client';

// SMS bookings list. Same lifecycle-table conventions as every other list surface:
// generic DataTable + Season/Active-All scope filter. "Done" = Approved/Rejected/
// Cancelled (active = Pending, i.e. awaiting a Logistics decision), mirroring the
// mainline booking table.

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Plus } from 'lucide-react';
import { cn } from '@/lib/utils';
// Generic UI primitives shared across modules (no mainline data coupling)
import DataTable, { type DataColumn } from '@/modules/mainline/components/DataTable';
import { SeasonScopeFilter, seasonsFrom, applySeasonScope, type Scope } from '@/components/SeasonScopeFilter';
import SmsBookingForm from './SmsBookingForm';
import { facilityLabel } from './smsStatus';
import type { SmsBooking, SmsPo, IncotermOption, CourierOption, ModeOption } from '@/modules/sms/types';

const dim = (v: string | null) => <span className="text-muted-foreground">{v ?? '—'}</span>;

export const SMS_BOOKING_STATUS_STYLES: Record<string, string> = {
  'Booking Pending':  'bg-amber-500/10 border-amber-500/30 text-amber-700',
  'Booking Approved': 'bg-blue-500/10 border-blue-500/30 text-blue-600',
  'Rejected':         'bg-red-500/10 border-red-500/30 text-red-600',
  'Cancelled':        'bg-muted border-border text-muted-foreground',
};

// A booking is done once Logistics has decided on it; Pending is the active work.
const SMS_BOOKING_DONE = new Set(['Booking Approved', 'Rejected', 'Cancelled']);

export default function SmsBookingsTable({ bookings, pos, incoterms, couriers = [], modes = [] }: {
  bookings: SmsBooking[];
  pos: SmsPo[];
  incoterms: IncotermOption[];
  couriers?: CourierOption[];
  modes?: ModeOption[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  const seasonOptions = useMemo(() => seasonsFrom(bookings), [bookings]);
  const [season, setSeason] = useState('all');
  const [scope, setScope] = useState<Scope>('active');
  useEffect(() => { setSeason((cur) => (cur === 'all' && seasonOptions.length ? seasonOptions[0] : cur)); }, [seasonOptions]);
  const visible = useMemo(
    () => applySeasonScope(bookings, { season, scope, isCompleted: (b) => SMS_BOOKING_DONE.has(b.booking_status || '') }),
    [bookings, season, scope],
  );

  const columns: DataColumn<SmsBooking>[] = [
    { key: 'booking_number', label: 'Booking #', accessor: (b) => b.booking_number, render: (b) => (
      <span className="font-medium">{b.booking_number}</span>
    ) },
    { key: 'supplier_name', label: 'Supplier', accessor: (b) => b.supplier_name, render: (b) => dim(b.supplier_name) },
    { key: 'cargo_ready_date', label: 'Cargo Ready', accessor: (b) => b.cargo_ready_date, render: (b) => dim(b.cargo_ready_date) },
    { key: 'destination', label: 'Destination', accessor: (b) => facilityLabel(b.destination), render: (b) => dim(facilityLabel(b.destination)) },
    { key: 'season', label: 'Season', defaultVisible: false, accessor: (b) => b.season, render: (b) => dim(b.season) },
    { key: 'pos', label: 'POs (lots)', sortable: false,
      accessor: (b) => b.pos.map((p) => p.po_number).join(', '),
      render: (b) => <span className="text-xs">{b.pos.map((p) => `${p.po_number} (lot ${p.lot_number})`).join(', ') || '—'}</span> },
    { key: 'total_units', label: 'Units', align: 'right', accessor: (b) => b.total_units, render: (b) => b.total_units.toLocaleString() },
    { key: 'total_cartons', label: 'Cartons', align: 'right', defaultVisible: false, accessor: (b) => b.total_cartons, render: (b) => (b.total_cartons ? b.total_cartons.toLocaleString() : '—') },
    { key: 'total_weight_kg', label: 'Weight (kg)', align: 'right', defaultVisible: false, accessor: (b) => b.total_weight_kg, render: (b) => (b.total_weight_kg ? b.total_weight_kg.toLocaleString() : '—') },
    { key: 'courier', label: 'Carrier', accessor: (b) => b.courier, render: (b) => dim(b.courier) },
    { key: 'mode', label: 'Mode', accessor: (b) => b.mode, render: (b) => dim(b.mode) },
    { key: 'incoterm', label: 'Incoterm', defaultVisible: false, accessor: (b) => b.incoterm, render: (b) => dim(b.incoterm) },
    { key: 'booking_status', label: 'Status', accessor: (b) => b.booking_status, render: (b) => (
      <Badge variant="outline" className={cn(SMS_BOOKING_STATUS_STYLES[b.booking_status || ''])}>{b.booking_status ?? '—'}</Badge>
    ) },
    // Consignments produced by approval — draft until a tracking number exists.
    { key: 'shipments', label: 'Consignments', sortable: false,
      accessor: (b) => b.shipments.length,
      render: (b) => (b.shipments.length
        ? <span className="text-xs">{b.shipments.map((s) => s.tracking_number || 'draft').join(', ')}</span>
        : dim(null)) },
  ];

  const toolbar = (
    <>
      <SeasonScopeFilter season={season} seasons={seasonOptions} onSeason={setSeason} scope={scope} onScope={setScope} activeLabel="Pending" />
      <Button size="sm" onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4 mr-1" /> New Booking
      </Button>
    </>
  );

  return (
    <>
      <DataTable
        rows={visible} columns={columns} rowKey={(b) => b.id}
        noun="booking" searchPlaceholder="Search booking #, PO, supplier…"
        toolbar={toolbar}
        emptyText="No bookings — SMS consignments can also be entered directly under SMS Shipments without one"
        storageKey="sms_booking_columns"
        onRowClick={(b) => router.push(`/sms/bookings/${b.id}`)}
      />
      <SmsBookingForm open={open} onClose={() => setOpen(false)} pos={pos} incoterms={incoterms} couriers={couriers} modes={modes} />
    </>
  );
}
