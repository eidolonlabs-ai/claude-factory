#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { HarnessError, readJson } from '../lib/util.mjs';
import { requireRepo } from '../lib/state.mjs';
import { loadConfig, validateTaskInRepo } from '../lib/config.mjs';
import { summarize } from '../lib/gate.mjs';
import { decide } from '../lib/guard.mjs';
import { setup, doctor } from '../lib/setup.mjs';
import * as wf from '../lib/workflow.mjs';

const USAGE = `Claude Harness

  harness setup [--apply]            preview or apply the adoption scaffold
  harness doctor                     check Node, Git, Docker and harness.json
  harness check-task <task.json>     validate a task draft against this repository
  harness prepare <task.json> [--out <file>]
                                     draft the acceptance record: which check proves each criterion
  harness activate <task.json> --acceptance <record.json>
                                     owner checkpoint: freeze the task for this worktree
  harness evidence <criterion-id> --note <text> [--requirement <n>]
                                     owner checkpoint: record a manual observation on this candidate
  harness deactivate                 archive the active task
  harness verify                     run the gate on this worktree
  harness status                     active task, candidate and last gate
  harness review-packet              task, evidence and diff for a fresh reviewer
  harness approve-plan <plan.json>   owner checkpoint: approve a parallel task graph
  harness integrate <plan-id> --branch <task-id>=<ref> ...
                                     merge builder branches and gate the result
  harness run <task.json> --acceptance <record.json>
                                     managed unattended run in a new worktree
  harness guard-test <cases.json>    run guard decision cases

Options: --repo <path> (default: current directory), --json
Exit codes: 0 pass, 1 gate or validation failure, 2 usage or environment error,
3 baseline (the stack passed with no active task: not acceptance evidence).`;

function parse(argv) {
  const opts = { _: [], branch: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--repo') opts.repo = argv[++i];
    else if (a === '--branch') {
      const [id, ...ref] = String(argv[++i] ?? '').split('=');
      opts.branch[id] = ref.join('=');
    } else if (['--acceptance', '--note', '--out', '--requirement'].includes(a)) opts[a.slice(2)] = argv[++i];
    else if (a.startsWith('--')) opts[a.slice(2)] = true;
    else opts._.push(a);
  }
  return opts;
}

const opts = parse(process.argv.slice(2));
const [command, arg] = opts._;
const cwd = path.resolve(opts.repo ?? process.cwd());
const print = (value, text) => console.log(opts.json ? JSON.stringify(value, null, 2) : text);
const need = (what) => {
  if (!arg) {
    console.error(`harness ${command}: ${what} is required\n\n${USAGE}`);
    process.exit(2);
  }
  return arg;
};
const gateExit = (result) => {
  print(result, summarize(result));
  process.exit(result.passed ? 0 : result.status === 'baseline' ? 3 : 1);
};

