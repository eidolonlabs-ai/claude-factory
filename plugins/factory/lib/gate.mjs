import fs from 'node:fs';
import path from 'node:path';
import { sh, git, bounded, tail, digest, runId, now, readJsonIfExists, writeJsonAtomic } from './util.mjs';
import { coveredBy, isSecretPath, protectedPaths } from './policy.mjs';
import { candidateHash, changedPaths, symlinkedPaths, integrityProblems } from './candidate.mjs';
import { runCompose } from './compose.mjs';
import { auditDiff } from './audit.mjs';
import { configPath, newRunDir, logEvent, withLock } from './state.mjs';
import { pendingManual, checkId } from './acceptance.mjs';

const check = (id, status, summary, extra = {}) => ({ id, status, summary, ...extra });

function scopeCheck(repo, active, config) {
  if (!active) return check('scope', 'NOT_RUN', 'no active task: scope was not checked');
  const changed = changedPaths(repo.root, active.base);
  const hidden = integrityProblems(repo.root, active.base, protectedPaths(config));
  const guarded = changed.filter((p) => coveredBy(protectedPaths(config), p));
  if (guarded.length > 0 || hidden.length > 0) {
    return check('scope', 'FAIL', 'protected paths or Git state changed: stop for the owner', { details: [...guarded, ...hidden], blocked: true });
  }
  const outside = changed.filter((p) => !coveredBy(active.task.allowed_paths, p) || !coveredBy(config.policy.editable_paths, p));
  const links = symlinkedPaths(repo.root, changed);
  if (outside.length > 0) return check('scope', 'FAIL', `${outside.length} changed path(s) outside the task's allowed paths`, { details: outside });
  if (links.length > 0) return check('scope', 'FAIL', 'changed paths traverse symlinks', { details: links });
  return check('scope', 'PASS', `${changed.length} changed path(s), all within scope`);
}

function frozenCheck(repo, active) {
  if (!active) return check('frozen', 'NOT_RUN', 'no active task: nothing is frozen');
  const live = readJsonIfExists(configPath(repo));
  if (!live) return check('frozen', 'FAIL', 'factory.json is missing', { blocked: true });
  if (digest(live) !== active.config_sha256) {
    return check('frozen', 'FAIL', 'factory.json differs from the configuration frozen at activation', { blocked: true });
  }
  if (digest(active.task) !== active.task_sha256 || digest(active.config) !== active.config_sha256) {
    return check('frozen', 'FAIL', 'the activation record no longer matches its digests', { blocked: true });
  }
  return check('frozen', 'PASS', 'configuration and task match their activation digests');
}

function hygieneCheck(repo) {
  const tracked = git(repo.root, 'ls-files', '-z').stdout.split('\0').filter(Boolean);
  const bad = tracked.filter(isSecretPath);
  if (bad.length > 0) return check('hygiene', 'FAIL', 'secrets are tracked by Git', { details: bad });
  if (fs.existsSync(path.join(repo.root, '.env')) && git(repo.root, 'check-ignore', '-q', '.env').code !== 0) {
    return check('hygiene', 'FAIL', '.env exists and is not git-ignored');
  }
  return check('hygiene', 'PASS', 'no tracked secrets; .env is absent or ignored');
}

function hostChecks(repo, config, runDir, budget) {
  return config.checks.map((c) => {
    if (budget(1) <= 0) return check(`verify:${c.name}`, 'FAIL', 'the gate ran out of time before this check');
    const r = sh(c.argv[0], c.argv.slice(1), { cwd: repo.root, timeout: budget(c.timeout_seconds ?? 600) });
    const log = path.join(runDir, `check-${c.name.replace(/[^A-Za-z0-9_.-]/g, '_')}.log`);
    fs.writeFileSync(log, bounded(`${r.stdout}\n${r.stderr}`));
    if (r.missing) return check(`verify:${c.name}`, 'NOT_RUN', `${c.argv[0]} was not found`, { log });
    if (r.code === 0) return check(`verify:${c.name}`, 'PASS', c.argv.join(' '), { log });
    return check(`verify:${c.name}`, 'FAIL', r.timedOut ? 'timed out' : `exited ${r.code}`, { details: [tail(`${r.stdout}\n${r.stderr}`, 20)], log });
  });
}

