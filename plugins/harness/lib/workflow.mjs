import fs from 'node:fs';
import path from 'node:path';
import { sh, git, gitOut, fail, digest, now, readJson, readJsonIfExists, writeJsonAtomic, bounded, tail } from './util.mjs';
import { coveredBy, covers, protectedPaths } from './policy.mjs';
import { loadConfig, validateTaskInRepo, validateTask } from './config.mjs';
import { changedPaths, candidateHash, integrityProblems } from './candidate.mjs';
import { repoInfo, requireRepo, getActive, setActive, updateActive, clearActive, latestResult, logEvent } from './state.mjs';
import { runGate, summarize } from './gate.mjs';

const planPath = (repo, id) => path.join(repo.state, 'plans', `${id}.json`);

/** The approved plan that contains this exact task, if any. */
function planFor(repo, taskDigest) {
  const dir = path.join(repo.state, 'plans');
  if (!fs.existsSync(dir)) return null;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    const plan = readJson(path.join(dir, f));
    if ((plan.approved ?? []).includes(taskDigest)) return plan;
  }
  return null;
}

/**
 * A plan approval covers one builder per node. The parent task is activated
 * only by `integrate`; a node claimed by one worktree cannot be taken by another.
 */
function claimApproved(repo, task, integration) {
  const d = digest(task);
  const plan = planFor(repo, d) ?? fail('--approved needs a task the owner approved through approve-plan; this task digest is not on record');
  const isParent = digest(plan.task) === d;
  if (isParent !== Boolean(integration)) {
    fail(isParent ? 'the parent task of a plan is activated by `harness integrate`, in its integration worktree' : 'integration activates the plan\'s parent task only');
  }
  if (isParent) return;
  const claims = plan.claims ?? {};
  if (claims[d] && claims[d] !== repo.root && fs.existsSync(claims[d])) fail(`task ${task.id} is already claimed by the builder in ${claims[d]}`);
  writeJsonAtomic(planPath(repo, plan.task.id), { ...plan, claims: { ...claims, [d]: repo.root } });
}

/**
 * Freeze an approved task, its resolved base and the current configuration
 * for this worktree. From here the guard enforces scope and Stop runs the gate.
 */
export function activate(cwd, taskFile, { approved = false, controller = false, integration = false } = {}) {
  const repo = requireRepo(cwd);
  const config = loadConfig(repo);
  const task = readJson(path.resolve(cwd, taskFile));
  const { errors, base } = validateTaskInRepo(task, config, repo);
  if (errors.length > 0) fail(`task is not ready:\n  - ${errors.join('\n  - ')}`);
  const current = getActive(repo);
  if (current) fail(`task ${current.task.id} is already active in this worktree; deactivate it first`);
  const dirty = [
    ...changedPaths(repo.root, base).filter((p) => coveredBy(protectedPaths(config), p)),
    ...integrityProblems(repo.root, base, protectedPaths(config)),
  ];
  if (dirty.length > 0) fail(`protected paths already differ from the base; commit or revert them first:\n  - ${dirty.join('\n  - ')}`);
  if (approved) claimApproved(repo, task, integration);
  const record = {
    schema_version: 1,
    activation: `${digest(task).slice(0, 12)}-${Date.now().toString(36)}`,
    task,
    task_sha256: digest(task),
    config,
    config_sha256: digest(config),
    base,
    worktree: repo.root,
    activated_at: now(),
    approval: approved ? 'plan' : controller ? 'controller' : 'owner',
    attempts: 0,
    last: null,
  };
  setActive(repo, record);
  logEvent(repo, { event: 'activate', task: task.id, base });
  return record;
}

export function deactivate(cwd) {
  const repo = requireRepo(cwd);
  const record = clearActive(repo);
  if (!record) fail('no task is active in this worktree');
  logEvent(repo, { event: 'deactivate', task: record.task.id });
  return record;
}

