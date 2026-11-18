import { digest } from './util.mjs';

export const REMINDER = 'Confirm that each proposed check actually proves its criterion (or name a manual observation), then remove this line.';
export const E2E = 'compose:e2e';

/** Check names a criterion may cite: the stack test and the configured checks. */
export const checkNames = (config) => [E2E, ...config.checks.map((c) => c.name)];
/** Gate check id for a cited name. */
export const checkId = (name) => (name === E2E ? E2E : `verify:${name}`);

/**
 * Draft record for owner review. It proposes the stack test for every
 * criterion and carries a reminder that blocks activation until someone has
 * actually looked at the mapping.
 */
export function draftAcceptance(task, base) {
  return {
    schema_version: 1,
    task_sha256: digest(task),
    base,
    unresolved_decisions: [REMINDER],
    criteria: task.acceptance_criteria.map((criterion, i) => ({ id: `c${i + 1}`, criterion, checks: [E2E], manual: [] })),
    manual_evidence: [],
  };
}

const strings = (v) => Array.isArray(v) && v.every((s) => typeof s === 'string' && s.trim().length > 0);

/** A record is ready when it maps every criterion of this exact task, once, to something observable. */
export function validateAcceptance(rec, task, base, config, { allowManual = true } = {}) {
  const e = [];
  if (!rec || typeof rec !== 'object' || rec.schema_version !== 1) return ['acceptance record needs schema_version 1'];
  if (rec.task_sha256 !== digest(task)) e.push('task_sha256 does not match this task: regenerate the record with `harness prepare`');
  if (rec.base !== base) e.push(`base ${String(rec.base).slice(0, 12)} is not the task's resolved base ${base.slice(0, 12)}: regenerate the record`);
  if (!strings(rec.unresolved_decisions)) e.push('unresolved_decisions must be an array of strings');
  else if (rec.unresolved_decisions.length > 0) e.push(`unresolved decisions remain:\n      ${rec.unresolved_decisions.join('\n      ')}`);
  if (!Array.isArray(rec.manual_evidence) || rec.manual_evidence.length > 0) e.push('manual_evidence must be empty: observations are recorded with `harness evidence` against a specific candidate');
  if (!Array.isArray(rec.criteria)) return [...e, 'criteria must be an array'];
  const known = checkNames(config);
  const ids = new Set();
  const seen = new Map();
  for (const c of rec.criteria) {
    const where = `criterion ${c?.id ?? '?'}`;
    if (!c || typeof c.id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(c.id) || ids.has(c.id)) e.push(`${where}: id must be unique and alphanumeric`);
    ids.add(c?.id);
    seen.set(c?.criterion, (seen.get(c?.criterion) ?? 0) + 1);
    if (!task.acceptance_criteria.includes(c?.criterion)) e.push(`${where}: text is not one of the task's acceptance criteria`);
    if (!strings(c?.checks) || !strings(c?.manual)) {
      e.push(`${where}: checks and manual must be arrays of strings`);
      continue;
    }
    if (c.checks.length + c.manual.length === 0) e.push(`${where}: nothing proves it; cite a check or name a manual observation`);
    for (const k of c.checks) if (!known.includes(k)) e.push(`${where}: unknown check "${k}" (available: ${known.join(', ')})`);
    if (!allowManual && c.manual.length > 0) e.push(`${where}: manual observations are not allowed here; put them on the parent task`);
  }
  for (const criterion of task.acceptance_criteria) {
    const n = seen.get(criterion) ?? 0;
    if (n !== 1) e.push(`"${criterion.slice(0, 60)}" is mapped ${n} times; map each criterion exactly once`);
  }
  return e;
}

/** Manual requirements with no observation recorded for this exact candidate. */
export function pendingManual(rec, evidence, candidate) {
  const pending = [];
  for (const c of rec.criteria) {
    c.manual.forEach((requirement, index) => {
      const ok = (evidence ?? []).some((ev) => ev.criterion === c.id && ev.requirement === index && ev.candidate === candidate);
      if (!ok) pending.push({ criterion: c.id, index, requirement });
    });
  }
  return pending;
}
