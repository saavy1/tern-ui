/**
 * Surfaces: one tern-ui block per handle. A surface is a `.ternui` spec file the
 * tern-ui plugin's block draws (and redraws when it changes); the block writes
 * its pane id beside it and appends clicks to `<spec>.events`. Everything stays
 * on this machine, the one the agent runs on, so the block runs here too and any
 * Tern window connected to this host (local or remote) shows it.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Node } from './figure.ts';

const TERN = process.env['TERN_EXE'] || 'tern';

export type Placement = 'beside' | 'below' | 'tab';

/** Where this agent's surfaces live: one folder per chat pane (or per process outside Tern). */
export const dir = join(
   process.env['XDG_STATE_HOME'] || join(homedir(), '.local', 'state'),
   'tern-ui',
   process.env['TERN_PANE'] ? `pane-${process.env['TERN_PANE']}` : `pid-${process.pid}`
);
mkdirSync(dir, { recursive: true });

export const specPath = (handle: string): string => join(dir, `${handle}.ternui`);

const run = (args: string[]): Promise<{ ok: boolean; out: string }> =>
   new Promise(done =>
      execFile(TERN, args, { timeout: 15_000, maxBuffer: 16 << 20 }, (err, stdout, stderr) =>
         done({ ok: !err, out: err ? String(stderr || err.message).trim() : stdout })
      )
   );

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** The pane showing a handle, when that block is still open. */
async function openPane(handle: string): Promise<number | undefined> {
   const paneFile = `${specPath(handle)}.pane`;
   if (!existsSync(paneFile)) return undefined;
   const pane = Number(readFileSync(paneFile, 'utf8').trim());
   if (!pane) return undefined;
   const { ok, out } = await run(['inspect', '--json']);
   if (!ok) return undefined;
   const ids = new Set<number>();
   const walk = (v: unknown): void => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') {
         const o = v as Record<string, unknown>;
         if (typeof o['id'] === 'number') ids.add(o['id']);
         Object.values(o).forEach(walk);
      }
   };
   walk(JSON.parse(out));
   return ids.has(pane) ? pane : undefined;
}

export interface Shown {
   pane?: number;
   opened: boolean;
   error?: string;
}

/** Writes a surface and makes sure a block shows it: opened the first time, redrawn in place after. */
export async function show(handle: string, spec: { title: string; view: Node; waiting?: boolean }, how: Placement): Promise<Shown> {
   const path = specPath(handle);
   const tmp = `${path}.tmp`;
   writeFileSync(tmp, JSON.stringify({ v: 1, ...spec }));
   renameSync(tmp, path);
   const pane = await openPane(handle);
   if (pane) return { pane, opened: false };
   // A new block: forget the last one's pane and clicks.
   writeFileSync(`${path}.pane`, '');
   writeFileSync(`${path}.events`, '');
   seen.set(handle, 0);
   const where = how === 'tab' ? ['--tab'] : ['--split', how === 'below' ? 'down' : 'right'];
   const { ok, out } = await run(['open', ...where, path]);
   if (!ok) return { opened: false, error: `tern open failed: ${out}` };
   for (let i = 0; i < 25; i++) {
      await sleep(120);
      const id = Number(readFileSync(`${path}.pane`, 'utf8').trim());
      if (id) return { pane: id, opened: true };
   }
   return { opened: true, error: 'The block opened but has not reported in; is the tern-ui plugin installed and ready (`tern plugin list`)?' };
}

export async function close(handle: string): Promise<boolean> {
   const pane = await openPane(handle);
   if (!pane) return false;
   return (await run(['close', String(pane)])).ok;
}

export interface UiEvent {
   ev: string;
   act?: string;
   value?: string;
   id?: string;
   item?: string;
   name?: string;
   checked?: boolean;
   values?: Record<string, unknown>;
}

/** Lines of the events file already handed out, by handle. */
const seen = new Map<string, number>();

/** Clicks and selections since the last read (form changes only update the values they carry). */
export function events(handle: string): UiEvent[] {
   const file = `${specPath(handle)}.events`;
   if (!existsSync(file)) return [];
   const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
   const from = seen.get(handle) ?? 0;
   seen.set(handle, lines.length);
   return lines
      .slice(from)
      .flatMap(l => {
         try {
            return [JSON.parse(l) as UiEvent];
         } catch {
            return [];
         }
      })
      .filter(e => e.ev !== 'change');
}

/** Waits for the next click on a handle; undefined after `ms`. */
export async function next(handle: string, ms: number, signal?: AbortSignal): Promise<UiEvent | undefined> {
   const until = Date.now() + ms;
   while (Date.now() < until && !signal?.aborted) {
      const got = events(handle);
      if (got.length) return got[got.length - 1];
      await sleep(200);
   }
   return undefined;
}

/** The message an event becomes for the agent (the same shape saavy's front ends sent). */
export function describe(handle: string, e: UiEvent): string {
   const node = (e.id ?? '').split('.').pop() || e.id || '?';
   const act = e.act ?? e.ev;
   const value = e.value !== undefined ? `=${e.value}` : '';
   const item = e.item !== undefined ? ` ${String(e.item).split('.').pop()}` : '';
   const values = e.values && Object.keys(e.values).length ? ` ${JSON.stringify(e.values)}` : '';
   return `[ui ${handle}] ${act}${value} on ${node}${item}${values}`;
}
