/**
 * tern-ui-mcp: an MCP server (stdio) giving coding agents Tern-native UI.
 *
 *   show        figures: tables, stats, charts, plots, verdicts, callouts, code, diffs, checklists, images
 *   ui          interactive UI from a node spec; with wait, returns what the person did
 *   update_ui   change a UI live (set props, append text, replace), or close it
 *   ui_events   clicks on UIs the agent isn't waiting on
 *   ui_reference  every prop of one UI kind
 *
 * Each handle is a pane beside the chat drawn by the tern-ui Tern plugin (see
 * surface.ts). Register this server in Tern's Settings > Agents > MCP servers so
 * every agent in Tern's chat (Claude, Droid, Codex) gets it.
 */
import { createInterface } from 'node:readline';
import { figureNode, n, type Figure, type Node } from './figure.ts';
import { applyUpdate, checkUi, checkUpdate, UI_REFERENCE, type UiNode, type UiUpdate } from './spec.ts';
import { close, describe, dir, events, next, show, type Placement } from './surface.ts';

const VERSION = '0.1.0';

// ── Tools ────────────────────────────────────────────────────────────────

const tone = { type: 'string', enum: ['note', 'info', 'success', 'warning', 'error', 'accent'] };
const placement = {
   type: 'string',
   enum: ['beside', 'below', 'tab'],
   description: 'Where a new pane opens: beside the chat (default), below it (wide, short things) or in its own tab',
};
const handle = {
   type: 'string',
   pattern: '^[A-Za-z0-9_-]{1,40}$',
   description: 'Names the pane: using a handle again updates that pane in place instead of opening another',
};
const cell = {
   anyOf: [
      { type: 'string' },
      { type: 'number' },
      {
         type: 'object',
         properties: { text: { type: ['string', 'number'] }, tone, bold: { type: 'boolean' }, href: { type: 'string' } },
         required: ['text'],
      },
   ],
};
const leaf = {
   type: 'object',
   description: 'One block; `type` picks its kind and the fields it takes.',
   properties: {
      type: {
         type: 'string',
         enum: ['markdown', 'math', 'code', 'table', 'chart', 'plot', 'verdict', 'stats', 'meter', 'callout', 'image', 'diff', 'steps'],
      },
      text: { type: 'string', description: 'markdown, callout: GitHub markdown (mermaid diagrams render)' },
      tex: { type: 'string', description: 'math: LaTeX without $' },
      display: { type: 'boolean' },
      code: { type: 'string' },
      lang: { type: 'string' },
      title: { type: 'string', description: 'code: a filename or label; callout: heading' },
      highlight: { type: 'array', items: { type: 'number' }, description: 'code: 1-based lines to highlight' },
      columns: { type: 'array', items: { type: 'string' }, description: 'table: headings' },
      rows: { type: 'array', items: { type: 'array', items: cell }, description: 'table: cells per row' },
      align: { type: 'array', items: { type: 'string', enum: ['start', 'center', 'end'] } },
      kind: {
         type: 'string',
         description: 'chart: bars | heatmap | spark; plot: line | area | scatter | step | bar (default line)',
      },
      series: {
         type: 'array',
         description: 'chart: [{label?, value}]; plot: [{label?, y: number[], x?: number[]}] (compute the values; ~50-200 points for curves)',
         items: { type: 'object' },
      },
      cells: { type: 'array', items: { type: 'array', items: { type: ['number', 'null'] } }, description: 'chart heatmap: rows of values' },
      rowLabels: { type: 'array', items: { type: 'string' } },
      colLabels: { type: 'array', items: { type: 'string' } },
      summary: { type: 'string' },
      xLabel: { type: 'string' },
      yLabel: { type: 'string' },
      xTicks: { type: 'array', items: { type: 'string' }, description: 'plot: category labels along x' },
      height: { type: 'number', description: 'plot: pixels, default 260' },
      recommendation: { type: 'string', description: 'verdict: the call in one line' },
      confidence: { type: 'number', description: 'verdict: 0-1' },
      evidence: { type: 'array', items: { type: 'string' } },
      risks: { type: 'array', items: { type: 'string' } },
      rollback: { type: 'string' },
      items: {
         type: 'array',
         description: 'stats: [{label, value}]; steps: [{text, status?: pending|active|done|blocked}]',
         items: { type: 'object' },
      },
      value: { type: 'number', description: 'meter: 0-1' },
      label: { type: 'string' },
      tone,
      path: { type: 'string', description: 'image: a PNG, JPEG, GIF, WebP or SVG file; diff: the file it changes' },
      alt: { type: 'string' },
      width: { type: 'number' },
      unified: { type: 'string', description: 'diff: a unified diff' },
   },
   required: ['type'],
};

