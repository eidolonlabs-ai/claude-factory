import fs from 'node:fs';
import path from 'node:path';
import { sh, bounded, tail } from './util.mjs';

const check = (id, status, summary, extra = {}) => ({ id, status, summary, ...extra });

export function dockerAvailable() {
  const v = sh('docker', ['compose', 'version', '--short'], { timeout: 20 });
  if (v.code !== 0) return { ok: false, reason: v.missing ? 'docker is not installed' : 'docker compose is not available' };
  const info = sh('docker', ['info', '--format', '{{.ServerVersion}}'], { timeout: 30 });
  if (info.code !== 0) return { ok: false, reason: 'the Docker daemon is not reachable' };
  return { ok: true, compose: v.stdout.trim(), server: info.stdout.trim() };
}

/**
 * Isolation policy over the resolved Compose model (contract section 4):
 * the gate must not collide with, or reach into, anything it did not create.
 */
export function lintModel(model, root, wanted) {
  const problems = [];
  const services = model.services ?? {};
  for (const name of wanted) if (!services[name]) problems.push(`service "${name}" is not defined in the Compose files`);
  const inside = (p) => {
    const rel = path.relative(root, p);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  };
  for (const [name, s] of Object.entries(services)) {
    if (s.container_name) problems.push(`${name}: fixed container_name collides across runs`);
    if (s.privileged) problems.push(`${name}: privileged containers are not allowed`);
    for (const key of ['network_mode', 'pid', 'ipc']) if (s[key] === 'host') problems.push(`${name}: ${key}: host breaks isolation`);
    for (const p of s.ports ?? []) if (p.published) problems.push(`${name}: published host port ${p.published} (use the Compose network during the gate)`);
    for (const v of s.volumes ?? []) {
      if (v.type !== 'bind') continue;
      if (String(v.source).includes('docker.sock')) problems.push(`${name}: the Docker socket must not be mounted`);
      else if (!inside(v.source)) problems.push(`${name}: bind mount ${v.source} is outside the project`);
    }
  }
  for (const kind of ['networks', 'volumes']) {
    for (const [name, def] of Object.entries(model[kind] ?? {})) {
      if (def?.external) problems.push(`${kind}.${name}: external ${kind} are shared with other projects`);
    }
  }
  const required = wanted.slice(0, -1).filter((n) => services[n] && !services[n].healthcheck);
  for (const n of required) problems.push(`${n}: add a healthcheck so the gate can wait for readiness`);
  return problems;
}

function foreignContainers(project) {
  const r = sh('docker', ['ps', '-a', '--no-trunc', '--format', '{{.ID}}\t{{.State}}\t{{.Label "com.docker.compose.project"}}'], { timeout: 30 });
  const map = new Map();
  if (r.code !== 0) return map;
  for (const line of r.stdout.split('\n').filter(Boolean)) {
    const [id, state, proj] = line.split('\t');
    if (proj !== project) map.set(id, state);
  }
  return map;
}

/**
 * Boot the stack under a run-specific project name, wait for health, run the
 * test service against the live services, keep bounded logs and remove
 * everything this run created. Returns one check per phase.
 */
export function runCompose({ root, compose, runDir, id }) {
  const checks = [];
  const docker = dockerAvailable();
  if (!docker.ok) return [check('compose:e2e', 'NOT_RUN', `${docker.reason}; the stack was not tested`)];

  const project = `harness-${id.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
  const timeout = compose.timeout_seconds ?? 600;
  const base = ['compose', '--project-directory', root, ...compose.files.flatMap((f) => ['-f', path.join(root, f)]), '-p', project];
  const dc = (args, t = timeout) => sh('docker', [...base, ...args], { cwd: root, timeout: t });
  const save = (name, r) => {
    const file = path.join(runDir, `${name}.log`);
    fs.writeFileSync(file, bounded(`${r.stdout}\n${r.stderr}`));
    return file;
  };

  const cfg = sh('docker', [...base, '--profile', '*', 'config', '--format', 'json'], { cwd: root, timeout: 60 });
  if (cfg.code !== 0) return [check('compose:policy', 'FAIL', 'the Compose files do not resolve', { details: [tail(cfg.stderr, 8)], log: save('compose-config', cfg) })];
  const wanted = [...compose.services, compose.test_service];
  const problems = lintModel(JSON.parse(cfg.stdout), root, wanted);
  if (problems.length > 0) return [check('compose:policy', 'FAIL', `${problems.length} isolation problem(s)`, { details: problems })];
  checks.push(check('compose:policy', 'PASS', 'isolated project, no host ports, sockets or outside mounts'));

  const before = foreignContainers(project);
  try {
    const build = dc(['build', ...wanted]);
    if (build.code !== 0) {
      checks.push(check('compose:build', 'FAIL', build.timedOut ? 'build timed out' : 'image build failed', { details: [tail(build.stderr, 15)], log: save('compose-build', build) }));
      return checks;
    }
    const up = dc(['up', '-d', '--wait', '--wait-timeout', String(timeout), ...compose.services], timeout + 30);
    if (up.code !== 0) {
      checks.push(check('compose:health', 'FAIL', 'services did not become healthy', { details: [tail(up.stderr, 15)], log: save('compose-up', up) }));
      return checks;
    }
    checks.push(check('compose:health', 'PASS', `${compose.services.join(', ')} healthy`));
    const run = dc(['run', '--rm', '-T', compose.test_service]);
    const log = save('compose-e2e', run);
    checks.push(run.code === 0
      ? check('compose:e2e', 'PASS', `${compose.test_service} passed against the live stack`, { log })
      : check('compose:e2e', 'FAIL', run.timedOut ? `${compose.test_service} timed out` : `${compose.test_service} exited ${run.code}`, { details: [tail(`${run.stdout}\n${run.stderr}`, 25)], log }));
  } finally {
    save('compose-services', dc(['logs', '--no-color', '--tail', '500'], 60));
    const down = dc(['down', '-v', '--remove-orphans', '--rmi', 'local', '--timeout', '5'], 180);
    const left = sh('docker', ['ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`], { timeout: 30 }).stdout.trim();
    const after = foreignContainers(project);
    // Containers that existed before the gate must be exactly as they were.
    // Ones that appeared meanwhile belong to someone else sharing the daemon.
    const drift = [...before.keys()].filter((k) => before.get(k) !== after.get(k));
    if (down.code !== 0 || left) checks.push(check('compose:cleanup', 'FAIL', 'the gate could not remove its own resources', { details: [tail(down.stderr, 8)], log: save('compose-down', down) }));
    else if (drift.length > 0) checks.push(check('compose:cleanup', 'FAIL', `${drift.length} container(s) outside the gate's project changed while it ran`, { details: drift.map((d) => `${d.slice(0, 12)}: ${before.get(d)} -> ${after.get(d) ?? 'removed'}`), environmental: true }));
    else checks.push(check('compose:cleanup', 'PASS', 'containers, networks, volumes and local images removed'));
  }
  return checks;
}
