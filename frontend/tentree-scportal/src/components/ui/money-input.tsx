'use client';

// A money field that shows thousands separators WHILE you type: 1476.33 reads
// "1,476.33", so a mistyped 14,763.30 is obvious at a glance instead of being a
// digit count you have to do by eye.
//
// Why not `<Input type="number">` (which is what the landed-cost fields used):
// a number input's value must be a valid floating-point literal, so a browser
// will not render group separators in it — there is no formatting hook at all.
// Hence type="text" + inputMode="decimal" (mobile still gets the numeric
// keypad) with the grouping done here.
//
// The RAW value is the source of truth: `value` takes and `onValueChange` emits
// a comma-free string ("1476.33"), so callers keep doing `Number(value)` on save
// and nothing downstream has to know this component exists. Only the display
// carries commas.

import * as React from 'react';
import { Input } from '@/components/ui/input';

/** Group the integer part; the decimals are left exactly as typed. */
export function groupThousands(raw: string): string {
  if (!raw) return '';
  const dot = raw.indexOf('.');
  const int = dot === -1 ? raw : raw.slice(0, dot);
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return dot === -1 ? grouped : `${grouped}.${raw.slice(dot + 1)}`;
}

/**
 * Digits and at most ONE decimal point, capped at `maxDecimals`, no sign.
 * Also drops redundant leading zeros ("0012" → "12") so grouping can't produce
 * "0,012", while keeping "0.5" and a lone "0" intact.
 */
export function sanitizeAmount(input: string, maxDecimals = 2): string {
  const cleaned = input.replace(/[^\d.]/g, '');
  const dot = cleaned.indexOf('.');
  const int = (dot === -1 ? cleaned : cleaned.slice(0, dot)).replace(/^0+(?=\d)/, '');
  if (dot === -1) return int;
  const dec = cleaned.slice(dot + 1).replace(/\./g, '').slice(0, maxDecimals);
  return `${int}.${dec}`;
}

// Caret bookkeeping: commas are inserted and removed as you type, so a fixed
// character offset drifts. Count the SIGNIFICANT characters (digits + the dot)
// before the caret and put it back after the same number of them.
const significantBefore = (s: string, caret: number) =>
  (s.slice(0, caret).match(/[\d.]/g) || []).length;

function caretAfterSignificant(formatted: string, count: number): number {
  if (count <= 0) return 0;
  let seen = 0;
  for (let i = 0; i < formatted.length; i += 1) {
    if (/[\d.]/.test(formatted[i])) seen += 1;
    if (seen === count) return i + 1;
  }
  return formatted.length;
}

type Props = Omit<React.ComponentProps<typeof Input>, 'value' | 'onChange' | 'type' | 'inputMode'> & {
  /** raw, comma-free numeric string ('' when empty) */
  value: string;
  /** receives the raw, comma-free string */
  onValueChange: (raw: string) => void;
  maxDecimals?: number;
};

export function MoneyInput({ value, onValueChange, maxDecimals = 2, ...rest }: Props) {
  // The element is captured from the change event rather than through a ref:
  // `Input` wraps a Base UI primitive, so ref forwarding is its business, not
  // something the caret logic should depend on.
  const el = React.useRef<HTMLInputElement | null>(null);
  const pendingCaret = React.useRef<number | null>(null);
  const display = groupThousands(value);

  // Restore the caret after React has committed the re-grouped value — otherwise
  // typing into the middle of a number jumps to the end on every keystroke.
  React.useLayoutEffect(() => {
    const node = el.current;
    if (!node || pendingCaret.current === null) return;
    const pos = caretAfterSignificant(node.value, pendingCaret.current);
    pendingCaret.current = null;
    node.setSelectionRange(pos, pos);
  }, [display]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const node = e.currentTarget;
    el.current = node;
    const caret = significantBefore(node.value, node.selectionStart ?? node.value.length);
    const raw = sanitizeAmount(node.value, maxDecimals);
    if (raw === value) {
      // Keystroke rejected (a letter, a second dot): the controlled value doesn't
      // change, so there is no re-render and the layout effect never runs. Repaint
      // the display ourselves and put the caret back where it was.
      node.value = display;
      const pos = caretAfterSignificant(display, caret);
      node.setSelectionRange(pos, pos);
      return;
    }
    pendingCaret.current = caret;
    onValueChange(raw);
  };

  return (
    <Input
      {...rest}
      type="text"
      inputMode="decimal"
      autoComplete="off"
      value={display}
      onChange={handleChange}
    />
  );
}
