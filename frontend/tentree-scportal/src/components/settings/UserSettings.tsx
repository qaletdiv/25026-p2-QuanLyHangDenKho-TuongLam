'use client';

import React, { useState, useEffect } from 'react';
import { getUsers, createUser, updateUser, deleteUser } from '@/app/actions/users';
import { getSuppliers } from '@/app/actions/master-data';
import { getRoles } from '@/app/actions/roles';
import { useSession } from '@/components/providers/SessionProvider';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { SettingsTable, type SettingsColumn } from './SettingsTable';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { toast } from 'sonner';
import { Plus, Trash2, Save, UserCog, KeyRound, Eye, EyeOff, Pencil, Check } from 'lucide-react';

const roleBadgeClass: Record<string, string> = {
  'Admin':                 'bg-destructive/10 border-destructive/30 text-destructive',
  'Logistics Coordinator': 'bg-blue-500/10 border-blue-500/30 text-blue-600',
  'Production':            'bg-amber-500/10 border-amber-500/30 text-amber-700',
  'Vendor':                'bg-green-500/10 border-green-500/30 text-green-700',
  'Freight Forwarder':     'bg-purple-500/10 border-purple-500/30 text-purple-700',
};

const emptyForm: { name: string; email: string; password: string; role: string; supplier: string | null } = { name: '', email: '', password: '', role: '', supplier: '' };

