#!/usr/bin/env node
// Claude Code hook entry point. One process per event; stdin carries the
// event JSON and stdout carries the decision. The guard is a convenience that
// stops honest mistakes early; the gate is the authority.
import fs from 'node:fs';
import path from 'node:path';
import { decide } from '../lib/guard.mjs';
import { protectedPaths } from '../lib/policy.mjs';
import { repoInfo, isAdopted, getActive, setActive, logEvent } from '../lib/state.mjs';
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
  const dir = existingDir(p);
  if (!dir) return p;
  const real = fs.realpathSync(dir);
  const rest = path.relative(dir, p);
  return rest && !rest.startsWith('..') ? path.join(real, rest) : real;
}

/** The adopted checkout that owns `where`, or null: elsewhere the plugin stays silent. */
function adopted(where) {
  const dir = where && existingDir(where);
  const repo = dir && repoInfo(dir);
  return repo && isAdopted(repo) ? repo : null;
}

function guardContext(repo) {
  const active = getActive(repo);
  if (!active) return {};
  return { task: active.task, protected: protectedPaths(active.config), editable: active.config.policy.editable_paths };
}

function preToolUse(input) {
  const cwd = canonical(input.cwd ?? process.cwd());
  const raw = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
  const target = raw && canonical(path.resolve(cwd, raw));
  // A file edit belongs to the checkout that contains the file, which for a
  // worktree subagent is not necessarily the session's directory.
  const repo = adopted(target ?? cwd);
  if (!repo) return;
  const unattended = managed() || process.env.CLAUDE_HARNESS_UNATTENDED === '1' || UNATTENDED_MODES.has(input.permission_mode);
  const toolInput = target ? { ...input.tool_input, file_path: target, notebook_path: undefined } : input.tool_input;
  const verdict = decide({ tool: input.tool_name, input: toolInput, root: repo.root, cwd, ctx: guardContext(repo), unattended });
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
  const repo = adopted(input.cwd ?? process.cwd());
  if (!repo) return;
  const active = getActive(repo);
  const lines = active
    ? [
      `Claude Harness: task "${active.task.id}" (${active.task.title}) is active in this worktree.`,
      `Edit only: ${active.task.allowed_paths.join(', ')}. Tests, Compose files and harness.json are protected acceptance inputs.`,
      `The gate boots the real Docker Compose stack when you stop; attempts used: ${active.attempts}/${active.config.limits?.attempts ?? 3}.`,
      'Your own report is never evidence. If the task cannot be met within scope, stop and tell the owner.',
    ]
    : ['Claude Harness: this repository is adopted and no task is active. Use the intake skill to draft a task; the owner activates it.'];
  out({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: lines.join('\n') } });
}

/** Stop and SubagentStop: verify the candidate before the turn may end. */
function stop(input) {
  const repo = adopted(input.cwd ?? process.cwd());
  if (!repo || managed()) return; // a managed run's controller gates outside the session
  const active = getActive(repo);
  if (!active) return;
  const limit = active.config.limits?.attempts ?? 3;
  const candidate = candidateHash(repo.root);
  if (active.last?.candidate === candidate && active.last.passed) return;
  if (changedPaths(repo.root, active.base).length === 0) return;
  if (active.attempts >= limit) {
    out({ systemMessage: `Claude Harness: task ${active.task.id} is BLOCKED. The gate failed ${active.attempts} time(s); run /harness:status and decide how to proceed.` });
    return;
  }
  const result = runGate({ repo, config: active.config, active, attempts: active.attempts + 1 });
  const attempts = result.passed ? 0 : active.attempts + 1;
  setActive(repo, { ...active, attempts, last: { run_id: result.run_id, candidate: result.candidate_sha256, passed: result.passed, status: result.status } });
  if (result.passed) {
    out({ systemMessage: `Claude Harness: gate passed for ${active.task.id} (run ${result.run_id}). Ready for independent review; the owner decides when to ship.` });
    return;
  }
  const guidance = result.environmental
    ? 'This failure came from other activity on the Docker daemon, not from the candidate. Do not change code for it. Stop again to rerun the gate; if it repeats, tell the owner.'
    : result.status === 'blocked'
    ? 'A protected path or the harness configuration changed. Revert that change; if the task truly needs it, stop and ask the owner.'
    : 'Fix the cause within the allowed paths. Do not edit tests, Compose files or harness.json, and do not claim completion until the gate passes.';
  out({ decision: 'block', reason: `${summarize(result)}\n\n${guidance}\nAttempt ${attempts} of ${limit}.` });
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