/** Run the gate for the active task, or configuration-only checks when none is active. */
export function verify(cwd, { role = 'build' } = {}) {
  const repo = requireRepo(cwd);
  const active = getActive(repo);
  const config = active ? active.config : loadConfig(repo);
  const result = runGate({ repo, config, active, role, attempts: active?.attempts ?? 0 });
  if (active) {
    updateActive(repo, active.activation, (cur) => ({
      attempts: result.passed ? 0 : cur.attempts, // an explicit pass clears a spent Stop budget
      environmental: result.passed ? 0 : cur.environmental,
      last: { run_id: result.run_id, candidate: result.candidate_sha256, passed: result.passed, status: result.status },
    }));
  }
  return result;
}

export function status(cwd) {
  const repo = requireRepo(cwd);
  const active = getActive(repo);
  const last = latestResult(repo, active?.activation);
  const candidate = candidateHash(repo.root);
  return {
    worktree: repo.root,
    adopted: fs.existsSync(path.join(repo.root, 'harness.json')),
    state: repo.state,
    active: active && {
      id: active.task.id,
      title: active.task.title,
      base: active.base,
      allowed_paths: active.task.allowed_paths,
      attempts: active.attempts,
      attempt_limit: active.config.limits?.attempts ?? 3,
      activated_at: active.activated_at,
    },
    candidate,
    last: last && { run_id: last.run_id, status: last.status, finished: last.finished, fresh: last.candidate_sha256 === candidate, evidence: last.evidence },
  };
}

/** Everything a fresh reviewer needs, and nothing from the builder's conversation. */
export function reviewPacket(cwd) {
  const repo = requireRepo(cwd);
  const active = getActive(repo) ?? fail('no task is active in this worktree: activate the approved task before review');
  const last = latestResult(repo, active.activation);
  const candidate = candidateHash(repo.root);
  const changed = changedPaths(repo.root, active.base);
  const diff = git(repo.root, 'diff', '--no-color', '--no-ext-diff', active.base, '--').stdout;
  const untracked = git(repo.root, 'ls-files', '-o', '--exclude-standard').stdout.split('\n').filter((p) => p && !p.startsWith('.claude/worktrees/'));
  const lines = [
    '# Review packet',
    '',
    `Task: ${active.task.id} - ${active.task.title}`,
    `Base: ${active.base}`,
    `Candidate: ${candidate}`,
    `Worktree: ${repo.root}`,
    '',
    '## Specification',
    active.task.specification,
    '',
    '## Acceptance criteria',
    ...active.task.acceptance_criteria.map((c, i) => `${i + 1}. ${c}`),
    '',
    '## Allowed paths',
    ...active.task.allowed_paths.map((p) => `- ${p}`),
    '',
    '## Gate evidence',
    !last ? 'No gate has run for this task. Treat the candidate as unverified.'
      : last.candidate_sha256 !== candidate ? `STALE: the last gate (${last.run_id}, ${last.status}) covered a different candidate. Treat the candidate as unverified.`
        : summarize(last),
    '',
    '## Changed paths',
    ...changed.map((p) => `- ${p}`),
    '',
    '## Diff against base (untracked files are listed, read them directly)',
    ...untracked.map((p) => `untracked: ${p}`),
    '```diff',
    bounded(diff, 150 * 1024),
    '```',
  ];
  return lines.join('\n');
}

