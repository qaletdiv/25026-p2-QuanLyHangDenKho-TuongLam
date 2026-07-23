'use client';

// Copy a report card (chart + table + legend) to the clipboard AS AN IMAGE, so it
// pastes into PowerPoint/Slides exactly as rendered on screen. Pairs with the
// text CopyButton (which pastes an editable table). Falls back to a PNG download
// when the browser can't write images to the clipboard.

import { useState } from 'react';
import { ImageDown } from 'lucide-react';
import { toast } from 'sonner';

export default function CopyImageButton({ target, name = 'report-card' }: {
  target: React.RefObject<HTMLElement | null>;
  name?: string;
}) {
  const [busy, setBusy] = useState(false);

  async function copy() {
    const node = target.current;
    if (!node) return;
    setBusy(true);
    try {
      const { toBlob } = await import('html-to-image');
      // resolve the card's own background so the PNG isn't transparent on a slide
      const bg = getComputedStyle(node).backgroundColor;
      const blob = await toBlob(node, {
        pixelRatio: 2,            // crisp on high-DPI / when scaled up on a slide
        cacheBust: true,
        backgroundColor: bg && bg !== 'rgba(0, 0, 0, 0)' ? bg : '#ffffff',
      });
      if (!blob) throw new Error('render failed');

      if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        toast.success('Image copied — paste into your slide');
      } else {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = `${name}.png`; a.click();
        URL.revokeObjectURL(url);
        toast.success('Image downloaded (clipboard image not supported here)');
      }
    } catch {
      toast.error('Could not copy image — try the Copy (table) button instead');
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      onClick={copy}
      disabled={busy}
      title="Copy as image (paste the chart into slides exactly as shown)"
      className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-bold uppercase tracking-widest text-muted-foreground border border-border hover:bg-muted hover:text-foreground transition-colors disabled:opacity-60"
    >
      <ImageDown className="w-3.5 h-3.5" /> {busy ? '…' : 'Image'}
    </button>
  );
}