const TOOLS = [
   {
      name: 'show',
      description: [
         "Draw a figure in a pane beside the chat with Tern's native components: tables (cells can be highlighted with a",
         'tone), stat grids, labelled bars, heatmaps, sparklines, plots (line/area/scatter/step/bar with axes and legends:',
         'pass the numbers), verdicts, callouts, math, code, diffs, checklists and images. Use it whenever a visual explains',
         'better than prose: comparisons, numbers, results, progress, before/after. Blocks stack; a "row" puts up to ~3 side',
         'by side. Show again with the same handle to update the pane in place (live dashboards, progress); a new handle',
         'opens another pane. The user sees it; do not repeat its contents in prose. Small things (a short table, a mermaid',
         'diagram) can go straight into your reply as markdown instead.',
      ].join(' '),
      inputSchema: {
         type: 'object',
         properties: {
            handle: { ...handle, description: `${handle.description} (default: from the title, else "figure")` },
            title: { type: 'string' },
            blocks: {
               type: 'array',
               minItems: 1,
               items: {
                  anyOf: [
                     leaf,
                     {
                        type: 'object',
                        properties: { type: { const: 'row' }, blocks: { type: 'array', items: leaf, minItems: 1 } },
                        required: ['type', 'blocks'],
                     },
                  ],
               },
            },
            caption: { type: 'string' },
            placement,
         },
         required: ['blocks'],
      },
   },
   {
      name: 'ui',
      description: [
         "Show interactive UI in a pane beside the chat, drawn with Tern's native components: choices, approvals, short",
         'forms, live progress, dashboards with actions. `ui` is one node { k, id?, p?, c? } (kind, your id, props,',
         'children). Buttons: {k:"el", p:{tag:"button", text, actions:{click:"<name>"}}} (or "<name>=<value>"); list items',
         'send select; checkboxes/radios {k:"el", p:{tag:"input", type, name, value, checked}} inside an el form report',
         'their values with the click. With wait: true the call returns what the person did, as',
         '"[ui <handle>] <action> on <node> {values}": use it to ask and get the answer in one step. Without wait, read',
         'clicks later with ui_events. update_ui changes it live. Kinds: col/row {gap}, card {head, tone}, section {head},',
         'rule, md {text}, text {text|spans}, code {text, lang}, diff {text}, kv {items:[{k,v}]}, table {cols:[{id,head}],',
         'rows:[{id,cells:{colId:value}}]}, tree, list of item {label, detail}, badge {text, tone}, chart {kind, series,',
         'summary}, meter {value, label}, progress {value|null, label}, checklist {phases:[{id,title,items:[{id,text,',
         'status}]}]}, spinner {label}, el {tag, text}. ui_reference(kind) has every prop. Keep it purposeful.',
      ].join(' '),
      inputSchema: {
         type: 'object',
         properties: {
            handle,
            ui: { type: 'object', description: 'The root node { k, id?, p?, c? }' },
            title: { type: 'string', description: 'The pane title' },
            wait: { type: 'boolean', description: 'Wait for the person to act and return what they did' },
            timeout: { type: 'number', description: 'Seconds to wait (default 600)' },
            placement,
         },
         required: ['handle', 'ui'],
      },
   },
   {
      name: 'update_ui',
      description:
         'Change a UI you showed with `ui`, live: set (props by your node ids, shallow-merged), append (text added to md/text/code nodes by id), or ui (a whole new tree); close: true closes its pane. For progress during long work: tick checklist items, move meters, add rows.',
      inputSchema: {
         type: 'object',
         properties: {
            handle,
            set: {
               type: 'array',
               items: { type: 'object', properties: { id: { type: 'string' }, props: { type: 'object' } }, required: ['id', 'props'] },
            },
            append: {
               type: 'array',
               items: { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' } }, required: ['id', 'text'] },
            },
            ui: { type: 'object' },
            title: { type: 'string' },
            close: { type: 'boolean' },
         },
         required: ['handle'],
      },
   },
   {
      name: 'ui_events',
      description: 'Clicks and selections on UIs you showed without waiting, since you last asked: one "[ui <handle>] ..." line each.',
      inputSchema: { type: 'object', properties: { handle: { type: 'string', description: 'One UI; default all of yours' } } },
   },
   {
      name: 'ui_reference',
      description: 'Every prop of one UI kind (for the ui tool).',
      inputSchema: { type: 'object', properties: { kind: { type: 'string' } }, required: ['kind'] },
   },
];

// ── State and handlers ───────────────────────────────────────────────────

/** UIs shown with `ui`, as specs, so update_ui can patch them. */
const uis = new Map<string, { spec: UiNode; title: string; how: Placement }>();
const handles = new Set<string>();

const slug = (s: string | undefined): string =>
   (s ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'figure';

/** A UI spec ({k, id, p, c}) as wire nodes: the agent's ids become keys. */
function wire(node: UiNode, path = 'n'): Node {
   return n(
      node.k,
      { ...(node.p ?? {}), key: node.id ?? path },
      (node.c ?? []).map((c, i) => wire(c, `${path}-${i}`))
   );
}

type Args = Record<string, unknown>;
type Result = { content: { type: 'text'; text: string }[]; isError?: boolean };
const text = (t: string, isError = false): Result => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError } : {}) });

