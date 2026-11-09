/**
 * `show` figures as Tern wire nodes ({k, p, c}): math, tables, charts, stat grids,
 * verdicts, callouts, code, diffs, checklists, plots and images. Ported from
 * saavy's tern/show.ts. Plots are drawn to SVG files and images stay paths: the
 * tern-ui block turns `image` nodes with a `path` into blobs on its own machine.
 */
import { writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { plotSvg, type Plot } from './plot.ts';

export interface Node {
   k: string;
   p: Record<string, unknown>;
   c?: Node[];
}

/** A wire node; null children are dropped. */
export const n = (k: string, p: Record<string, unknown>, c?: (Node | null | undefined)[]): Node => {
   const kids = c?.filter((x): x is Node => x != null);
   return kids ? { k, p, c: kids } : { k, p };
};

type Tone = 'note' | 'info' | 'success' | 'warning' | 'error' | 'accent';
type Cell = string | number | { text: string | number; tone?: Tone; bold?: boolean; href?: string };

export type Leaf =
   | { type: 'markdown'; text: string }
   | { type: 'math'; tex: string; display?: boolean }
   | { type: 'code'; code: string; lang?: string; title?: string; highlight?: number[] }
   | { type: 'table'; columns: string[]; rows: Cell[][]; align?: ('start' | 'center' | 'end')[] }
   | {
        type: 'chart';
        kind: 'bars' | 'heatmap' | 'spark';
        series?: { label?: string; value: number }[];
        cells?: (number | null)[][];
        rowLabels?: string[];
        colLabels?: string[];
        summary?: string;
     }
   | ({ type: 'plot' } & Plot)
   | {
        type: 'verdict';
        recommendation: string;
        confidence: number;
        evidence: string[];
        risks?: string[];
        rollback?: string;
     }
   | { type: 'stats'; items: { label: string; value: string | number }[] }
   | { type: 'meter'; value: number; label?: string }
   | { type: 'callout'; tone: Tone; title?: string; text: string }
   | { type: 'image'; path: string; alt?: string; width?: number }
   | { type: 'diff'; unified: string; path?: string }
   | { type: 'steps'; items: { text: string; status?: 'pending' | 'active' | 'done' | 'blocked' }[] };

export type Block = Leaf | { type: 'row'; blocks: Leaf[] };

export interface Figure {
   title?: string;
   blocks: Block[];
   caption?: string;
}

const SPAN_TONE: Record<string, string> = {
   note: 'info',
   info: 'info',
   success: 'success',
   warning: 'warning',
   error: 'error',
   accent: 'accent',
};

function cellSpans(c: Cell) {
   if (typeof c !== 'object') return String(c);
   const s = [c.tone ? SPAN_TONE[c.tone] : '', c.bold ? 'strong' : ''].filter(Boolean).join(' ');
   return [{ t: String(c.text), ...(s ? { s } : {}), ...(c.href ? { href: c.href } : {}) }];
}

/** Context for drawing: where relative image paths resolve and where plots are written. */
export interface Ctx {
   cwd: string;
   dir: string;
}

function plotNode(b: Plot, key: string, narrow: boolean, ctx: Ctx): Node {
   const svg = plotSvg(b, narrow ? 420 : 720);
   const file = join(ctx.dir, `plot-${createHash('sha1').update(svg).digest('hex').slice(0, 12)}.svg`);
   writeFileSync(file, svg);
   return n('image', { key, path: file, alt: b.yLabel ?? 'plot', w: narrow ? 420 : 720 });
}

function leafNode(b: Leaf, key: string, ctx: Ctx, narrow = false): Node {
   switch (b.type) {
      case 'markdown':
         return n('md', { key, text: b.text });
      case 'math':
         return n('math', { key, text: b.tex, display: b.display ?? true });
      case 'code': {
         const code = n('code', {
            key: 'c',
            text: b.code,
            lang: b.lang,
            numbers: b.code.split('\n').length > 3,
            marks: b.highlight?.map(line => ({ line, tone: 'accent' })),
         });
         return b.title
            ? n('col', { key, gap: 'xs' }, [n('text', { key: 't', spans: [{ t: b.title, s: 'path dim' }] }), code])
            : n('col', { key }, [code]);
      }
      case 'table':
         return n('table', {
            key,
            cols: b.columns.map((head, i) => ({ id: `c${i}`, head, align: b.align?.[i], grow: 1, truncate: 'end', priority: 1 })),
            rows: b.rows.map((row, r) => ({ id: `r${r}`, cells: Object.fromEntries(row.map((c, i) => [`c${i}`, cellSpans(c)])) })),
         });
      case 'chart':
         // Tern's bars draw no labels; labelled bars read better as rows of label, bar, value.
         if (b.kind === 'bars' && b.series?.some(p => p.label)) {
            const max = Math.max(...b.series.map(p => Math.abs(p.value)), Number.EPSILON);
            return n('col', { key, gap: 'xs' }, [
               b.summary ? n('md', { key: 's', text: `*${b.summary}*` }) : null,
               n('table', {
                  key: 't',
                  cols: [
                     { id: 'l', head: '' },
                     { id: 'm', head: '', grow: 1 },
                     { id: 'v', head: '', align: 'end' },
                  ],
                  rows: b.series.map((p, i) => ({
                     id: `r${i}`,
                     cells: { l: p.label ?? '', m: { meter: { value: Math.abs(p.value) / max } }, v: [{ t: String(p.value), s: 'num' }] },
                  })),
               }),
            ]);
         }
         return n('chart', {
            key,
            kind: b.kind,
            size: b.kind === 'heatmap' ? 'lg' : 'md',
            summary: b.summary,
            series: b.series,
            cells: b.cells,
            rows: b.rowLabels,
            cols: b.colLabels?.map((label, at) => ({ at, label })),
         });
      case 'stats':
         return n('kv', { key, layout: 'grid', items: b.items.map(i => ({ k: i.label, v: [{ t: String(i.value), s: 'strong num' }] })) });
      case 'verdict': {
         const tone = b.confidence >= 0.8 ? 'success' : b.confidence >= 0.5 ? 'warning' : 'error';
         const list = (items: string[]): string => items.map(i => `- ${i}`).join('\n');
         return n('card', { key, tone, head: [{ t: 'Verdict', s: 'strong' }] }, [
            n('col', { key: 'b', gap: 'sm' }, [
               n('md', { key: 'rec', text: `**${b.recommendation}**` }),
               n('meter', { key: 'conf', value: b.confidence, style: 'bar', label: `Confidence ${Math.round(b.confidence * 100)}%`, tone }),
               n('md', { key: 'ev', text: `**Evidence**\n${list(b.evidence)}` }),
               b.risks?.length ? n('md', { key: 'risk', text: `**Risks**\n${list(b.risks)}` }) : null,
               b.rollback ? n('md', { key: 'rb', text: `**Rollback** ${b.rollback}` }) : null,
            ]),
         ]);
      }
      case 'meter':
         return n('meter', { key, value: b.value, label: b.label, style: 'bar' });
      case 'callout':
         return n('card', { key, tone: SPAN_TONE[b.tone] ?? 'info', head: b.title ? [{ t: b.title, s: 'strong' }] : undefined }, [
            n('md', { key: 'md', text: b.text }),
         ]);
      case 'plot':
         return plotNode(b, key, narrow, ctx);
      case 'image':
         return n('image', { key, path: isAbsolute(b.path) ? b.path : resolve(ctx.cwd, b.path), alt: b.alt, w: b.width });
      case 'diff':
         return n('diff', { key, text: b.unified, path: b.path });
      case 'steps':
         return n('checklist', {
            key,
            mode: 'full',
            phases: [{ id: 'p', items: b.items.map((i, k) => ({ id: `s${k}`, text: i.text, status: i.status ?? 'pending' })) }],
         });
   }
}

/** A figure: optional title, its blocks (a row's side by side), optional caption. */
export function figureNode(fig: Figure, ctx: Ctx): Node {
   const blocks = (fig.blocks ?? []).map((b, i) =>
      b.type === 'row'
         ? n(
              'row',
              { key: `b${i}`, gap: 'lg', align: 'start', wrap: true },
              b.blocks.map((l, j) => n('col', { key: `x${j}`, grow: 1, basis: 0 }, [leafNode(l, 'v', ctx, true)]))
           )
         : leafNode(b, `b${i}`, ctx)
   );
   return n('col', { key: 'fig', gap: 'md' }, [
      fig.title ? n('md', { key: 'title', text: `#### ${fig.title}` }) : null,
      ...blocks,
      fig.caption ? n('md', { key: 'caption', text: `*${fig.caption}*` }) : null,
   ]);
}
