import { analyze } from './shell.mjs';
import { classifyWrite, relativeTo } from './policy.mjs';

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const HOME = /^(~|\$HOME|\$\{HOME\})(\/|$)/;

function checkPath(target, { root, cwd, ctx }, asDir = false) {
  if (!target || HOME.test(target) || target.startsWith('/dev/')) return null;
  const rel = relativeTo(root, target, cwd ?? root);
  if (rel === null) return null; // outside the repository: not the guard's concern
  if (rel === '.') return asDir ? 'the repository root holds harness controls' : null;
  return classifyWrite(rel, ctx, asDir);
}

/**
 * Decide one tool call before it runs.
 * @param {{tool: string, input: object|string, root: string, cwd?: string, ctx?: object, unattended?: boolean}} call
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
      if (w.soft) {
        // A guessed path inside a destination: only identity rules apply.
        const reason = checkPath(w.path, { ...call, ctx: { ...call.ctx, task: null } });
        if (reason) return { decision: 'deny', reason: `shell write: ${reason}` };
      } else {
        const reason = checkPath(w.path, call, Boolean(w.dir));
        if (reason) return { decision: 'deny', reason: `shell write: ${reason}` };
      }
    }
    if (found.ask.length > 0) {
      return call.unattended
        ? { decision: 'deny', reason: `${found.ask[0]} (needs the owner; denied while unattended)` }
        : { decision: 'ask', reason: found.ask[0] };
    }
  }
  return { decision: 'allow' };
}
