'use client';

/**
 * THE REVIEW after an upload: the NRI services on the invoice with the channel and
 * GL the portal will use, PRE-FILLED from the invoice month's settings. The uploader
 * corrects what is wrong and confirms; corrections become that month's settings
 * (they carry forward), and the file is stamped confirmed. Then Cost per GL.
 *
 * Only the services that need a PERSON are shown open (`check`, from the API): no GL
 * yet, a channel the team has changed between months on lines nothing else decides,
 * or a GL the team has changed between months. Everything else — NetSuite order
 * types, exceptions, settings that never moved — is folded under "decided
 * automatically", still editable (Lam, 2026-10-02: "quite a lot of things to verify").
 *
 * QUESTIONS come first (2026-10-05, Lam: "if not sure, portal need to ask users"): lines
 * the portal cannot decide — an order it cannot find, or a wholesale labour line with no
 * order behind it. Nothing is pre-selected and Confirm waits for every answer; an answer
 * is a hand coding on those lines only, never a month setting.
 *
 * The channel shown is the SERVICE's (Rules step 2). Lines decided by order type or
 * an exception are counted and not re-coded by it — the hint says so.
 */

import { useEffect, useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { AlertTriangle, CheckCircle2, ChevronRight, HelpCircle, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { getFileReview, confirmFileReview } from '../actions';
import { money, count } from './shared';
import type { FileReview, ReviewQuestion, ReviewService } from '../types';

const monthName = (ym: string | null) =>
  ym ? new Date(`${ym}-01T00:00:00`).toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) : '—';
const shortDesc = (d: string | null | undefined) => (d ? d.split(':').pop()!.trim() : '—');
const sideName = (v: string) => (v === 'online' ? 'Ecomm' : 'Wholesale');

type Answer = { channel: 'whsle' | 'online'; gl: number | null };
type QAnswer = { channel?: 'whsle' | 'online'; gl?: number };
const WHY: Record<ReviewQuestion['why'], string> = {
  orderNotFound: 'Order not found in NetSuite',
  orderNoType: 'In NetSuite, but with no order type',
  glWholesaleAsk: 'Wholesale, but no order behind it',
};

export default function ReviewDialog({ fileId, open, onClose, goToResults = true }: {
  fileId: string | null; open: boolean; onClose: () => void; goToResults?: boolean;
}) {
  const router = useRouter();
  const [data, setData] = useState<FileReview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  const [qAnswers, setQAnswers] = useState<Record<string, QAnswer>>({});
  const [error, setError] = useState<string | null>(null);
  const [showDecided, setShowDecided] = useState(false);
  const [saving, start] = useTransition();

  useEffect(() => {
    if (!open || !fileId) return;
    let live = true;
    void (async () => {
      const res = await getFileReview(fileId);
      if (!live) return;
      if ('error' in res) { setLoadError(res.error); return; }
      setLoadError(null);
      setData(res);
      setShowDecided(false);
      setAnswers(Object.fromEntries(res.services.map((s) => [s.service, { channel: s.channel, gl: s.gl }])));
      setQAnswers({});
    })();
    return () => { live = false; };
  }, [open, fileId]);

  const desc = useMemo(() => new Map((data?.glOptions ?? []).map((g) => [g.gl, g.glDesc])), [data]);
  const toCheck = useMemo(() => (data?.services ?? []).filter((s) => s.check.length > 0), [data]);
  const decided = useMemo(() => (data?.services ?? []).filter((s) => s.check.length === 0), [data]);
  const ans = (s: ReviewService) => answers[s.service] ?? { channel: s.channel, gl: s.gl };
  const set = (s: ReviewService, p: Partial<Answer>) => setAnswers((a) => ({ ...a, [s.service]: { ...ans(s), ...p } }));
  const missingGl = (data?.services ?? []).filter((s) => ans(s).gl === null);
  const changed = (data?.services ?? []).filter((s) => ans(s).channel !== s.channel || ans(s).gl !== s.gl).length;
  const sum = (rows: ReviewService[], f: (s: ReviewService) => number) => rows.reduce((n, s) => n + f(s), 0);
  const questions = data?.questions ?? [];
  const answered = (q: ReviewQuestion) => (q.kind === 'channel' ? !!qAnswers[q.key]?.channel : qAnswers[q.key]?.gl !== undefined);
  const unanswered = questions.filter((q) => !answered(q));

  const confirm = () => {
    if (!data || !fileId) return;
    if (unanswered.length) return void setError(`Answer the ${unanswered.length} question${unanswered.length === 1 ? '' : 's'} at the top first.`);
    if (missingGl.length) return void setError(`Pick a GL for ${missingGl.map((s) => s.service).join(', ')}.`);
    setError(null);
    start(async () => {
      const res = await confirmFileReview(
        fileId,
        data.services.map((s) => ({ service: s.service, channel: ans(s).channel, gl: ans(s).gl })),
        questions.map((q) => ({ lineIds: q.lineIds, ...qAnswers[q.key] })),
      );
      if ('error' in res) return void setError(res.error);
      const what = [res.channelChanged && `${res.channelChanged} channel${res.channelChanged === 1 ? '' : 's'}`, res.glChanged && `${res.glChanged} GL${res.glChanged === 1 ? '' : 's'}`].filter(Boolean).join(' and ');
      toast.success(`${data.file.fileName} confirmed${what ? ` — ${what} saved for ${monthName(data.month)} on` : ''}.`);
      onClose();
      if (goToResults) router.push(`/invoices/results?entity=${data.file.entity}&files=${encodeURIComponent(fileId)}`);
      else router.refresh();
    });
  };

  const table = (rows: ReviewService[]) => (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="w-full text-sm">
        <thead className="bg-card/80 text-xs text-muted-foreground">
          <tr className="border-b border-border">
            <th className="px-3 py-2 text-left font-medium">Service</th>
            <th className="px-3 py-2 text-left font-medium">Reference</th>
            <th className="px-3 py-2 text-right font-medium">Amount</th>
            <th className="px-3 py-2 text-left font-medium">Channel</th>
            <th className="px-3 py-2 text-left font-medium">GL</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => <Row key={s.service} s={s} a={ans(s)} desc={desc} glOptions={data!.glOptions} onChange={(p) => set(s, p)} />)}
        </tbody>
      </table>
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !saving) onClose(); }}>
      <DialogContent className="flex max-h-[90vh] max-w-5xl flex-col">
        <DialogHeader>
          <DialogTitle>Review services · {data?.file.fileName ?? '…'}</DialogTitle>
          <DialogDescription>
            {data
              ? <>Pre-filled from the settings for <b>{monthName(data.month)}</b>. A change becomes {monthName(data.month)}’s setting and
                {' '}carries forward to later months.</>
              : 'Loading…'}
          </DialogDescription>
        </DialogHeader>

        {loadError && <p className="text-sm text-red-700 dark:text-red-300">{loadError}</p>}
        {!data && !loadError && <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>}

        {data && data.locked && (
          <p className="text-sm text-amber-700 dark:text-amber-300">This file is marked as booked — its coding is fixed. Reopen it on Uploads to review it.</p>
        )}

        {data && !data.locked && (
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto">
            {questions.length > 0 && (
              <section className="space-y-2">
                <h3 className="flex items-center gap-2 text-sm font-semibold">
                  <HelpCircle className="h-4 w-4 text-primary" />
                  Questions · {count(questions.length)}{unanswered.length ? ` · ${count(unanswered.length)} to answer` : ' · all answered'}
                </h3>
                <p className="text-xs text-muted-foreground">
                  The portal could not decide these lines. Each answer codes only the lines it names.
                </p>
                <div className="overflow-x-auto rounded-md border border-border">
                  <table className="w-full text-sm">
                    <thead className="bg-card/80 text-xs text-muted-foreground">
                      <tr className="border-b border-border">
                        <th className="px-3 py-2 text-left font-medium">Reference</th>
                        <th className="px-3 py-2 text-left font-medium">Why</th>
                        <th className="px-3 py-2 text-left font-medium">Services</th>
                        <th className="px-3 py-2 text-right font-medium">Amount</th>
                        <th className="px-3 py-2 text-left font-medium">Answer</th>
                      </tr>
                    </thead>
                    <tbody>
                      {questions.map((q) => (
                        <QuestionRow key={q.key} q={q} a={qAnswers[q.key] ?? {}} desc={desc}
                          onChange={(a) => setQAnswers((x) => ({ ...x, [q.key]: a }))} />
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}
            {toCheck.length > 0 ? (
              <section className="space-y-2">
                <h3 className="flex items-center gap-2 text-sm font-semibold">
                  <AlertTriangle className="h-4 w-4 text-amber-600" />
                  To check · {count(toCheck.length)} service{toCheck.length === 1 ? '' : 's'}
                </h3>
                {table(toCheck)}
              </section>
            ) : (
              <p className="flex items-start gap-2 rounded-md border border-emerald-500/40 bg-emerald-500/5 px-3 py-2 text-sm">
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                Nothing to check — every line on this invoice follows NetSuite, an exception, or a setting the team has never changed.
              </p>
            )}

            {decided.length > 0 && (
              <section className="space-y-2">
                <button type="button" onClick={() => setShowDecided((v) => !v)} aria-expanded={showDecided}
                  className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
                  <ChevronRight className={cn('h-4 w-4 transition-transform', showDecided && 'rotate-90')} />
                  {count(decided.length)} services decided automatically · {count(sum(decided, (s) => s.lines))} lines · {money(sum(decided, (s) => s.charges))}
                </button>
                {showDecided && table(decided)}
              </section>
            )}
          </div>
        )}

        <DialogFooter className="items-center gap-2 sm:justify-between">
          <span className="text-sm">
            {error
              ? <span role="alert" className="text-red-700 dark:text-red-300">{error}</span>
              : data && !data.locked && <span className="text-muted-foreground">{changed ? `${changed} change${changed === 1 ? '' : 's'} to ${monthName(data.month)}’s settings` : 'No changes — confirm the suggestions as they are'}</span>}
          </span>
          <div className="flex gap-2">
            <Button variant="ghost" disabled={saving} onClick={onClose}>Later</Button>
            {data && !data.locked && (
              <Button disabled={saving || unanswered.length > 0} onClick={confirm}
                title={unanswered.length ? `Answer the ${unanswered.length} question${unanswered.length === 1 ? '' : 's'} first` : undefined}>
                {saving && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />} Confirm{goToResults ? ' & view Cost per GL' : ''}
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Row({ s, a, desc, glOptions, onChange }: {
  s: ReviewService; a: Answer; desc: Map<number, string | null>;
  glOptions: { gl: number; glDesc: string | null }[]; onChange: (p: Partial<Answer>) => void;
}) {
  const byColumn = s.lines - s.byOrder;
  const more = s.referenceCount - s.references.length;
  const refText = `${s.references.join(', ')}${more > 0 ? ` +${count(more)} more` : ''}`;

  return (
    <tr className={cn('border-b border-border last:border-0', a.gl === null && 'bg-amber-500/5')}>
      <td className="px-3 py-2 font-medium">{s.service}</td>
      <td className="max-w-64 px-3 py-2 text-muted-foreground">
        <span className="line-clamp-2 break-words" title={refText}>{refText}</span>
      </td>
      <td className="px-3 py-2 text-right tabular-nums">{money(s.charges)}</td>
      <td className="px-3 py-2">
        {byColumn === 0 ? (
          <span className="text-xs text-muted-foreground">By reference</span>
        ) : (
          <div role="radiogroup" aria-label={`${s.service} channel`} className="inline-flex rounded-md border border-border p-0.5">
            {(['whsle', 'online'] as const).map((c) => (
              <button key={c} type="button" role="radio" aria-checked={a.channel === c} onClick={() => onChange({ channel: c })}
                className={cn('rounded px-2.5 py-0.5 text-xs font-medium transition-colors',
                  a.channel === c ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground')}>
                {sideName(c)}
              </button>
            ))}
          </div>
        )}
      </td>
      <td className="px-3 py-2">
        <Select value={a.gl === null ? '' : String(a.gl)} onValueChange={(v) => onChange({ gl: v ? Number(v) : null })}>
          <SelectTrigger className={cn('h-8 w-72', a.gl === null && 'border-amber-500/60')}>
            <span className="min-w-0 flex-1 truncate text-left">{a.gl === null ? 'Choose a GL' : `${a.gl} · ${shortDesc(desc.get(a.gl))}`}</span>
          </SelectTrigger>
          <SelectContent>
            {glOptions.map((g) => (
              <SelectItem key={g.gl} value={String(g.gl)}>{g.gl} · {shortDesc(g.glDesc)}{g.gl === s.legendGl ? ' (legend)' : ''}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </td>
    </tr>
  );
}

function QuestionRow({ q, a, desc, onChange }: {
  q: ReviewQuestion; a: QAnswer; desc: Map<number, string | null>; onChange: (a: QAnswer) => void;
}) {
  const choices: { label: string; title: string; on: boolean; pick: QAnswer }[] = q.kind === 'channel'
    ? (['whsle', 'online'] as const).map((c) => ({ label: sideName(c), title: `Code these ${q.lines} lines ${sideName(c)}`, on: a.channel === c, pick: { channel: c } }))
    : [
      { label: `Fulfilment · ${q.glWholesaleOrder}`, title: shortDesc(desc.get(q.glWholesaleOrder ?? -1)), on: a.gl === q.glWholesaleOrder, pick: { gl: q.glWholesaleOrder ?? undefined } },
      { label: `Extra charge · ${q.gl}`, title: shortDesc(desc.get(q.gl ?? -1)), on: a.gl === q.gl, pick: { gl: q.gl ?? undefined } },
    ];
  const done = choices.some((c) => c.on);
  return (
    <tr className={cn('border-b border-border align-top last:border-0', !done && 'bg-amber-500/5')}>
      <td className="px-3 py-2">
        <div className="font-medium">{q.ref}</div>
        {(q.customer || q.clientRef2) && <div className="text-xs text-muted-foreground">{[q.customer, q.clientRef2].filter(Boolean).join(' · ')}</div>}
      </td>
      <td className="px-3 py-2 text-muted-foreground">{WHY[q.why]}</td>
      <td className="max-w-56 px-3 py-2 text-muted-foreground">
        {q.services.join(', ')} <span className="whitespace-nowrap">· {count(q.lines)} line{q.lines === 1 ? '' : 's'}</span>
      </td>
      <td className="px-3 py-2 text-right tabular-nums">{money(q.charges)}</td>
      <td className="px-3 py-2">
        <div role="radiogroup" aria-label={`${q.ref} answer`} className="inline-flex rounded-md border border-border p-0.5">
          {choices.map((c) => (
            <button key={c.label} type="button" role="radio" aria-checked={c.on} title={c.title} onClick={() => onChange(c.pick)}
              className={cn('whitespace-nowrap rounded px-2.5 py-0.5 text-xs font-medium transition-colors',
                c.on ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground')}>
              {c.label}
            </button>
          ))}
        </div>
      </td>
    </tr>
  );
}
