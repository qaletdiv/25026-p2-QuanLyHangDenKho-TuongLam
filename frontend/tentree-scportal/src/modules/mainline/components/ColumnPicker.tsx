'use client';

import { Check, Settings2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

export type PickerColumn = { key: string; label: string };

export default function ColumnPicker({ columns, visible, onToggle }: {
  columns: PickerColumn[];
  visible: string[];
  onToggle: (key: string) => void;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2 border-dashed">
          <Settings2 className="h-4 w-4" /> Columns
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-2" align="end">
        <h4 className="text-xs font-bold px-2 py-1.5 uppercase text-muted-foreground tracking-wider">Display Fields</h4>
        <div className="max-h-[300px] overflow-y-auto space-y-0.5">
          {columns.map((col) => {
            const on = visible.includes(col.key);
            return (
              <div key={col.key} className="flex items-center gap-2 px-2 py-1.5 hover:bg-muted rounded-md cursor-pointer" onClick={() => onToggle(col.key)}>
                <div className={cn('w-4 h-4 rounded border flex items-center justify-center transition-colors', on ? 'bg-primary border-primary' : 'bg-transparent border-input')}>
                  {on && <Check className="w-3 h-3 text-white" />}
                </div>
                <span className="text-sm font-medium">{col.label}</span>
              </div>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
