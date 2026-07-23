'use client';

// Master-data screens are READ-ONLY until the user clicks Edit. Locked: just an
// "Edit" button. Editing: Cancel (revert) · Add · Save. Pair this with a
// <fieldset disabled={!editing}> around the table so every input/select/delete
// inside is natively disabled while locked.

import { Button } from '@/components/ui/button';
import { Pencil, Save, Plus, X } from 'lucide-react';

export function EditLockActions({ editing, onEdit, onCancel, onAdd, onSave }: {
  editing: boolean;
  onEdit: () => void;
  onCancel: () => void;
  onAdd?: () => void;
  onSave: () => void;
}) {
  if (!editing) {
    return (
      <Button size="sm" variant="outline" onClick={onEdit}>
        <Pencil className="w-4 h-4 mr-1" /> Edit
      </Button>
    );
  }
  return (
    <div className="flex gap-2">
      <Button size="sm" variant="ghost" onClick={onCancel}>
        <X className="w-4 h-4 mr-1" /> Cancel
      </Button>
      {onAdd && (
        <Button size="sm" variant="outline" onClick={onAdd}>
          <Plus className="w-4 h-4 mr-1" /> Add
        </Button>
      )}
      <Button size="sm" onClick={onSave}>
        <Save className="w-4 h-4 mr-1" /> Save
      </Button>
    </div>
  );
}
