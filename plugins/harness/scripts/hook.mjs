#!/usr/bin/env node
// Claude Code hook entry point. One process per event; stdin carries the
// event JSON and stdout carries the decision. The guard is a convenience that
// stops honest mistakes early; the gate is the authority.
import fs from 'node:fs';
import path from 'node:path';
import { decide } from '../lib/guard.mjs';
import { git } from '../lib/util.mjs';
import { protectedPaths } from '../lib/policy.mjs';
import { repoInfo, isAdopted, getActive, updateActive, logEvent } from '../lib/state.mjs';
import { candidateHash, changedPaths } from '../lib/candidate.mjs';
import { runGate, summarize } from '../lib/gate.mjs';

const UNATTENDED_MODES = new Set(['bypassPermissions', 'dontAsk']);
const managed = () => process.env.CLAUDE_HARNESS_MANAGED === '1';
const out = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

function existingDir(p) {
  let dir = p;
  while (dir && !fs.existsSync(dir)) {
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  try {
    return fs.statSync(dir).isDirectory() ? dir : path.dirname(dir);
  } catch {
    return null;
  }
}

/** Canonical form of a path that may not exist yet, so symlinked prefixes compare equal. */
function canonical(p) {
  if (fs.existsSync(p)) return fs.realpathSync(p); // also resolves a symlinked file to what it edits
  const dir = existingDir(p);
  if (!dir) return p;
  const real = fs.realpathSync(dir);
  const rest = path.relative(dir, p);
  return rest && !rest.startsWith('..') ? path.join(real, rest) : real;
}

/** The adopted checkout that owns `where`, or null: elsewhere the plugin stays silent. */
function adopted(where) {
  const dir = where && existingDir(where);
  let repo = dir && repoInfo(dir);
  if (!repo && dir) {
    // Inside a `.git` directory there is no work tree: use the checkout that owns it.
    const parts = dir.split(path.sep);
    const at = parts.lastIndexOf('.git');
    if (at > 0) repo = repoInfo(parts.slice(0, at).join(path.sep));
  }
  return repo && isAdopted(repo) ? repo : null;
}

function guardContext(repo) {
  const active = getActive(repo);
  if (!active) return {};
  return {
    task: active.task,
    protected: protectedPaths(active.config),
    editable: active.config.policy.editable_paths,
    isIgnored: (rel) => git(repo.root, 'check-ignore', '-q', '--', rel).code === 0,
  };
}

function preToolUse(input) {
  const cwd = canonical(input.cwd ?? process.cwd());
  const raw = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
  const target = raw && canonical(path.resolve(cwd, raw));
  // A file edit belongs to the checkout that contains the file, which for a
  // worktree subagent is not necessarily the session's directory.
  const repo = adopted(target ?? cwd) ?? (target ? adopted(cwd) : null);
  if (!repo) return;
  const unattended = managed() || process.env.CLAUDE_HARNESS_UNATTENDED === '1' || UNATTENDED_MODES.has(input.permission_mode);
  const toolInput = target ? { ...input.tool_input, file_path: target, notebook_path: undefined } : input.tool_input;
  const verdict = decide({ tool: input.tool_name, input: toolInput, root: repo.root, cwd, gitCommon: repo.common, ctx: guardContext(repo), unattended });
  if (verdict.decision === 'allow') return;
  logEvent(repo, { event: 'guard', decision: verdict.decision, tool: input.tool_name, reason: verdict.reason });
  out({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: verdict.decision,
      permissionDecisionReason: `Claude Harness: ${verdict.reason}`,
    },
  });
}

function sessionStart(input) {
  const repo = adopted(canonical(input.cwd ?? process.cwd()));
  if (!repo) return;
  const active = getActive(repo);
  const lines = active
    ? [
      `Claude Harness: task "${active.task.id}" (${active.task.title}) is active in this worktree.`,
      `Edit only: ${active.task.allowed_paths.join(', ')}. Tests, Compose files and harness.json are protected acceptance inputs.`,
      `The gate boots the real Docker Compose stack when you stop; attempts used: ${active.attempts}/${active.config.limits?.attempts ?? 3}.`,
      ...(active.attempts >= (active.config.limits?.attempts ?? 3) ? ['The attempt budget is spent: the task is BLOCKED until the owner runs `harness verify`. Tell the owner before doing anything else.'] : []),
      'Your own report is never evidence. If the task cannot be met within scope, stop and tell the owner.',
    ]
    : ['Claude Harness: this repository is adopted and no task is active. Use the intake skill to draft a task; the owner activates it.'];
  out({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: lines.join('\n') } });
}

