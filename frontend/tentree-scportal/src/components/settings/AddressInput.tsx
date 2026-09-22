'use client';

// A multi-line master-data field — addresses, and anything else printed as a block
// on the Commercial Invoice or Packing List.
//
// It MUST be a textarea, not an <Input>. A browser collapses newlines to spaces
// when you paste into a single-line input, so a consignee block pasted as eight
// lines was stored as one 230-character line and printed as one line, while the
// Notify Party — the only such field already backed by a textarea — came out
// correctly. That difference is what surfaced the bug (2026-09-16).
//
// The generators split on newlines and grow the row to fit, so whatever line
// breaks are typed here are what the document shows.

import { Textarea } from '@/components/ui/textarea';

export function AddressInput({ value, onChange, placeholder }: {
  value: string | null | undefined;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  return (
    <Textarea
      value={value || ''}
      onChange={(e) => onChange(e.target.value)}
      rows={3}
      placeholder={placeholder}
      // min-w so the column doesn't collapse in a dense settings table, and
      // whitespace-pre-wrap so typed line breaks are visible while editing.
      className="min-w-[16rem] text-sm whitespace-pre-wrap"
    />
  );
}
