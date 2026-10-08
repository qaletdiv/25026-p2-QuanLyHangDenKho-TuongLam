'use client';

// A table column header that IS its filter: unset it reads the column name,
// set it reads the chosen value. Borderless so it sits in the header like a
// label with a chevron, not a form field. Used by the forecast drill-down and the
// SMS shipment form's PO table.
//
// `value` is 'all' when unset. Options are plain strings (value = label) or
// { value, label } pairs — use pairs when filtering on an ID while showing a
// name (suppliers: filter on supplierId, never the name; see CLAUDE.md).

import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select';
import { cn } from '@/lib/utils';

export type HeaderFilterOption = string | { value: string; label: string };

const toPair = (o: HeaderFilterOption) => (typeof o === 'string' ? { value: o, label: o } : o);

// SelectItem hard-codes `shrink-0 whitespace-nowrap` on its text (ui/select.tsx),
// so a long name would be clipped at the column width. Override it on the direct
// children (*:) so names WRAP inside a list no wider than the column.
const ITEM = 'text-xs py-1 pr-6 leading-tight *:min-w-0 *:shrink *:whitespace-normal *:break-words';

// `size` matches the header it sits in: 'compact' for tiny uppercase headers
// (forecast drill-down), 'default' for a plain TableHead (font-medium, normal size).
const SIZE = {
  compact: { base: 'h-6 text-[10px] font-black uppercase tracking-wider', set: 'normal-case tracking-normal' },
  default: { base: 'h-8 text-sm font-medium', set: '' },
} as const;

export default function HeaderFilter({ label, value, options, onChange, size = 'compact' }: {
  label: string;
  value: string;
  options: HeaderFilterOption[];
  onChange: (v: string) => void;
  size?: keyof typeof SIZE;
}) {
  const pairs = options.map(toPair);
  const shown = value === 'all' ? label : (pairs.find((o) => o.value === value)?.label ?? value);
  return (
    <Select value={value} onValueChange={(v) => onChange(v ?? 'all')}>
      {/* Label rendered directly: SelectValue cannot derive one when the value is
          set programmatically (see CLAUDE.md). */}
      <SelectTrigger
        title={value === 'all' ? `Filter by ${label.toLowerCase()}` : `${label}: ${shown}`}
        className={cn('w-full px-0 gap-1 border-0 bg-transparent dark:bg-transparent shadow-none hover:text-foreground focus-visible:ring-1', SIZE[size].base,
          value === 'all' ? (size === 'compact' ? 'text-muted-foreground' : 'text-foreground') : cn('text-primary', SIZE[size].set))}
        onClick={(e) => e.stopPropagation()}
      >
        <span className="truncate">{shown}</span>
      </SelectTrigger>
      {/* Opens BELOW the header. The default (alignItemWithTrigger) lays the list
          over the trigger to line up the selected option, which covered the header.
          min-w-0 drops the 144px floor so the list is never wider than its column
          (it is already w-(--anchor-width)); long names wrap instead. */}
      <SelectContent alignItemWithTrigger={false} side="bottom" align="start" sideOffset={4} className="min-w-0">
        <SelectItem value="all" className={ITEM}>All {label.toLowerCase()}s</SelectItem>
        {pairs.map((o) => <SelectItem key={o.value} value={o.value} className={ITEM}>{o.label}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}
