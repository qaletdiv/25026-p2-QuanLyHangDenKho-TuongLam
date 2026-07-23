'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ArrowUp, ArrowDown, ChevronsUpDown, Search, ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import ColumnPicker from './ColumnPicker';

export type DataColumn<T> = {
  key: string;
  label: string;
  align?: 'right';
  sortable?: boolean;                                   // default true
  defaultVisible?: boolean;                             // default true; hidden columns stay selectable in the picker
  accessor?: (row: T) => string | number | null | undefined;  // sort + search + default cell
  render?: (row: T) => ReactNode;                       // overrides cell display
};

type Props<T> = {
  rows: T[];
  columns: DataColumn<T>[];
  rowKey: (row: T) => string;
  title?: string;   // omit to drop the heading (e.g. when a tab strip labels the page)
  noun?: string;                       // e.g. "PO split", "booking", "shipment"
  toolbar?: ReactNode;                 // right-side buttons (sync/upload/new…)
  searchPlaceholder?: string;
  pageSize?: number;
  emptyText?: string;
  initialSort?: { key: string; dir: 'asc' | 'desc' };
  onRowClick?: (row: T) => void;       // whole-row navigation; cells with links should stopPropagation
  storageKey?: string;                 // localStorage key persisting the user's column selection
};

const rawVal = <T,>(col: DataColumn<T>, row: T) =>
  col.accessor ? col.accessor(row) : (row as Record<string, unknown>)[col.key] as string | number | null | undefined;

export default function DataTable<T>({
  rows, columns, rowKey, title, noun = 'row', toolbar,
  searchPlaceholder = 'Search…', pageSize = 10, emptyText = 'No matching rows', initialSort, onRowClick, storageKey,
}: Props<T>) {
  const dragKey = useRef<string | null>(null);
  const colByKey = useMemo(() => Object.fromEntries(columns.map((c) => [c.key, c])) as Record<string, DataColumn<T>>, [columns]);

  const [order, setOrder] = useState<string[]>(columns.map((c) => c.key));
  const [visible, setVisible] = useState<string[]>(columns.filter((c) => c.defaultVisible !== false).map((c) => c.key));
  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' } | null>(initialSort ?? null);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);

  useEffect(() => { setPage(1); }, [search]);
  // keep column order in sync if the column set changes
  useEffect(() => { setOrder(columns.map((c) => c.key)); }, [columns]);
  // restore the saved column selection after mount (localStorage is client-only)
  useEffect(() => {
    if (!storageKey) return;
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) || 'null');
      if (Array.isArray(saved)) {
        const valid = saved.filter((k): k is string => typeof k === 'string' && !!colByKey[k]);
        if (valid.length) setVisible(valid);
      }
    } catch { /* corrupt pref — keep defaults */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    let out = q
      ? rows.filter((r) => columns.some((c) => String(rawVal(c, r) ?? '').toLowerCase().includes(q)))
      : rows;
    if (sort) {
      const col = colByKey[sort.key];
      out = [...out].sort((a, b) => {
        const av = rawVal(col, a), bv = rawVal(col, b);
        const cmp = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av ?? '').localeCompare(String(bv ?? ''));
        return sort.dir === 'asc' ? cmp : -cmp;
      });
    }
    return out;
  }, [rows, columns, colByKey, search, sort]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const current = Math.min(page, totalPages);
  const paginated = filtered.slice((current - 1) * pageSize, current * pageSize);
  const fromRow = filtered.length === 0 ? 0 : (current - 1) * pageSize + 1;
  const toRow = Math.min(current * pageSize, filtered.length);

  const visibleOrder = order.filter((k) => visible.includes(k) && colByKey[k]);

  function toggleColumn(key: string) {
    setVisible((prev) => {
      const next = prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key];
      if (next.length === 0) return prev; // keep at least one column visible
      if (storageKey) { try { localStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* quota/private mode */ } }
      return next;
    });
  }
  function toggleSort(key: string) {
    if (colByKey[key]?.sortable === false) return;
    setSort((s) => (s?.key !== key ? { key, dir: 'asc' } : s.dir === 'asc' ? { key, dir: 'desc' } : null));
  }
  function onDrop(target: string) {
    const from = dragKey.current;
    dragKey.current = null;
    if (!from || from === target) return;
    setOrder((prev) => { const next = prev.filter((k) => k !== from); next.splice(next.indexOf(target), 0, from); return next; });
  }

  return (
    <div className="p-4 md:p-6 space-y-4">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          {title && <h1 className="text-xl sm:text-2xl font-semibold tracking-tight">{title}</h1>}
          <p className="text-sm text-muted-foreground">{filtered.length}{search ? ` of ${rows.length}` : ''} {noun}{filtered.length === 1 ? '' : 's'}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {toolbar}
          <ColumnPicker columns={columns.map((c) => ({ key: c.key, label: c.label }))} visible={visible} onToggle={toggleColumn} />
          <div className="relative w-full sm:w-64">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input className="pl-8" placeholder={searchPlaceholder} value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
        </div>
      </div>

      <Card className="overflow-x-auto">
        <Table className="bg-card">
          <TableHeader>
            <TableRow className="bg-card/80 hover:bg-card/80">
              {visibleOrder.map((key) => {
                const col = colByKey[key];
                if (!col) return null;
                const sorted = sort?.key === key;
                const sortable = col.sortable !== false;
                return (
                  <TableHead
                    key={key}
                    draggable
                    onDragStart={() => { dragKey.current = key; }}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={() => onDrop(key)}
                    className={cn('cursor-move select-none whitespace-nowrap', col.align === 'right' && 'text-right')}
                  >
                    <button onClick={() => toggleSort(key)} disabled={!sortable}
                      className={cn('inline-flex items-center gap-1', sortable && 'hover:text-foreground', col.align === 'right' && 'flex-row-reverse', !sortable && 'cursor-default')}>
                      {col.label}
                      {sortable && (sorted ? (sort!.dir === 'asc' ? <ArrowUp className="h-3.5 w-3.5" /> : <ArrowDown className="h-3.5 w-3.5" />) : <ChevronsUpDown className="h-3.5 w-3.5 opacity-40" />)}
                    </button>
                  </TableHead>
                );
              })}
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.length === 0 ? (
              <TableRow><TableCell colSpan={visibleOrder.length} className="text-center text-muted-foreground py-10">{emptyText}</TableCell></TableRow>
            ) : paginated.map((row) => (
              <TableRow
                key={rowKey(row)}
                className={cn('border-border hover:bg-muted/30', onRowClick && 'cursor-pointer')}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
              >
                {visibleOrder.map((key) => {
                  const col = colByKey[key];
                  if (!col) return null;
                  const content = col.render ? col.render(row) : (() => { const v = rawVal(col, row); return v === null || v === undefined || v === '' ? '—' : String(v); })();
                  return <TableCell key={key} className={cn(col.align === 'right' && 'text-right tabular-nums')}>{content}</TableCell>;
                })}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      {filtered.length > 0 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">Showing {fromRow}–{toRow} of {filtered.length}</p>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" disabled={current <= 1} onClick={() => setPage(current - 1)}><ChevronLeft className="h-4 w-4 mr-1" /> Prev</Button>
            <span className="text-sm text-muted-foreground tabular-nums">Page {current} of {totalPages}</span>
            <Button variant="outline" size="sm" disabled={current >= totalPages} onClick={() => setPage(current + 1)}>Next <ChevronRight className="h-4 w-4 ml-1" /></Button>
          </div>
        </div>
      )}
    </div>
  );
}