/**
 * Every criterion must be proven by something that ran on this candidate: a
 * cited check that passed, and any manual observation recorded against this
 * exact candidate digest.
 */
function acceptanceCheck(active, checks, candidate) {
  if (!active) return check('acceptance', 'NOT_RUN', 'no active task: no criteria to map');
  const status = (name) => checks.find((c) => c.id === checkId(name))?.status ?? 'NOT_RUN';
  const unproven = active.acceptance.criteria.flatMap((c) => c.checks.filter((k) => status(k) !== 'PASS').map((k) => `${c.id}: ${k} is ${status(k)}`));
  if (unproven.length > 0) return check('acceptance', 'FAIL', 'a cited check did not pass', { details: unproven });
  const pending = pendingManual(active.acceptance, active.evidence, candidate);
  if (pending.length > 0) {
    return check('acceptance', 'NOT_RUN', `${pending.length} manual observation(s) awaited from the owner for this candidate`, {
      details: pending.map((p) => `${p.criterion}: ${p.requirement}`), pending: true,
    });
  }
  return check('acceptance', 'PASS', `${active.acceptance.criteria.length} criteria proven on this candidate`);
}

function auditCheck(repo, base) {
  const findings = auditDiff(repo.root, base);
  const high = findings.filter((f) => f.severity === 'high');
  const list = findings.slice(0, 20).map((f) => `${f.severity} ${f.rule} ${f.where}`);
  if (high.length > 0) return check('diff-audit', 'FAIL', `${high.length} high-severity finding(s) in changed lines`, { details: list });
  return check('diff-audit', 'PASS', findings.length > 0 ? `${findings.length} lower-severity finding(s) to review` : 'no findings in changed lines', findings.length > 0 ? { details: list } : {});
}

/**
 * The gate (contract section 2). First failure stops; steps not reached are
 * NOT_RUN, and NOT_RUN is never PASS: acceptance needs the stack test to have
 * actually run and passed.
 *
 * @param {{repo: object, config: object, active?: object|null, role?: string, attempts?: number, deadlineSeconds?: number, lockWaitSeconds?: number}} opts
 *   `config` must be the configuration frozen at activation when a task is active.
 *   `deadlineSeconds` bounds everything except teardown, so a hook with a
 *   timeout is never killed with a stack still running.
 */