function validatePlan(plan, config, repo) {
  const e = [];
  if (plan?.schema_version !== 1 || !plan.task || !Array.isArray(plan.nodes) || plan.nodes.length < 1 || plan.nodes.length > 32) {
    return ['plan needs schema_version 1, a parent task and 1-32 nodes'];
  }
  const parent = validateTaskInRepo(plan.task, config, repo);
  e.push(...parent.errors.map((x) => `parent: ${x}`));
  const ids = new Set();
  for (const n of plan.nodes) {
    const errs = validateTask(n.task);
    const id = n.task?.id ?? '?';
    e.push(...errs.map((x) => `${id}: ${x}`));
    if (errs.length > 0) continue;
    if (ids.has(id) || id === plan.task.id) e.push(`${id}: duplicate task id`);
    ids.add(id);
    if (n.task.base_ref !== plan.task.base_ref) e.push(`${id}: base_ref must equal the parent's base`);
    for (const p of n.task.allowed_paths) if (!coveredBy(plan.task.allowed_paths, p)) e.push(`${id}: path "${p}" is outside the parent task's allowed paths`);
    if (!Array.isArray(n.depends_on ?? [])) e.push(`${id}: depends_on must be an array`);
  }
  if (e.length > 0) return e;
  const deps = new Map(plan.nodes.map((n) => [n.task.id, n.depends_on ?? []]));
  for (const [id, ds] of deps) for (const d of ds) if (!deps.has(d)) e.push(`${id}: unknown dependency "${d}"`);
  const reaches = (from, to, seen = new Set()) => from === to || (!seen.has(from) && seen.add(from) && (deps.get(from) ?? []).some((d) => reaches(d, to, seen)));
  for (const id of deps.keys()) if ((deps.get(id) ?? []).some((d) => reaches(d, id))) e.push(`${id}: dependency cycle`);
  const overlap = (a, b) => a.some((x) => b.some((y) => covers(x, y) || covers(y, x)));
  for (let i = 0; i < plan.nodes.length; i += 1) {
    for (let j = i + 1; j < plan.nodes.length; j += 1) {
      const [a, b] = [plan.nodes[i].task, plan.nodes[j].task];
      if (overlap(a.allowed_paths, b.allowed_paths) && !reaches(a.id, b.id) && !reaches(b.id, a.id)) {
        e.push(`${a.id} and ${b.id} own overlapping paths: add a dependency so they do not run in parallel`);
      }
    }
  }
  return e;
}

/** Owner checkpoint: record the plan so builders can activate their own nodes. */
export function approvePlan(cwd, planFile) {
  const repo = requireRepo(cwd);
  const config = loadConfig(repo);
  const plan = readJson(path.resolve(cwd, planFile));
  const errors = validatePlan(plan, config, repo);
  if (errors.length > 0) fail(`plan is not ready:\n  - ${errors.join('\n  - ')}`);
  // Pin the base now. A symbolic ref such as HEAD would resolve differently
  // after builders commit or branches merge, and scope would be measured
  // against the wrong commit.
  const base = gitOut(repo.root, 'rev-parse', '--verify', `${plan.task.base_ref}^{commit}`);
  const pin = (t) => ({ ...t, base_ref: base });
  const pinned = { ...plan, task: pin(plan.task), nodes: plan.nodes.map((n) => ({ ...n, task: pin(n.task) })) };
  const tasks = [pinned.task, ...pinned.nodes.map((n) => n.task)];
  const record = { ...pinned, approved_at: now(), approved: tasks.map(digest), claims: {} };
  writeJsonAtomic(planPath(repo, plan.task.id), record);
  const dir = path.join(repo.state, 'plans', plan.task.id);
  fs.mkdirSync(dir, { recursive: true });
  for (const t of tasks) writeJsonAtomic(path.join(dir, `${t.id}.json`), t);
  logEvent(repo, { event: 'approve-plan', task: plan.task.id, nodes: plan.nodes.length });
  return { plan: record, tasks: dir };
}

function topological(plan) {
  const done = [];
  const visit = (id) => {
    if (done.includes(id)) return;
    (plan.nodes.find((n) => n.task.id === id).depends_on ?? []).forEach(visit);
    done.push(id);
  };
  plan.nodes.forEach((n) => visit(n.task.id));
  return done;
}

/**
 * Merge builder branches in dependency order into a retained integration
 * worktree and gate the combined candidate there. Never touches the branch
 * the owner is on.
 */
export function integrate(cwd, planId, branches) {
  const repo = requireRepo(cwd);
  const plan = readJsonIfExists(planPath(repo, planId)) ?? fail(`no approved plan "${planId}"`);
  const order = topological(plan);
  const missing = order.filter((id) => !branches[id]);
  if (missing.length > 0) fail(`no branch given for: ${missing.join(', ')} (pass --branch <task-id>=<ref>)`);
  const base = gitOut(repo.root, 'rev-parse', '--verify', `${plan.task.base_ref}^{commit}`);
  for (const id of order) {
    const ahead = git(repo.root, 'rev-list', '--count', `${base}..${branches[id]}`);
    if (ahead.code !== 0) fail(`branch ${branches[id]} for ${id} does not exist`);
    if (ahead.stdout.trim() === '0') fail(`branch ${branches[id]} for ${id} has no commits beyond the base: that builder delivered nothing`);
  }
  const stamp = Date.now().toString(36);
  const branch = `harness/integration/${planId}-${stamp}`;
  const tree = path.join(repo.root, '.claude', 'worktrees', `harness-integration-${planId}-${stamp}`);
  gitOut(repo.root, 'worktree', 'add', '-b', branch, tree, base);
  // Freeze the task and configuration from the clean base, before any builder's code arrives.
  activate(tree, path.join(repo.state, 'plans', planId, `${planId}.json`), { approved: true, integration: true });
  for (const id of order) {
    const m = git(tree, 'merge', '--no-ff', '--no-edit', '-m', `harness: integrate ${id}`, branches[id]);
    if (m.code !== 0) {
      git(tree, 'merge', '--abort');
      fail(`merging ${id} (${branches[id]}) conflicted; resolve it with the owner. Integration worktree retained at ${tree}\n${tail(m.stdout + m.stderr, 10)}`);
    }
  }
  const result = verify(tree);
  return { worktree: tree, branch, result };
}