// The Stop hook's own timeout is 1800s. The gate stops well short of it so a
// slow stack is torn down by the gate, not orphaned by a killed hook.
const GATE_DEADLINE_SECONDS = 1200;
const LOCK_WAIT_SECONDS = 240;

function blockedMessage(active, why) {
  return { systemMessage: `Claude Harness: task ${active.task.id} is BLOCKED: ${why}. Changes since then are NOT verified. Run /harness:status, then \`harness verify\` once the cause is fixed.` };
}

/** Stop and SubagentStop: verify the candidate before the turn may end. */
function stop(input) {
  const repo = adopted(canonical(input.cwd ?? process.cwd()));
  if (!repo || managed()) return; // a managed run's controller gates outside the session
  const active = getActive(repo);
  // The audit shows which checkout each stop event was dispatched for.
  logEvent(repo, { event: 'stop-hook', hook: input.hook_event_name, agent: input.agent_type ?? null, task: active?.task.id ?? null });
  if (!active) return;
  const limit = active.config.limits?.attempts ?? 3;
  const bump = (field) => updateActive(repo, active.activation, (cur) => ({ [field]: (cur[field] ?? 0) + 1 }));
  try {
    const candidate = candidateHash(repo.root);
    if (active.last?.candidate === candidate && active.last.passed) return;
    const awaiting = () => out({ systemMessage: `Claude Harness: automated checks passed for ${active.task.id}. Acceptance now waits for the owner's manual observation on this candidate: run /harness:status.` });
    if (active.last?.candidate === candidate && active.last.status === 'pending') return awaiting();
    if (changedPaths(repo.root, active.base).length === 0) return;
    if (active.attempts >= limit || (active.environmental ?? 0) >= limit) {
      logEvent(repo, { event: 'stop-ungated', task: active.task.id, attempts: active.attempts });
      out(blockedMessage(active, `the gate failed ${Math.max(active.attempts, active.environmental ?? 0)} time(s) and its attempt budget is spent`));
      return;
    }
    const result = runGate({ repo, config: active.config, active, attempts: active.attempts + 1, deadlineSeconds: GATE_DEADLINE_SECONDS, lockWaitSeconds: LOCK_WAIT_SECONDS });
    // Environmental failures are not the candidate's fault and have their own budget.
    const field = result.environmental ? 'environmental' : 'attempts';
    const next = updateActive(repo, active.activation, (cur) => ({
      attempts: result.passed || result.status === 'pending' ? 0 : cur.attempts + (field === 'attempts' ? 1 : 0),
      environmental: result.passed || result.status === 'pending' ? 0 : (cur.environmental ?? 0) + (field === 'environmental' ? 1 : 0),
      last: { run_id: result.run_id, candidate: result.candidate_sha256, passed: result.passed, status: result.status },
    }));
    if (!next) return; // deactivated while the gate ran: the owner cancelled the task
    if (result.status === 'pending') return awaiting(); // only a person can supply what is missing
    if (result.passed) {
      out({ systemMessage: `Claude Harness: gate passed for ${active.task.id} (run ${result.run_id}). Ready for independent review; the owner decides when to ship.` });
      return;
    }
    const guidance = result.environmental
      ? 'This failure came from other activity on the Docker daemon, not from the candidate. Do not change code for it. Stop again to rerun the gate; if it repeats, tell the owner.'
      : result.status === 'blocked'
        ? 'A protected path, the harness configuration or Git state changed. Revert that change; if the task truly needs it, stop and ask the owner.'
        : 'Fix the cause within the allowed paths. Do not edit tests, Compose files or harness.json, and do not claim completion until the gate passes.';
    out({ decision: 'block', reason: `${summarize(result)}\n\n${guidance}\nAttempt ${next[field]} of ${limit}.` });
  } catch (e) {
    // A gate that could not run verified nothing: never let that end the turn silently.
    logEvent(repo, { event: 'stop-error', task: active.task.id, error: e.message });
    const next = bump('environmental');
    if (!next) return;
    if (next.environmental > limit) out(blockedMessage(active, `the gate could not run (${e.message})`));
    else out({ decision: 'block', reason: `Claude Harness: the gate could not run, so this candidate is unverified.\n${e.message}\nDo not change code for this. Stop again to retry; if it repeats, tell the owner.\nAttempt ${next.environmental} of ${limit}.` });
  }
}

const HANDLERS = { PreToolUse: preToolUse, SessionStart: sessionStart, Stop: stop, SubagentStop: stop };

try {
  const input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  HANDLERS[input.hook_event_name]?.(input);
} catch (e) {
  // A broken hook must not wedge the session: report and let the gate decide later.
  process.stderr.write(`claude-harness hook error: ${e.message}\n`);
  process.exit(1);
}
