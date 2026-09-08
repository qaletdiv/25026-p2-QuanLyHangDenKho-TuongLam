'use client';

// Sortable + drag-reorderable table for the master-data (Settings) screens.
//
// These screens are inline-EDIT grids (a <fieldset disabled> + Save), so they
// can't reuse the read-only mainline DataTable (search/pagination/row-click).
// This gives them the two header behaviours from the bookings/shipments tables:
//   • click a header to sort (asc → desc → original order)
//   • drag a header to move the column (persisted per storageKey)
//
// Two deliberate differences from DataTable:
//   • Row order is a SNAPSHOT taken when you click a header — typing in a cell
//     never reshuffles the row under the cursor, and newly added rows append at
//     the bottom instead of sorting into the middle.
//   • The sort control is a div, not a <button>: the whole table lives inside
//     <fieldset disabled={!editing}>, which would disable a real button and make
//     sorting dead while the screen is locked.

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react';
import { cn } from '@/lib/utils';

export type SettingsColumn<T> = {
  key: string;
  label: string;                    // '' for action columns (no sort affordance)
  headClassName?: string;           // e.g. 'w-[50px]'
  cellClassName?: string;           // e.g. 'font-medium' (cells default to p-2)
  sortable?: boolean;               // default true (false for preview/action columns)
  movable?: boolean;                // default true; false pins the column to its slot
  accessor?: (row: T) => string | number | null | undefined;  // sort value; defaults to row[key]
  cell: (row: T) => ReactNode;
};

type Props<T> = {
  rows: T[];
  columns: SettingsColumn<T>[];
  rowKey: (row: T) => string;
  disabled?: boolean;               // wraps the table in the master-data <fieldset disabled>
  storageKey?: string;              // localStorage key persisting the column order
  emptyText?: string;               // shown as a full-width row when there are no rows
  rowClassName?: (row: T) => string | undefined;
  footerCells?: Record<string, ReactNode>;  // extra trailing row, keyed by column — follows the column order
};

const FIELDSET_CLASS =
  'm-0 p-0 min-w-0 border rounded-md overflow-hidden [&_input:disabled]:opacity-100 [&_input:disabled]:cursor-default [&_input:disabled]:border-transparent [&_input:disabled]:bg-transparent [&_input:disabled]:shadow-none';