export function runGate({ repo, config, active = null, role = 'build', attempts = 0, deadlineSeconds = Infinity, lockWaitSeconds = 0 }) {
  return withLock(repo, () => {
    const deadline = Date.now() + deadlineSeconds * 1000;
    // Seconds a step may use: its own limit, capped by what is left overall.
    const budget = (seconds) => Math.floor(Math.min(seconds, (deadline - Date.now()) / 1000));
    const id = runId();
    const runDir = newRunDir(repo, id);
    const started = now();
    const before = candidateHash(repo.root);
    const checks = [];
    let stopped = false;
    const step = (ids, fn) => {
      if (stopped) {
        ids.forEach((i) => checks.push(check(i, 'NOT_RUN', 'not reached: an earlier step failed')));
        return;
      }
      const produced = [fn()].flat();
      checks.push(...produced);
      if (produced.some((c) => c.status === 'FAIL')) stopped = true;
    };

    step(['scope'], () => scopeCheck(repo, active, config));
    step(['frozen'], () => frozenCheck(repo, active));
    step(['hygiene'], () => hygieneCheck(repo));
    step(['compose:e2e'], () => {
      const host = hostChecks(repo, config, runDir, budget);
      if (host.some((c) => c.status === 'FAIL')) return [...host, check('compose:e2e', 'NOT_RUN', 'not reached: a configured check failed')];
      return [...host, ...runCompose({ root: repo.root, compose: config.compose, runDir, id, budget })];
    });
    step(['acceptance'], () => acceptanceCheck(active, checks, before));
    step(['holdouts'], () => check('holdouts', 'NOT_RUN', 'no holdouts configured (they need a separate verifier identity)'));
    step(['diff-audit'], () => auditCheck(repo, active?.base));
    const after = candidateHash(repo.root);
    step(['candidate'], () => (after === before
      ? check('candidate', 'PASS', 'the candidate did not change while the gate ran')
      : check('candidate', 'FAIL', 'the candidate changed while the gate ran: evidence does not describe it')));

    const failed = checks.filter((c) => c.status === 'FAIL');
    const e2e = checks.find((c) => c.id === 'compose:e2e');
    const unrun = checks.filter((c) => c.id.startsWith('verify:') && c.status === 'NOT_RUN');
    const ran = failed.length === 0 && e2e?.status === 'PASS' && unrun.length === 0;
    // Without a task nothing checks scope or frozen inputs: such a run can show
    // that the stack works, and can never be acceptance evidence.
    const accepted = checks.find((c) => c.id === 'acceptance');
    const passed = ran && Boolean(active) && accepted?.status === 'PASS';
    const pending = ran && Boolean(active) && Boolean(accepted?.pending);
    const blocked = failed.some((c) => c.blocked);
    const head = git(repo.root, 'rev-parse', '--verify', '-q', 'HEAD');
    const result = {
      schema_version: 1,
      run_id: id,
      project: path.basename(repo.root),
      milestone: 'M1',
      task: active?.task.id ?? null,
      activation: active?.activation ?? null,
      role,
      engine: 'claude-code',
      status: passed ? 'passed' : pending ? 'pending' : ran && !active ? 'baseline' : blocked ? 'blocked' : 'failed',
      passed,
      merged: false,
      attempts,
      checks: checks.map(({ blocked: _b, environmental: _e, pending: _p, ...c }) => c),
      environmental: failed.length > 0 && failed.every((c) => c.environmental),
      candidate_sha256: after,
      base: active?.base ?? null,
      head_sha: head.code === 0 ? head.stdout.trim() : null,
      worktree: repo.root,
      evidence: runDir,
      started,
      finished: now(),
      cost_usd: null,
    };
    writeJsonAtomic(path.join(runDir, 'result.json'), result);
    logEvent(repo, { event: 'gate', run_id: id, task: result.task, status: result.status });
    return result;
  }, lockWaitSeconds);
}

/** Short, log-free summary for a terminal or a hook reason. */
export function summarize(result) {
  const lines = [`Gate ${result.status.toUpperCase()} · run ${result.run_id}${result.task ? ` · task ${result.task}` : ''}`];
  for (const c of result.checks) {
    lines.push(`  ${c.status.padEnd(7)} ${c.id} - ${c.summary}`);
    if (c.status === 'FAIL') {
      for (const d of (c.details ?? []).slice(0, 12)) lines.push(...String(d).split('\n').map((l) => `            ${l}`));
      if (c.log) lines.push(`            log: ${c.log}`);
    }
  }
  if (result.status === 'pending') {
    const a = result.checks.find((c) => c.id === 'acceptance');
    lines.push('  Automated checks passed. Awaiting the owner\'s manual observation on this candidate:');
    (a.details ?? []).forEach((d) => lines.push(`            ${d}`));
    lines.push('  The owner records each with: factory evidence <criterion-id> --note "<what was observed>"');
  } else if (result.status === 'baseline') {
    lines.push('  Baseline only: no task is active, so scope and frozen inputs were not checked. This is not acceptance evidence.');
  } else if (!result.passed && result.status !== 'blocked' && !result.checks.some((c) => c.status === 'FAIL')) {
    lines.push('  Required checks did not run. NOT_RUN is never PASS.');
  }
  lines.push(`Candidate ${result.candidate_sha256.slice(0, 12)} · evidence ${result.evidence}`);
  return lines.join('\n');
}