/**
 * Managed unattended run: a headless Claude Code session per attempt in a
 * dedicated worktree, with the gate run here, outside the agent's session.
 */
export function managedRun(cwd, taskFile) {
  const repo = requireRepo(cwd);
  const config = loadConfig(repo);
  const task = readJson(path.resolve(cwd, taskFile));
  const { errors, base } = validateTaskInRepo(task, config, repo);
  if (errors.length > 0) fail(`task is not ready:\n  - ${errors.join('\n  - ')}`);
  const stamp = Date.now().toString(36);
  const branch = `harness/${task.id}-${stamp}`;
  const tree = path.join(repo.root, '.claude', 'worktrees', `harness-run-${task.id}-${stamp}`);
  gitOut(repo.root, 'worktree', 'add', '-b', branch, tree, base);
  const frozen = path.join(repo.state, 'managed', `${task.id}-${stamp}.json`);
  writeJsonAtomic(frozen, task);
  const record = activate(tree, frozen, { controller: true });
  const wt = repoInfo(tree);
  const limit = record.config.limits?.attempts ?? 3;
  const bin = process.env.CLAUDE_HARNESS_CLAUDE_BIN ?? 'claude';
  const extra = (process.env.CLAUDE_HARNESS_CLAUDE_ARGS ?? '--permission-mode acceptEdits').split(/\s+/).filter(Boolean);
  let feedback = '';
  let result = null;
  let cost = 0;
  for (let attempt = 1; attempt <= limit; attempt += 1) {
    const prompt = [
      `Implement harness task "${task.id}": ${task.title}`,
      '', task.specification, '',
      'Acceptance criteria:', ...task.acceptance_criteria.map((c) => `- ${c}`), '',
      `Edit only: ${task.allowed_paths.join(', ')}. Do not edit tests, Compose files or harness.json.`,
      'A controller verifies your work on a real Docker Compose stack after you stop; your own report is not evidence.',
      feedback && `\nThe previous attempt failed the gate. Fix the cause, not the checks:\n${feedback}`,
    ].filter(Boolean).join('\n');
    const r = sh(bin, ['-p', '--output-format', 'json', ...extra], {
      cwd: tree, input: prompt, timeout: record.config.limits?.agent_seconds ?? 1200,
      env: { ...process.env, CLAUDE_HARNESS_MANAGED: '1' },
    });
    fs.mkdirSync(path.join(wt.state, 'managed'), { recursive: true });
    fs.writeFileSync(path.join(wt.state, 'managed', `${task.id}-${stamp}-attempt-${attempt}.log`), bounded(`${r.stdout}\n${r.stderr}`));
    if (r.missing) fail(`${bin} was not found; install Claude Code or set CLAUDE_HARNESS_CLAUDE_BIN`);
    try {
      cost += JSON.parse(r.stdout).total_cost_usd ?? 0;
    } catch {
      // non-JSON output is kept in the attempt log
    }
    if (!updateActive(wt, record.activation, () => ({ attempts: attempt }))) fail(`the task was deactivated during the run; worktree retained at ${tree}`);
    result = verify(tree);
    if (result.passed || result.status === 'blocked') break;
    feedback = summarize(result);
  }
  return { worktree: tree, branch, result, cost_usd: cost || null };
}
