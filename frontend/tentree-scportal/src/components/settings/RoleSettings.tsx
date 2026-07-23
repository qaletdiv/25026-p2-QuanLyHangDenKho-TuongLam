'use client';

import React, { useState, useEffect } from 'react';
import { getRoles, createRole, updateRole, deleteRole } from '@/app/actions/roles';
import { PERMISSION_MANIFEST } from '@/lib/permissions';
import { useSession } from '@/components/providers/SessionProvider';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import { Plus, Trash2, Save, ShieldCheck, Lock, Pencil, Check } from 'lucide-react';
import { cn } from '@/lib/utils';

export function RoleSettings() {
  const { user: sessionUser } = useSession();
  const [roles, setRoles] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);   // matrix is read-only until Edit

  // Track dirty permissions per role: { [roleId]: Set<string> | null (= no changes) }
  const [dirtyPerms, setDirtyPerms] = useState<Record<string, Set<string>>>({});

  // Add role dialog
  const [dialogOpen, setDialogOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [isCreating, setIsCreating] = useState(false);

  useEffect(() => {
    getRoles().then(data => {
      if (!Array.isArray(data)) {
        toast.error(`Failed to load roles: ${(data as any)?.error || 'Unknown error'}`);
        setIsLoading(false);
        return;
      }
      setRoles(data);
      // Initialise dirty map with current permission sets
      const initial: Record<string, Set<string>> = {};
      data.forEach((r: any) => { initial[r.id] = new Set(r.permissions || []); });
      setDirtyPerms(initial);
      setIsLoading(false);
    });
  }, []);

  const toggle = (roleId: string, permKey: string) => {
    setDirtyPerms(prev => {
      const next = { ...prev };
      const set = new Set(next[roleId] || []);
      if (set.has(permKey)) set.delete(permKey);
      else set.add(permKey);
      next[roleId] = set;
      return next;
    });
  };

  const isDirty = (roleId: string) => {
    const role = roles.find(r => r.id === roleId);
    if (!role) return false;
    const original = new Set(role.permissions || []);
    const current  = dirtyPerms[roleId] || new Set();
    if (original.size !== current.size) return true;
    for (const p of current) if (!original.has(p)) return true;
    return false;
  };

  // Done: re-lock and revert any unsaved permission toggles to the saved sets.
  const handleDone = () => {
    const reset: Record<string, Set<string>> = {};
    roles.forEach((r: any) => { reset[r.id] = new Set(r.permissions || []); });
    setDirtyPerms(reset);
    setEditing(false);
  };

  const handleSave = async (role: any) => {
    if (!isDirty(role.id)) return;
    setSavingId(role.id);
    try {
      const permissions = Array.from(dirtyPerms[role.id] || []);
      const result = await updateRole(role.id, { permissions });
      if (result?.error) throw new Error(result.error);
      setRoles(prev => prev.map(r => r.id === role.id ? { ...r, permissions } : r));
      toast.success(`"${role.name}" permissions saved.`);
    } catch (e: any) {
      toast.error(e.message || 'Failed to save permissions.');
    } finally {
      setSavingId(null);
    }
  };

  const handleDelete = async (role: any) => {
    if (role.protected) { toast.error(`"${role.name}" is a protected role and cannot be deleted.`); return; }
    if (!confirm(`Delete role "${role.name}"? Users with this role must be reassigned first.`)) return;
    try {
      const result = await deleteRole(role.id);
      if (result?.error) throw new Error(result.error);
      setRoles(prev => prev.filter(r => r.id !== role.id));
      toast.success(`Role "${role.name}" deleted.`);
    } catch (e: any) {
      toast.error(e.message || 'Failed to delete role.');
    }
  };

  const handleCreate = async () => {
    if (!newName.trim()) { toast.error('Role name is required.'); return; }
    setIsCreating(true);
    try {
      const result = await createRole({ name: newName.trim(), description: newDesc.trim(), permissions: [] });
      if (result?.error) throw new Error(result.error);
      setRoles(prev => [...prev, result]);
      setDirtyPerms(prev => ({ ...prev, [result.id]: new Set() }));
      setDialogOpen(false);
      setNewName(''); setNewDesc('');
      toast.success(`Role "${result.name}" created. Assign permissions and save.`);
    } catch (e: any) {
      toast.error(e.message || 'Failed to create role.');
    } finally {
      setIsCreating(false);
    }
  };

  if (sessionUser?.role !== 'Admin') {
    return <p className="text-sm text-muted-foreground italic p-4">Admin access required.</p>;
  }
  if (isLoading) return <div className="p-4 text-sm text-muted-foreground italic">Loading roles...</div>;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="bg-card p-4 sm:p-6 rounded-xl border shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-primary" />
            <h2 className="text-lg font-semibold">Role Permissions</h2>
          </div>
          {editing ? (
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => setDialogOpen(true)}>
                <Plus className="w-4 h-4 mr-1" /> Add Role
              </Button>
              <Button size="sm" onClick={handleDone}>
                <Check className="w-4 h-4 mr-1" /> Done
              </Button>
            </div>
          ) : (
            <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
              <Pencil className="w-4 h-4 mr-1" /> Edit
            </Button>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          Changes take effect on the user's next login.
          <span className="ml-2 inline-flex items-center gap-1 text-amber-600"><Lock className="w-3 h-3" /> Protected roles cannot be renamed or deleted.</span>
        </p>
      </div>

      {/* Permission Matrix — read-only until Edit (checkboxes stay readable) */}
      <fieldset disabled={!editing} className="m-0 p-0 min-w-0 bg-card rounded-xl border shadow-sm overflow-x-auto [&_button:disabled]:opacity-100 [&_button:disabled]:cursor-default">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="border-b border-border bg-muted/40">
              {/* Spacer for permission label column */}
              <th className="text-left px-4 py-3 font-semibold text-muted-foreground w-56 min-w-[14rem]">Permission</th>
              {roles.map(role => (
                <th key={role.id} className="px-3 py-3 text-center min-w-[140px]">
                  <div className="flex flex-col items-center gap-1.5">
                    <div className="flex items-center gap-1">
                      {role.protected && <Lock className="w-3 h-3 text-muted-foreground" />}
                      <span className="font-semibold text-foreground">{role.name}</span>
                    </div>
                    {role.description && (
                      <span className="text-[10px] text-muted-foreground font-normal leading-tight max-w-[120px] text-center">{role.description}</span>
                    )}
                    {editing && (
                      <div className="flex gap-1 mt-0.5">
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-6 px-2 text-[10px]"
                          disabled={!isDirty(role.id) || savingId === role.id}
                          onClick={() => handleSave(role)}
                        >
                          <Save className="w-3 h-3 mr-0.5" />
                          {savingId === role.id ? 'Saving…' : 'Save'}
                        </Button>
                        {!role.protected && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-6 w-6 p-0 text-destructive hover:bg-destructive/10"
                            onClick={() => handleDelete(role)}
                            title={`Delete ${role.name}`}
                          >
                            <Trash2 className="w-3 h-3" />
                          </Button>
                        )}
                      </div>
                    )}
                    {editing && isDirty(role.id) && (
                      <Badge variant="outline" className="text-[9px] px-1.5 py-0 bg-amber-500/10 border-amber-400/40 text-amber-600">unsaved</Badge>
                    )}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {PERMISSION_MANIFEST.map(group => (
              <React.Fragment key={group.category}>
                {/* Category header row */}
                <tr className="bg-muted/20 border-b border-border/50">
                  <td
                    colSpan={roles.length + 1}
                    className="px-4 py-1.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground"
                  >
                    {group.category}
                  </td>
                </tr>
                {group.items.map(perm => (
                  <tr key={perm.key} className="border-b border-border/30 hover:bg-muted/10 transition-colors">
                    <td className="px-4 py-2.5 text-sm text-foreground">{perm.label}</td>
                    {roles.map(role => {
                      const checked = dirtyPerms[role.id]?.has(perm.key) ?? false;
                      return (
                        <td key={role.id} className="px-3 py-2.5 text-center">
                          <Checkbox
                            checked={checked}
                            onCheckedChange={() => toggle(role.id, perm.key)}
                            className={cn(
                              checked ? 'border-primary' : 'border-border',
                              'data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground'
                            )}
                          />
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </fieldset>

      {/* Add Role dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Add New Role</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Role Name</label>
              <Input placeholder="e.g. Warehouse Manager" value={newName} onChange={e => setNewName(e.target.value)} />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Description</label>
              <Input placeholder="Optional short description" value={newDesc} onChange={e => setNewDesc(e.target.value)} />
            </div>
            <p className="text-[11px] text-muted-foreground">The role will be created with no permissions. Assign them after creation.</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleCreate} disabled={isCreating}>
              {isCreating ? 'Creating…' : 'Create Role'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
