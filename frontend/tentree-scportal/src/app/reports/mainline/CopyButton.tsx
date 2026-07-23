'use client';

// Copy a report card as a real table. The clipboard gets BOTH text/html (pastes
// into PowerPoint / Google Slides / Word as a formatted table) and text/plain TSV
// (pastes into Excel / Sheets as cells) — for the weekly slide deck.

import { Copy } from 'lucide-react';
import { toast } from 'sonner';

type Cell = string | number | null | undefined;

const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export async function copyTable(headers: string[], rows: Cell[][]) {
  const txt = (v: Cell) => String(v ?? '');
  const tsv = [headers, ...rows].map((r) => r.map(txt).join('\t')).join('\n');
  const html =
    '<table><thead><tr>' + headers.map((h) => `<th>${escHtml(h)}</th>`).join('') + '</tr></thead><tbody>' +
    rows.map((r) => '<tr>' + r.map((c) => `<td>${escHtml(txt(c))}</td>`).join('') + '</tr>').join('') +
    '</tbody></table>';
  try {
    if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
      await navigator.clipboard.write([new ClipboardItem({
        'text/html':  new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([tsv],  { type: 'text/plain' }),
      })]);
    } else {
      await navigator.clipboard.writeText(tsv);
    }
    toast.success('Copied — paste into your slide or sheet');
  } catch {
    toast.error('Copy failed — your browser may be blocking clipboard access');
  }
}

export default function CopyButton({ onCopy }: { onCopy: () => void }) {
  return (
    <button
      onClick={onCopy}
      title="Copy as table (paste into slides or a spreadsheet)"
      className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-bold uppercase tracking-widest text-muted-foreground border border-border hover:bg-muted hover:text-foreground transition-colors"
    >
      <Copy className="w-3.5 h-3.5" /> Copy
    </button>
  );
}
