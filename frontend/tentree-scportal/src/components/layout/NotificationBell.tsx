'use client';

// Top-bar notification bell — derived, role-scoped alerts from /notifications.
// Polls every 60s for the unread badge; opening the popover marks the current
// active notifications seen (clears the badge). Each row links to the entity.

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Bell, AlertTriangle, AlertCircle, Info } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { getNotifications, markNotificationsSeen, type Notification } from '@/app/actions/notifications';
import { cn } from '@/lib/utils';

const SEV: Record<string, { Icon: typeof Info; color: string; dot: string }> = {
  alert:   { Icon: AlertCircle,   color: 'text-red-600',   dot: 'bg-red-500' },
  warning: { Icon: AlertTriangle, color: 'text-amber-600', dot: 'bg-amber-500' },
  info:    { Icon: Info,          color: 'text-blue-600',  dot: 'bg-blue-500' },
};

export default function NotificationBell() {
  const [items, setItems] = useState<Notification[]>([]);
  const [unread, setUnread] = useState(0);

  const load = useCallback(async () => {
    try { const r = await getNotifications(); setItems(r.notifications); setUnread(r.unread_count); } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 60000);   // refresh the badge periodically
    return () => clearInterval(id);
  }, [load]);

  const onOpenChange = async (open: boolean) => {
    if (open && unread > 0) {
      setUnread(0);                          // optimistic — clear the badge on open
      try { await markNotificationsSeen(); } catch { /* ignore */ }
    }
  };

  return (
    <Popover onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="relative text-muted-foreground hover:bg-muted/50 rounded-full">
          <Bell className="w-5 h-5" />
          {unread > 0 && (
            <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] px-1 flex items-center justify-center rounded-full bg-destructive text-[10px] font-black text-white border-2 border-background">
              {unread > 9 ? '9+' : unread}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 p-0 mt-2 rounded-2xl shadow-2xl overflow-hidden">
        <div className="px-4 py-3 border-b border-border flex items-center justify-between">
          <p className="text-sm font-black text-foreground">Notifications</p>
          <span className="text-xs text-muted-foreground">{items.length}</span>
        </div>
        <div className="max-h-[420px] overflow-y-auto">
          {items.length === 0 ? (
            <div className="px-4 py-10 text-center text-sm text-muted-foreground">You&apos;re all caught up.</div>
          ) : items.map((n) => {
            const sev = SEV[n.severity] || SEV.info;
            const Icon = sev.Icon;
            return (
              <Link
                key={n.key}
                href={n.link}
                className={cn('flex gap-3 px-4 py-3 border-b border-border/60 hover:bg-muted/40 transition-colors', n.unread && 'bg-primary/[0.03]')}
              >
                <Icon className={cn('w-4 h-4 mt-0.5 shrink-0', sev.color)} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-bold text-foreground truncate">{n.title}</p>
                    <span className="ml-auto text-[9px] font-bold uppercase tracking-wider text-muted-foreground shrink-0">{n.module}</span>
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">{n.message}</p>
                </div>
                {n.unread && <span className={cn('w-2 h-2 rounded-full mt-1.5 shrink-0', sev.dot)} />}
              </Link>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