async function call(name: string, a: Args, signal: AbortSignal): Promise<Result> {
   switch (name) {
      case 'show': {
         const fig = a as unknown as Figure & { handle?: string; placement?: Placement };
         if (!Array.isArray(fig.blocks) || fig.blocks.length === 0) return text('Give at least one block.', true);
         const h = fig.handle ?? slug(fig.title);
         const view = figureNode(fig, { cwd: process.cwd(), dir });
         const r = await show(h, { title: fig.title ?? 'Figure', view }, fig.placement ?? 'beside');
         handles.add(h);
         if (r.error) return text(r.error, true);
         return text(r.opened ? `Shown in a new pane ("${h}").` : `Updated "${h}" in place.`);
      }
      case 'ui': {
         const h = String(a['handle']);
         const spec = a['ui'] as UiNode;
         const bad = checkUi(spec);
         if (bad) return text(`Not shown: ${bad}`, true);
         const title = typeof a['title'] === 'string' ? a['title'] : h;
         const how = (a['placement'] as Placement) ?? uis.get(h)?.how ?? 'beside';
         uis.set(h, { spec, title, how });
         handles.add(h);
         const r = await show(h, { title, view: wire(spec), waiting: a['wait'] === true }, how);
         if (r.error) return text(r.error, true);
         if (a['wait'] !== true) return text(`${r.opened ? 'Opened' : 'Updated'} "${h}" beside the chat. Read clicks with ui_events.`);
         events(h); // only clicks from now on
         const seconds = typeof a['timeout'] === 'number' ? a['timeout'] : 600;
         const got = await next(h, seconds * 1000, signal);
         return text(got ? describe(h, got) : `No answer after ${seconds}s; "${h}" stays open (ui_events reads a later click).`);
      }
      case 'update_ui': {
         const h = String(a['handle']);
         if (a['close'] === true) {
            uis.delete(h);
            return text((await close(h)) ? `Closed "${h}".` : `"${h}" wasn't open.`);
         }
         const shown = uis.get(h);
         if (!shown) return text(`No UI "${h}" to update; show it with ui first.`, true);
         const update = { set: a['set'], append: a['append'], ui: a['ui'] } as UiUpdate;
         const bad = checkUpdate(update);
         if (bad) return text(bad, true);
         shown.spec = applyUpdate(shown.spec, update);
         if (typeof a['title'] === 'string') shown.title = a['title'];
         const r = await show(h, { title: shown.title, view: wire(shown.spec) }, shown.how);
         if (r.error) return text(r.error, true);
         const clicks = events(h).map(e => describe(h, e));
         return text(`Updated "${h}".${clicks.length ? `\nSince last time:\n${clicks.join('\n')}` : ''}`);
      }
      case 'ui_events': {
         const which = typeof a['handle'] === 'string' ? [a['handle']] : [...handles];
         const lines = which.flatMap(h => events(h).map(e => describe(h, e)));
         return text(lines.length ? lines.join('\n') : 'No new clicks.');
      }
      case 'ui_reference': {
         const k = String(a['kind']);
         return text(UI_REFERENCE[k] ?? `No reference for "${k}". Kinds: ${Object.keys(UI_REFERENCE).join(', ')}`);
      }
      default:
         return text(`Unknown tool ${name}`, true);
   }
}

// ── MCP over stdio (newline-delimited JSON-RPC 2.0) ──────────────────────

const send = (msg: unknown): void => void process.stdout.write(`${JSON.stringify(msg)}\n`);
const inflight = new Map<string | number, AbortController>();

async function handleMessage(msg: { id?: string | number; method?: string; params?: Args }): Promise<void> {
   const { id, method, params = {} } = msg;
   const reply = (result: unknown): void => {
      if (id !== undefined) send({ jsonrpc: '2.0', id, result });
   };
   const fail = (code: number, message: string): void => {
      if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code, message } });
   };
   switch (method) {
      case 'initialize':
         return reply({
            protocolVersion: typeof params['protocolVersion'] === 'string' ? params['protocolVersion'] : '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'tern-ui', version: VERSION },
            instructions:
               'You run in Tern. tern-ui draws figures and interactive UI in panes beside the chat with Tern\'s native components: reach for `show` for numbers, comparisons and results, and `ui` (wait: true) to ask the person a choice. Same handle = update in place.',
         });
      case 'ping':
         return reply({});
      case 'tools/list':
         return reply({ tools: TOOLS });
      case 'tools/call': {
         const ac = new AbortController();
         if (id !== undefined) inflight.set(id, ac);
         try {
            reply(await call(String(params['name']), (params['arguments'] as Args) ?? {}, ac.signal));
         } catch (e) {
            reply(text(`tern-ui: ${(e as Error).message}`, true));
         } finally {
            if (id !== undefined) inflight.delete(id);
         }
         return;
      }
      case 'notifications/cancelled':
         inflight.get(params['requestId'] as string | number)?.abort();
         return;
      default:
         if (method?.startsWith('notifications/')) return;
         return fail(-32601, `Method not found: ${method}`);
   }
}

createInterface({ input: process.stdin }).on('line', line => {
   if (!line.trim()) return;
   let msg;
   try {
      msg = JSON.parse(line);
   } catch {
      return void send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
   }
   void handleMessage(msg);
});