export function UserSettings() {
  const { user: sessionUser } = useSession();
  const [users, setUsers] = useState<any[]>([]);
  const [suppliers, setSuppliers] = useState<any[]>([]);
  const [roleOptions, setRoleOptions] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [editing, setEditing] = useState(false);   // screen is read-only until Edit

  // The Add-User dialog is Radix; the role/supplier Selects are Base UI (portaled
  // to <body>). Without this, Radix's focus trap yanks focus back the instant the
  // Select popup opens → the list flashes shut. Keep the dialog open when the
  // interaction/focus target is inside a Select popup.
  const keepOpenForSelect = (e: { detail: { originalEvent: Event }; preventDefault: () => void }) => {
    const t = e.detail.originalEvent.target as HTMLElement | null;
    if (t?.closest?.('[data-slot="select-content"],[data-slot="select-trigger"]')) e.preventDefault();
  };

  // Inline pending edits keyed by user id
  const [edits, setEdits] = useState<Record<string, any>>({});
  const [savingId, setSavingId] = useState<string | null>(null);

  // Add user dialog
  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState({ ...emptyForm });
  const [showPassword, setShowPassword] = useState(false);
  const [isCreating, setIsCreating] = useState(false);

  // Reset-password dialog
  const [resetTarget, setResetTarget] = useState<any>(null);
  const [newPassword, setNewPassword] = useState('');
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [isResetting, setIsResetting] = useState(false);

  useEffect(() => {
    Promise.all([getUsers(), getSuppliers(), getRoles()]).then(([u, s, r]) => {
      if (!Array.isArray(u)) {
        toast.error(`Failed to load users: ${(u as any)?.error || 'Unknown error'}`);
      }
      setUsers(Array.isArray(u) ? u : []);
      setSuppliers(Array.isArray(s) ? s : []);
      setRoleOptions(Array.isArray(r) ? r.map((role: any) => role.name) : []);
      setIsLoading(false);
    });
  }, []);

  const getEdit = (id: string, key: string, fallback: any) =>
    edits[id]?.[key] !== undefined ? edits[id][key] : fallback;

  const setEdit = (id: string, key: string, value: any) =>
    setEdits(prev => ({ ...prev, [id]: { ...(prev[id] || {}), [key]: value } }));

  const isDirty = (id: string) => !!edits[id] && Object.keys(edits[id]).length > 0;

  // Done: re-lock and drop any unsaved inline edits (rows are saved individually).
  const handleDone = () => { setEdits({}); setEditing(false); };

  const handleSave = async (user: any) => {
    if (!isDirty(user.id)) return;
    setSavingId(user.id);
    try {
      const result = await updateUser(user.id, edits[user.id]);
      if (result?.error) throw new Error(result.error);
      setUsers(prev => prev.map(u => u.id === user.id ? { ...u, ...edits[user.id] } : u));
      setEdits(prev => { const n = { ...prev }; delete n[user.id]; return n; });
      toast.success(`${user.name} updated.`);
    } catch (e: any) {
      toast.error(e.message || 'Failed to update user.');
    } finally {
      setSavingId(null);
    }
  };

  const handleDelete = async (user: any) => {
    if (user.id === sessionUser?.id) {
      toast.error('You cannot delete your own account.');
      return;
    }
    if (!confirm(`Delete "${user.name}"? This cannot be undone.`)) return;
    try {
      await deleteUser(user.id);
      setUsers(prev => prev.filter(u => u.id !== user.id));
      toast.success(`${user.name} deleted.`);
    } catch (e: any) {
      toast.error(e.message || 'Failed to delete user.');
    }
  };

  const handleCreate = async () => {
    if (!form.name || !form.email || !form.password || !form.role) {
      toast.error('Name, email, password and role are required.');
      return;
    }
    if (form.password.length < 8) {
      toast.error('Password must be at least 8 characters.');
      return;
    }
    setIsCreating(true);
    try {
      const result = await createUser({
        ...form,
        supplier: form.role === 'Vendor' ? form.supplier || null : null,
      });
      if (result?.error) throw new Error(result.error);
      setUsers(prev => [...prev, result]);
      setDialogOpen(false);
      setForm({ ...emptyForm });
      toast.success(`${result.name} created. They will be prompted to change their password on first login.`);
    } catch (e: any) {
      toast.error(e.message || 'Failed to create user.');
    } finally {
      setIsCreating(false);
    }
  };

  const handleResetPassword = async () => {
    if (!newPassword || newPassword.length < 8) {
      toast.error('New password must be at least 8 characters.');
      return;
    }
    setIsResetting(true);
    try {
      const result = await updateUser(resetTarget.id, { password: newPassword, must_change_password: true });
      if (result?.error) throw new Error(result.error);
      setResetTarget(null);
      setNewPassword('');
      toast.success(`Password reset for ${resetTarget.name}.`);
    } catch (e: any) {
      toast.error(e.message || 'Failed to reset password.');
    } finally {
      setIsResetting(false);
    }
  };

  if (sessionUser?.role !== 'Admin') {
    return <p className="text-sm text-muted-foreground italic p-4">Admin access required.</p>;
  }

  if (isLoading) return <div className="p-4 text-sm text-muted-foreground italic">Loading users...</div>;

  // Columns sort on the value currently SHOWN (pending inline edit if any).
  const columns: SettingsColumn<any>[] = [
    {
      key: 'name', label: 'Name',
      accessor: (u) => getEdit(u.id, 'name', u.name),
      cell: (u) => (
        <Input value={getEdit(u.id, 'name', u.name)} onChange={e => setEdit(u.id, 'name', e.target.value)} className="h-8 text-sm" />
      ),
    },
    {
      key: 'email', label: 'Email',
      accessor: (u) => getEdit(u.id, 'email', u.email),
      cell: (u) => (
        <Input value={getEdit(u.id, 'email', u.email)} onChange={e => setEdit(u.id, 'email', e.target.value)} className="h-8 text-sm" />
      ),
    },
    {
      key: 'role', label: 'Role',
      accessor: (u) => getEdit(u.id, 'role', u.role),
      cell: (u) => (u.id === sessionUser?.id ? (
        <Badge variant="outline" className={`text-xs ${roleBadgeClass[u.role] || ''}`}>{u.role}</Badge>
      ) : (
        <Select value={getEdit(u.id, 'role', u.role)} onValueChange={v => setEdit(u.id, 'role', v)}>
          <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
          <SelectContent>
            {roleOptions.map(r => <SelectItem key={r} value={r}>{r}</SelectItem>)}
          </SelectContent>
        </Select>
      )),
    },
    {
      key: 'supplier', label: 'Supplier',
      accessor: (u) => getEdit(u.id, 'supplier', u.supplier || ''),
      cell: (u) => (getEdit(u.id, 'role', u.role) === 'Vendor' ? (
        <Select
          value={getEdit(u.id, 'supplier', u.supplier || '')}
          onValueChange={v => setEdit(u.id, 'supplier', v)}
          disabled={u.id === sessionUser?.id}
        >
          <SelectTrigger className="h-8 text-sm"><SelectValue placeholder="Select supplier" /></SelectTrigger>
          <SelectContent>
            {suppliers.map((s: any) => <SelectItem key={s.id} value={s.name}>{s.name}</SelectItem>)}
          </SelectContent>
        </Select>
      ) : (
        <span className="text-xs text-muted-foreground">—</span>
      )),
    },
    {
      key: 'actions', label: 'Actions', sortable: false, movable: false, headClassName: 'w-[130px]',
      cell: (u) => (!editing ? <span className="text-xs text-muted-foreground">—</span> : (
        <div className="flex items-center gap-1">
          <Button
            variant="ghost" size="icon"
            className="h-8 w-8 text-muted-foreground hover:text-primary"
            title="Reset password"
            onClick={() => { setResetTarget(u); setNewPassword(''); }}
          >
            <KeyRound className="w-3.5 h-3.5" />
          </Button>
          <Button
            variant="ghost" size="icon"
            className="h-8 w-8 text-primary"
            title="Save changes"
            disabled={!isDirty(u.id) || savingId === u.id}
            onClick={() => handleSave(u)}
          >
            <Save className="w-3.5 h-3.5" />
          </Button>
          {u.id !== sessionUser?.id && (
            <Button
              variant="ghost" size="icon"
              className="h-8 w-8 text-destructive"
              title="Delete user"
              onClick={() => handleDelete(u)}
            >
              <Trash2 className="w-3.5 h-3.5" />
            </Button>
          )}
        </div>
      )),
    },
  ];

  return (
    <div className="space-y-4 bg-card p-4 sm:p-6 rounded-xl border shadow-sm">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <UserCog className="w-5 h-5 text-primary" />
          <h2 className="text-lg font-semibold">User Accounts</h2>
          <span className="text-xs text-muted-foreground ml-1">({users.length} users)</span>
        </div>
        <div className="flex gap-2">
          {/* Add User is always available — creating a user isn't an "edit" of the list */}
          <Button size="sm" variant="outline" onClick={() => setDialogOpen(true)}>
            <Plus className="w-4 h-4 mr-1" /> Add User
          </Button>
          {editing ? (
            <Button size="sm" onClick={handleDone}>
              <Check className="w-4 h-4 mr-1" /> Done
            </Button>
          ) : (
            <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
              <Pencil className="w-4 h-4 mr-1" /> Edit
            </Button>
          )}
        </div>
      </div>

      <SettingsTable
        rows={users}
        columns={columns}
        rowKey={(u) => u.id}
        disabled={!editing}
        storageKey="settings-users-colorder"
        emptyText="No users yet."
        rowClassName={(u) => (u.id === sessionUser?.id ? 'bg-primary/5' : undefined)}
      />

      {/* ── Add User dialog ── */}
      {/* modal={false}: the Base-UI Selects portal to <body>, outside Radix's focus
          trap — with a modal dialog the trap refocuses on open and the list flashes
          shut. Non-modal drops the trap (overlay still dims/blocks); the guards below
          keep the dialog open when a Select option is clicked. */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen} modal={false}>
        <DialogContent className="max-w-md" onInteractOutside={keepOpenForSelect} onFocusOutside={keepOpenForSelect} onPointerDownOutside={keepOpenForSelect}>
          <DialogHeader>
            <DialogTitle>Add New User</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Full Name</label>
              <Input
                placeholder="Jane Smith"
                value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Email</label>
              <Input
                type="email"
                placeholder="jane@company.com"
                value={form.email}
                onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Temporary Password</label>
              <div className="relative">
                <Input
                  type={showPassword ? 'text' : 'password'}
                  placeholder="Min. 8 characters"
                  value={form.password}
                  onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
                  className="pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(p => !p)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              <p className="text-[11px] text-muted-foreground">User will be prompted to change this on first login.</p>
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Role</label>
              <Select value={form.role} onValueChange={v => setForm(f => ({ ...f, role: v ?? f.role, supplier: '' }))}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {roleOptions.map((r: string) => <SelectItem key={r} value={r}>{r}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            {form.role === 'Vendor' && (
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Supplier</label>
                <Select value={form.supplier} onValueChange={v => setForm(f => ({ ...f, supplier: v }))}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Select supplier" />
                  </SelectTrigger>
                  <SelectContent>
                    {suppliers.map((s: any) => (
                      <SelectItem key={s.id} value={s.name}>{s.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleCreate} disabled={isCreating}>
              {isCreating ? 'Creating...' : 'Create User'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Reset Password dialog ── */}
      <Dialog open={!!resetTarget} onOpenChange={open => !open && setResetTarget(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Reset Password — {resetTarget?.name}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">New Password</label>
              <div className="relative">
                <Input
                  type={showNewPassword ? 'text' : 'password'}
                  placeholder="Min. 8 characters"
                  value={newPassword}
                  onChange={e => setNewPassword(e.target.value)}
                  className="pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowNewPassword(p => !p)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  {showNewPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              <p className="text-[11px] text-muted-foreground">User will be prompted to change this on next login.</p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setResetTarget(null)}>Cancel</Button>
            <Button onClick={handleResetPassword} disabled={isResetting}>
              {isResetting ? 'Resetting...' : 'Reset Password'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
