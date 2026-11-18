import path from 'node:path';
import { analyze } from './shell.mjs';
import { classifyWrite, relativeTo, covers, patternsOverlap, CONTROL_FILES, CONTROL_PREFIXES, HOLDOUT_MARKERS } from './policy.mjs';

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const HOME = /^(~|\$HOME|\$\{HOME\})(\/|$)/;
const inside = (dir, abs) => abs === dir || abs.startsWith(`${dir}${path.sep}`);

/** Names a glob must not be able to reach, whatever else it matches. */
function guardedNames(ctx) {
  return [
    '.env', '.git',
    ...(ctx.task ? ctx.controlFiles ?? CONTROL_FILES : []),
    ...(ctx.controlPrefixes ?? CONTROL_PREFIXES).map((p) => p.replace(/\/$/, '')),
    ...(ctx.frozen ?? []),
    ...(ctx.task ? ctx.protected ?? [] : []),
  ];
}

function globHitsHoldout(rel, markers = HOLDOUT_MARKERS) {
  const low = rel.toLowerCase();
  const segs = low.split('/');
  for (const m of markers) {
    const lm = m.toLowerCase();
    if (lm.endsWith('/')) {
      const stem = lm.slice(0, -1);
      if (segs.some((s) => covers(s, stem))) return stem;
    } else if (segs.some((s) => (s.includes('holdout') || s.includes('[')) && covers(s, `a${lm}b`))) {
      return lm;
    }
  }
  return null;
}

/**
 * Reason to refuse a write to `target`, or null. `w` carries what the shell
 * reader learned: the directory in effect, and whether the target may be a
 * directory or is a Git restore.
 */
function checkPath(target, call, w = {}) {
  const { root, ctx = {} } = call;
  if (!target || HOME.test(target) || target.startsWith('/dev/')) return null;
  if (/^\$|\$\(…\)/.test(target)) return null; // a variable or substitution: the value is unknown
  const absolute = path.isAbsolute(target);
  if (!absolute && w.cd === null) return null; // after a `cd` that cannot be followed
  const from = path.resolve(call.cwd ?? root, w.cd ?? '');
  const abs = path.resolve(absolute ? '/' : from, target);
  if (call.gitCommon && inside(call.gitCommon, abs)) return 'Git internals and factory run state are off limits';
  const rel = relativeTo(root, target, from);
  if (rel === null) return null; // outside the repository: not the guard's concern
  if (rel === '.') {
    if (w.revert) return w.treeish && (ctx.task || (ctx.frozen ?? []).length > 0) ? 'restoring the whole tree from another commit would replace protected files' : null;
    return w.dir ? 'the repository root holds factory controls' : null;
  }
  if (/[*?[]/.test(rel)) {
    const lowRel = rel.toLowerCase();
    const hit = guardedNames(ctx).find((name) => patternsOverlap(lowRel, name.toLowerCase()));
    if (hit) return `the pattern ${rel} can match ${hit}`;
    const holdout = globHitsHoldout(rel, ctx.holdoutMarkers);
    if (holdout) return `the pattern ${rel} can match holdout ${holdout}`;
  }
  return classifyWrite(rel, ctx, Boolean(w.dir));
}

/**
 * Decide one tool call before it runs.
 * @param {{tool: string, input: object|string, root: string, cwd?: string, gitCommon?: string, ctx?: object, unattended?: boolean}} call
 * @returns {{decision: 'allow'|'deny'|'ask', reason?: string}}
 */
export function decide(call) {
  const { tool, input } = call;
  if (WRITE_TOOLS.has(tool) || tool === 'write') {
    const target = typeof input === 'string' ? input : (input?.file_path ?? input?.notebook_path ?? input?.path);
    const reason = checkPath(target, call);
    return reason ? { decision: 'deny', reason } : { decision: 'allow' };
  }
  if (tool === 'Bash' || tool === 'shell') {
    const found = analyze(typeof input === 'string' ? input : input?.command);
    if (found.deny.length > 0) return { decision: 'deny', reason: found.deny[0] };
    for (const w of found.writes) {
      // A guessed path inside a destination that may be a plain file: identity rules only.
      const scoped = w.soft ? { ...call, ctx: { ...call.ctx, task: null } } : call;
      const reason = checkPath(w.path, scoped, w);
      if (reason) return { decision: 'deny', reason: `shell write: ${reason}` };
    }
    if (found.ask.length > 0) {
      return call.unattended
        ? { decision: 'deny', reason: `${found.ask[0]} (needs the owner; denied while unattended)` }
        : { decision: 'ask', reason: found.ask[0] };
    }
  }
  return { decision: 'allow' };
}
