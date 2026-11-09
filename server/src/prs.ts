/**
 * Pull request tracking: the chat's `prs.ternprs` lists repo checkouts (each
 * stands for the PR of its current branch) and explicit PRs. The plugin's
 * `github` block draws them live; `status()` gives the agent the same picture
 * as text, straight from `gh`.
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { dir, ensureOpen, owner, writeSpec, type Placement, type Shown } from './surface.ts';

export const prsPath = join(dir, 'prs.ternprs');

interface Tracked {
   owner?: number;
   repos: string[];
   prs: { repo: string; number: number }[];
}

const gh = (args: string[], cwd?: string): Promise<{ ok: boolean; out: string }> =>
   new Promise(done =>
      execFile('gh', args, { cwd, timeout: 20_000, maxBuffer: 16 << 20 }, (err, stdout, stderr) =>
         done({ ok: !err, out: err ? String(stderr || err.message).trim() : stdout })
      )
   );

function load(): Tracked {
   try {
      const t = JSON.parse(readFileSync(prsPath, 'utf8')) as Partial<Tracked>;
      return { owner: t.owner, repos: t.repos ?? [], prs: t.prs ?? [] };
   } catch {
      return { repos: [], prs: [] };
   }
}

/** Tracks a checkout's branch PR (no number) or one PR, and makes sure the pane is open. */
export async function track(args: { repo?: string; number?: number; dir?: string }, how: Placement): Promise<Shown & { added: string }> {
   const t = load();
   t.owner = owner;
   let added: string;
   if (args.number !== undefined) {
      let repo = args.repo;
      if (!repo) {
         const r = await gh(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], resolve(args.dir ?? process.cwd()));
         if (!r.ok) return { opened: false, error: `Couldn't tell which repo PR #${args.number} is in: ${r.out}`, added: '' };
         repo = r.out.trim();
      }
      if (!t.prs.some(p => p.repo === repo && p.number === args.number)) t.prs.push({ repo, number: args.number });
      added = `${repo}#${args.number}`;
   } else {
      const checkout = resolve(args.dir ?? process.cwd());
      if (!existsSync(checkout)) return { opened: false, error: `No such folder: ${checkout}`, added: '' };
      if (!t.repos.includes(checkout)) t.repos.push(checkout);
      added = `the current branch's PR in ${checkout}`;
   }
   writeSpec(prsPath, t);
   return { ...(await ensureOpen(prsPath, how)), added };
}

interface Check {
   name?: string;
   context?: string;
   workflowName?: string;
   conclusion?: string;
   state?: string;
   status?: string;
}

const FAIL = new Set(['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE']);
const PASS = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);

/** One line per PR: checks, review, conflicts, and the failing check names. */
export async function status(): Promise<string> {
   const t = load();
   if (t.repos.length === 0 && t.prs.length === 0) return 'Nothing tracked yet: call track_pr.';
   const fields = 'number,title,url,state,isDraft,headRefName,reviewDecision,mergeable,statusCheckRollup';
   const targets = [
      ...t.repos.map(r => ({ args: ['pr', 'view', '--json', fields], cwd: r, label: r })),
      ...t.prs.map(p => ({ args: ['pr', 'view', String(p.number), '-R', p.repo, '--json', fields], cwd: undefined, label: `${p.repo}#${p.number}` })),
   ];
   const lines = await Promise.all(
      targets.map(async ({ args, cwd, label }) => {
         const r = await gh(args, cwd);
         if (!r.ok) return `${label}: ${/no pull requests found/i.test(r.out) ? 'no PR for the current branch' : r.out.split('\n')[0]}`;
         const d = JSON.parse(r.out);
         const checks = (d.statusCheckRollup ?? []) as Check[];
         const state = (c: Check) => String(c.conclusion || c.state || c.status || '').toUpperCase();
         const failing = checks.filter(c => FAIL.has(state(c))).map(c => [c.workflowName, c.name ?? c.context].filter(Boolean).join(' / '));
         const passing = checks.filter(c => PASS.has(state(c))).length;
         const pending = checks.length - failing.length - passing;
         const parts = [
            d.isDraft ? 'draft' : String(d.state).toLowerCase(),
            `checks ${failing.length} failing, ${pending} running, ${passing} passing`,
            d.reviewDecision ? `review ${String(d.reviewDecision).toLowerCase().replace(/_/g, ' ')}` : '',
            d.mergeable === 'CONFLICTING' ? 'merge conflicts' : '',
         ].filter(Boolean);
         return `#${d.number} ${d.title} (${d.headRefName}) — ${parts.join('; ')}${failing.length ? `\n  failing: ${failing.join(', ')}` : ''}\n  ${d.url}`;
      })
   );
   return lines.join('\n');
}
