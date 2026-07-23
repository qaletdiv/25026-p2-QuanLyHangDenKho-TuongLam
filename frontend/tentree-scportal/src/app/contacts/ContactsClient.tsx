'use client';

import React, { useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Search, Mail, Copy, User } from 'lucide-react';
import { toast } from 'sonner';


const groupColors: any = {
  'Suppliers': 'bg-blue-100 text-blue-800',
  'FedEx': 'bg-purple-100 text-purple-800',
  'NRI USA': 'bg-emerald-100 text-emerald-800',
  'NRI Canada': 'bg-teal-100 text-teal-800',
  'CEVA Logistics': 'bg-indigo-100 text-indigo-800',
  'tentree Internal': 'bg-amber-100 text-amber-800',
  'Finance': 'bg-rose-100 text-rose-800',
};

const allGroups = ['All', 'Suppliers', 'FedEx', 'NRI USA', 'NRI Canada', 'CEVA Logistics', 'tentree Internal', 'Finance'];

export default function ContactsClient({ initialContacts }: { initialContacts: any[] }) {
  const [search, setSearch] = useState('');
  const [activeGroup, setActiveGroup] = useState('All');

  const [contacts] = useState<any[]>(initialContacts);

  const filtered = contacts.filter(c => {
    const matchGroup = activeGroup === 'All' || c.group === activeGroup;
    const matchSearch = !search || 
      c.name?.toLowerCase().includes(search.toLowerCase()) ||
      c.email?.toLowerCase().includes(search.toLowerCase()) ||
      c.company?.toLowerCase().includes(search.toLowerCase()) ||
      c.role?.toLowerCase().includes(search.toLowerCase());
    return matchGroup && matchSearch;
  });

  const copyEmail = (email: string) => {
    navigator.clipboard.writeText(email);
    toast.success('Email copied');
  };

  return (
    <div className="flex h-full">
      <div className="flex-1 overflow-y-auto p-4 md:p-6 space-y-4">
        <div className="flex flex-col gap-3">
          <div className="relative max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input placeholder="Search by name, email..." className="pl-9" value={search} onChange={(e: any) => setSearch(e.target.value)} />
          </div>
          <Tabs value={activeGroup} onValueChange={(val) => setActiveGroup(val || '')}>
            <TabsList className="flex-wrap h-auto gap-1">
              {allGroups.map(g => (
                <TabsTrigger key={g} value={g} className="text-xs">{g}</TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {filtered.map(contact => (
            <Card key={contact.id} className="hover:shadow-md transition-shadow">
              <CardContent className="p-4">
                <div className="flex items-start gap-3">
                  <div className="w-9 h-9 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                    <User className="w-4 h-4 text-primary" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <p className="font-medium text-sm text-foreground truncate">{contact.name || contact.role || 'Unknown'}</p>
                    </div>
                    {contact.email && (
                      <button onClick={() => copyEmail(contact.email)} className="flex items-center gap-1.5 mt-2 text-xs text-primary hover:underline group">
                        <Mail className="w-3 h-3" />
                        <span className="truncate">{contact.email}</span>
                      </button>
                    )}
                    <Badge className={`${groupColors[contact.group] || 'bg-muted'} mt-2 text-[10px]`} variant="secondary">
                      {contact.group}
                    </Badge>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
          {filtered.length === 0 && <div className="col-span-full py-12 text-center text-muted-foreground text-sm">No contacts found</div>}
        </div>
      </div>

    </div>
  );
}