export function SettingsTable<T>({
  rows, columns, rowKey, disabled, storageKey, emptyText, rowClassName, footerCells,
}: Props<T>) {
  const dragKey = useRef<string | null>(null);

  const colByKey = useMemo(
    () => Object.fromEntries(columns.map((c) => [c.key, c])) as Record<string, SettingsColumn<T>>,
    [columns],
  );
  const movableKeys = useMemo(() => columns.filter((c) => c.movable !== false).map((c) => c.key), [columns]);
  const movableSig = movableKeys.join('|');

  const [movableOrder, setMovableOrder] = useState<string[]>(movableKeys);
  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' } | null>(null);
  // Row ids in sorted order, captured when a header is clicked. Rows are ranked
  // against this snapshot, so editing a cell can't reshuffle the row you're in
  // and rows added afterwards fall to the bottom. null = natural order.
  const [sortedIds, setSortedIds] = useState<string[] | null>(null);

  // restore the saved column order after mount (localStorage is client-only)
  useEffect(() => {
    const keys = movableSig ? movableSig.split('|') : [];
    let restored: string[] | null = null;
    if (storageKey) {
      try {
        const saved = JSON.parse(localStorage.getItem(storageKey) || 'null');
        if (Array.isArray(saved)) {
          const valid = saved.filter((k: unknown): k is string => typeof k === 'string' && keys.includes(k));
          if (valid.length === keys.length) restored = valid;   // ignore stale prefs after a column change
        }
      } catch { /* corrupt pref — keep defaults */ }
    }
    if (restored) setMovableOrder(restored);   // no saved pref → keep the declared order
  }, [storageKey, movableSig]);

  // Columns in display order: pinned columns keep their slot, movable ones fill
  // the remaining slots in the user's order.
  const ordered = useMemo(() => {
    const queue = movableOrder.filter((k) => colByKey[k] && colByKey[k].movable !== false);
    movableKeys.forEach((k) => { if (!queue.includes(k)) queue.push(k); });   // newly added columns land last
    let i = 0;
    return columns.map((c) => (c.movable === false ? c : colByKey[queue[i++]] ?? c));
  }, [columns, colByKey, movableKeys, movableOrder]);

  // Rank each row against the snapshot; rows missing from it (added since the
  // sort) keep their natural order at the bottom. Pure — no effect, no sync.
  const displayRows = useMemo(() => {
    if (!sortedIds) return rows;
    const rank = new Map(sortedIds.map((id, i) => [id, i]));
    const tail = sortedIds.length;
    return rows
      .map((r, i) => ({ r, k: rank.get(rowKey(r)) ?? tail + i }))
      .sort((a, b) => a.k - b.k)
      .map((x) => x.r);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, sortedIds]);

  function toggleSort(col: SettingsColumn<T>) {
    if (col.sortable === false || !col.label) return;
    const dir: 'asc' | 'desc' | null =
      sort?.key !== col.key ? 'asc' : sort.dir === 'asc' ? 'desc' : null;
    if (!dir) { setSort(null); setSortedIds(null); return; }   // third click = original order
    const val = (r: T) => (col.accessor ? col.accessor(r) : (r as Record<string, unknown>)[col.key] as string | number | null | undefined);
    const sorted = [...rows].sort((a, b) => {
      const av = val(a), bv = val(b);
      const cmp = typeof av === 'number' && typeof bv === 'number'
        ? av - bv
        : String(av ?? '').localeCompare(String(bv ?? ''));
      return dir === 'asc' ? cmp : -cmp;
    });
    setSort({ key: col.key, dir });
    setSortedIds(sorted.map(rowKey));
  }

  function onDrop(target: SettingsColumn<T>) {
    const from = dragKey.current;
    dragKey.current = null;
    if (!from || from === target.key || target.movable === false) return;
    setMovableOrder((prev) => {
      const base = prev.filter((k) => movableKeys.includes(k));
      movableKeys.forEach((k) => { if (!base.includes(k)) base.push(k); });
      const next = base.filter((k) => k !== from);
      const at = next.indexOf(target.key);
      next.splice(at < 0 ? next.length : at, 0, from);
      if (storageKey) { try { localStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* quota/private mode */ } }
      return next;
    });
  }

  const table = (
    <Table>
      <TableHeader className="bg-muted/50">
        <TableRow>
          {ordered.map((col) => {
            const movable = col.movable !== false;
            const sortable = col.sortable !== false && !!col.label;
            const sorted = sort?.key === col.key;
            return (
              <TableHead
                key={col.key}
                draggable={movable}
                onDragStart={movable ? () => { dragKey.current = col.key; } : undefined}
                onDragOver={movable ? (e) => e.preventDefault() : undefined}
                onDrop={movable ? () => onDrop(col) : undefined}
                className={cn(movable && 'cursor-move select-none', col.headClassName)}
              >
                {sortable ? (
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => toggleSort(col)}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleSort(col); } }}
                    className="inline-flex cursor-pointer items-center gap-1 hover:text-foreground"
                  >
                    {col.label}
                    {sorted
                      ? (sort!.dir === 'asc' ? <ArrowUp className="h-3.5 w-3.5" /> : <ArrowDown className="h-3.5 w-3.5" />)
                      : <ChevronsUpDown className="h-3.5 w-3.5 opacity-40" />}
                  </div>
                ) : col.label}
              </TableHead>
            );
          })}
        </TableRow>
      </TableHeader>
      <TableBody>
        {displayRows.length === 0 && emptyText && (
          <TableRow>
            <TableCell colSpan={ordered.length} className="py-6 text-center text-sm text-muted-foreground">{emptyText}</TableCell>
          </TableRow>
        )}
        {displayRows.map((row) => (
          <TableRow key={rowKey(row)} className={rowClassName?.(row)}>
            {ordered.map((col) => (
              <TableCell key={col.key} className={cn('p-2', col.cellClassName)}>{col.cell(row)}</TableCell>
            ))}
          </TableRow>
        ))}
        {footerCells && (
          <TableRow>
            {ordered.map((col) => (
              <TableCell key={col.key} className={cn('p-2', col.cellClassName)}>{footerCells[col.key] ?? null}</TableCell>
            ))}
          </TableRow>
        )}
      </TableBody>
    </Table>
  );

  if (disabled === undefined) return <div className={FIELDSET_CLASS}>{table}</div>;
  return <fieldset disabled={disabled} className={FIELDSET_CLASS}>{table}</fieldset>;
}
