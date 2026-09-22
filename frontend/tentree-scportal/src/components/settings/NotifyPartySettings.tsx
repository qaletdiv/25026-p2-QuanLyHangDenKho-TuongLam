'use client';

// The NOTIFY PARTY block of the Commercial Invoice — ONE record, not a list.
//
// It is always tentree, whatever the destination, supplier or module, so it is a
// single row rather than a column on each destination: five copies of one fact are
// five chances for them to disagree on a customs document. Two plain fields, so
// this renders as a form rather than a SettingsTable.

import { useState, useEffect, useRef } from 'react';
import { getNotifyParty, updateNotifyParty } from '@/app/actions/master-data';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';
import { BellRing } from 'lucide-react';
import { EditLockActions } from './EditLockActions';

type NotifyParty = { id?: string; name: string; address: string };
const EMPTY: NotifyParty = { name: '', address: '' };

export function NotifyPartySettings() {
  const [party, setParty] = useState<NotifyParty>(EMPTY);
  const [isLoading, setIsLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const saved = useRef<NotifyParty>(EMPTY);

  useEffect(() => {
    getNotifyParty().then(data => {
      const row = (Array.isArray(data) ? data : [])[0];
      const next = { name: row?.name || '', address: row?.address || '' };
      setParty(next); saved.current = next;
      setIsLoading(false);
    });
  }, []);

  const handleSave = async () => {
    if (!party.name.trim()) { toast.error('Notify party name is required.'); return; }
    const res = await updateNotifyParty(party);
    if (res?.error) { toast.error(res.error); return; }
    saved.current = party; setEditing(false);
    toast.success('Notify party updated.');
  };

  const handleCancel = () => { setParty(saved.current); setEditing(false); };

  if (isLoading) return <div className="p-4 text-sm text-muted-foreground italic">Loading notify party...</div>;

  return (
    <div className="space-y-4 bg-card p-4 sm:p-6 rounded-xl border shadow-sm">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <BellRing className="w-5 h-5 text-primary" />
          <div>
            <h2 className="text-lg font-semibold">Notify Party</h2>
            <p className="text-sm text-muted-foreground">
              Printed on every Commercial Invoice, mainline and SMS. One record — the notify
              party is the same whatever the destination.
            </p>
          </div>
        </div>
        <EditLockActions editing={editing} onEdit={() => setEditing(true)} onCancel={handleCancel} onSave={handleSave} />
      </div>
      <fieldset disabled={!editing} className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="notify-name">Name</Label>
          <Input
            id="notify-name"
            value={party.name}
            onChange={(e) => setParty({ ...party, name: e.target.value })}
            placeholder="tentree international inc."
            className="h-9 text-sm"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="notify-address">Address</Label>
          <Textarea
            id="notify-address"
            value={party.address}
            onChange={(e) => setParty({ ...party, address: e.target.value })}
            rows={3}
            placeholder="Street, city, province, postal code, country"
            className="text-sm"
          />
        </div>
      </fieldset>
    </div>
  );
}
