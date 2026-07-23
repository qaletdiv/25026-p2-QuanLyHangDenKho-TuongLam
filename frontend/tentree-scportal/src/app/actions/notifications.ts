'use server';

// Derived, role-scoped notifications (backend /notifications). The list + unread
// count are computed server-side per the caller's role/scope; markSeen clears the
// unread badge by recording the user's current active notification keys.

import { fetchApi } from '@/lib/api';

export interface Notification {
  key: string;
  type: string;
  module: 'mainline' | 'sms';
  severity: 'alert' | 'warning' | 'info';
  title: string;
  message: string;
  date: string | null;
  link: string;
  unread: boolean;
}

export async function getNotifications(): Promise<{ notifications: Notification[]; unread_count: number }> {
  const data = await fetchApi('/notifications');
  return data && Array.isArray(data.notifications) ? data : { notifications: [], unread_count: 0 };
}

export async function markNotificationsSeen() {
  return fetchApi('/notifications/seen', { method: 'POST', body: '{}' });
}
