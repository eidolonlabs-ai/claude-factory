import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sh, git } from './util.mjs';
import { requireRepo, repoInfo } from './state.mjs';
import { validateConfig } from './config.mjs';
import { dockerAvailable } from './compose.mjs';

const TEMPLATES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'templates');
const IGNORES = ['.env', '.env.*', '!.env.example', '.claude/settings.local.json', '.claude/worktrees/', 'tasks/drafts/'];

/**
 * Adoption scaffold. Fills in missing files and never overwrites: existing
 * configuration is the owner's, and reconciling it is a reviewed edit.
 */
export function setup(cwd, apply) {
  const repo = requireRepo(cwd);
  const plan = [];
  const file = (rel, template, note) => {
    const target = path.join(repo.root, rel);
    if (fs.existsSync(target)) {
      plan.push({ path: rel, action: 'keep', note: 'exists; left unchanged' });
      return false;
    }
    plan.push({ path: rel, action: 'create', note });
    if (apply) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(TEMPLATES, template), target);
    }
    return true;
  };
  file('factory.json', 'factory.json', 'configure real Compose services, the test service and protected paths');
  file('tasks/example.json', 'task.json', 'task format; replace with an approved task');
  file('docs/factory/CLAUDE.snippet.md', 'CLAUDE.snippet.md', 'merge into CLAUDE.md after review');
  const settings = path.join(repo.root, '.claude', 'settings.json');
  if (fs.existsSync(settings)) file('docs/factory/settings.suggested.json', 'settings.json', 'permission rules to merge into .claude/settings.json');
  else file('.claude/settings.json', 'settings.json', 'permission rules for secrets; add rules for acceptance inputs once factory.json is committed');

  const ignore = path.join(repo.root, '.gitignore');
  const current = fs.existsSync(ignore) ? fs.readFileSync(ignore, 'utf8') : '';
  const missing = IGNORES.filter((l) => !current.split('\n').map((s) => s.trim()).includes(l));
  if (missing.length > 0) {
    plan.push({ path: '.gitignore', action: 'append', note: missing.join(' ') });
    if (apply) fs.writeFileSync(ignore, `${current}${current && !current.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`);
  }
  return { root: repo.root, applied: Boolean(apply), plan };
}

/** Environment report. `ok: false` items block verification. */
export function doctor(cwd) {
  const items = [];
  const add = (name, ok, detail) => items.push({ name, ok, detail });
  const major = Number(process.versions.node.split('.')[0]);
  add('node', major >= 20, `v${process.versions.node}${major >= 20 ? '' : ' (20 or newer is required)'}`);
  const g = sh('git', ['--version']);
  add('git', g.code === 0, g.stdout.trim() || 'not found');
  const repo = repoInfo(cwd);
  add('repository', Boolean(repo), repo ? repo.root : 'not inside a Git repository');
  if (repo) {
    add('commit', git(repo.root, 'rev-parse', '--verify', '-q', 'HEAD').code === 0, 'tasks pin a base commit; worktrees need one');
    const cfg = path.join(repo.root, 'factory.json');
    if (!fs.existsSync(cfg)) add('factory.json', false, 'missing: run setup');
    else {
      let errors;
      try {
        errors = validateConfig(JSON.parse(fs.readFileSync(cfg, 'utf8')));
      } catch (e) {
        errors = [e.message];
      }
      add('factory.json', errors.length === 0, errors.length === 0 ? 'valid v3 configuration' : errors.join('; '));
    }
  }
  const d = dockerAvailable();
  add('docker', d.ok, d.ok ? `server ${d.server}, compose ${d.compose}` : d.reason);
  const c = sh('claude', ['--version']);
  items.push({ name: 'claude', ok: true, detail: c.code === 0 ? c.stdout.trim() : 'not on PATH (only needed for managed `run`)' });
  return { ok: items.every((i) => i.ok), items };
}