try {
  switch (command) {
    case 'setup': {
      const r = setup(cwd, opts.apply);
      print(r, [`${r.applied ? 'Applied to' : 'Preview for'} ${r.root}`, ...r.plan.map((p) => `  ${p.action.padEnd(6)} ${p.path} - ${p.note}`), r.applied ? '' : '\nNothing was written. Re-run with --apply.'].join('\n'));
      break;
    }
    case 'doctor': {
      const r = doctor(cwd);
      print(r, r.items.map((i) => `  ${i.ok ? 'ok  ' : 'FAIL'} ${i.name.padEnd(13)} ${i.detail}`).join('\n'));
      process.exit(r.ok ? 0 : 1);
      break;
    }
    case 'check-task': {
      const repo = requireRepo(cwd);
      const { errors, base } = validateTaskInRepo(readJson(path.resolve(need('a task file'))), loadConfig(repo), repo);
      print({ ok: errors.length === 0, errors, base }, errors.length === 0 ? `Task is valid. Base resolves to ${base}.` : `Task is not ready:\n  - ${errors.join('\n  - ')}`);
      process.exit(errors.length === 0 ? 0 : 1);
      break;
    }
    case 'prepare': {
      const r = wf.prepare(cwd, need('a task file'));
      const text = `${JSON.stringify(r, null, 2)}\n`;
      if (opts.out) {
        fs.mkdirSync(path.dirname(path.resolve(opts.out)), { recursive: true });
        fs.writeFileSync(path.resolve(opts.out), text);
        console.log(`Draft acceptance record written to ${path.resolve(opts.out)}\nReview which check proves each criterion, add manual observations where no check can, then clear unresolved_decisions.`);
      } else process.stdout.write(text);
      break;
    }
    case 'evidence': {
      const r = wf.recordEvidence(cwd, need('a criterion id'), { note: opts.note, requirement: opts.requirement });
      print(r, `Recorded ${r.recorded.length} observation(s) for candidate ${r.candidate.slice(0, 12)}.${r.pending.length ? `\nStill awaited: ${r.pending.map((p) => `${p.criterion}: ${p.requirement}`).join('; ')}` : '\nNo manual observations remain. Run `harness verify` to complete acceptance.'}`);
      break;
    }
    case 'activate': {
      const r = wf.activate(cwd, need('a task file'), { approved: opts.approved, acceptance: opts.acceptance });
      print(r, `Activated ${r.task.id} at base ${r.base.slice(0, 12)} in ${r.worktree}\nAllowed paths: ${r.task.allowed_paths.join(', ')}\nThe guard now enforces scope and the gate runs when the session stops.`);
      break;
    }
    case 'deactivate': {
      const r = wf.deactivate(cwd);
      print(r, `Deactivated ${r.task.id}. Its record was archived.`);
      break;
    }
    case 'verify':
      gateExit(wf.verify(cwd, { role: opts.review ? 'review' : 'build' }));
      break;
    case 'status': {
      const s = wf.status(cwd);
      print(s, [
        `Worktree: ${s.worktree}${s.adopted ? '' : ' (not adopted: no harness.json)'}`,
        s.active ? `Active task: ${s.active.id} - ${s.active.title}\n  base ${s.active.base.slice(0, 12)} · attempts ${s.active.attempts}/${s.active.attempt_limit}\n  allowed: ${s.active.allowed_paths.join(', ')}` : 'Active task: none',
        ...(s.pending_manual.length ? [`Awaiting manual observation on this candidate:\n${s.pending_manual.map((p) => `  ${p.criterion}: ${p.requirement}`).join('\n')}`] : []),
        s.last ? `Last gate: ${s.last.status} (${s.last.run_id})${s.last.fresh ? '' : ' - STALE: the candidate changed since'}\n  evidence: ${s.last.evidence}` : 'Last gate: none',
        `Candidate: ${s.candidate.slice(0, 12)}`,
      ].join('\n'));
      break;
    }
    case 'review-packet':
      console.log(wf.reviewPacket(cwd));
      break;
    case 'approve-plan': {
      const r = wf.approvePlan(cwd, need('a plan file'));
      print(r, `Approved plan ${r.plan.task.id} with ${r.plan.nodes.length} node(s).\nNode tasks: ${r.tasks}\nBuilders activate with: harness activate <task> --approved`);
      break;
    }
    case 'integrate': {
      const r = wf.integrate(cwd, need('a plan id'), opts.branch);
      if (!opts.json) console.log(`Integration worktree: ${r.worktree}\nBranch: ${r.branch}`);
      gateExit(r.result);
      break;
    }
    case 'run': {
      const r = wf.managedRun(cwd, need('a task file'), opts.acceptance);
      if (!opts.json) console.log(`Worktree: ${r.worktree}\nBranch: ${r.branch}${r.cost_usd ? `\nCost: $${r.cost_usd.toFixed(2)}` : ''}`);
      gateExit(r.result);
      break;
    }
    case 'guard-test': {
      const suite = JSON.parse(fs.readFileSync(path.resolve(need('a cases file')), 'utf8'));
      const c = suite.context;
      const ctx = { controlPrefixes: [c.control_dir], controlFiles: [], frozen: c.frozen, holdoutMarkers: c.holdout_markers };
      const bad = suite.cases.filter((k) => decide({ tool: k.tool, input: k.input, root: c.root, cwd: c.root, ctx }).decision !== k.expect);
      print({ total: suite.cases.length, failed: bad.map((k) => k.id) }, `${suite.cases.length - bad.length}/${suite.cases.length} guard cases pass${bad.length ? `\nFailed: ${bad.map((k) => k.id).join(', ')}` : ''}`);
      process.exit(bad.length === 0 ? 0 : 1);
      break;
    }
    default:
      console.log(USAGE);
      process.exit(command && command !== 'help' ? 2 : 0);
  }
} catch (e) {
  if (!(e instanceof HarnessError)) throw e;
  console.error(`harness: ${e.message}`);
  process.exit(2);
}
