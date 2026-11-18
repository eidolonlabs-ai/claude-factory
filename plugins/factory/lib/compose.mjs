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

function resolvePath(p, root) {
  const abs = path.isAbsolute(p) ? path.resolve(p) : path.resolve(root, p);
  const seen = new Set();
  let cur = abs;
  for (let depth = 0; depth < 32 && !seen.has(cur); depth += 1) {
    seen.add(cur);
    if (fs.existsSync(cur)) return fs.realpathSync(cur);
    try {
      if (fs.lstatSync(cur).isSymbolicLink()) {
        cur = path.resolve(path.dirname(cur), fs.readlinkSync(cur));
        continue;
      }
    } catch {
      // fall through to ancestor walk
    }
    let dir = path.dirname(cur);
    while (dir && !fs.existsSync(dir)) {
      const up = path.dirname(dir);
      if (up === dir) return abs;
      dir = up;
    }
    if (!dir) return abs;
    const real = fs.realpathSync(dir);
    const rest = path.relative(dir, cur);
    return rest && !rest.startsWith('..') ? path.join(real, rest) : real;
  }
  return abs;
}

/**
 * Isolation policy over the resolved Compose model (contract section 4):
 * the gate must not collide with, or reach into, anything it did not create.
 */
export function lintModel(model, root, wanted) {
  const problems = [];
  const services = model.services ?? {};
  for (const name of wanted) if (!services[name]) problems.push(`service "${name}" is not defined in the Compose files`);
  const realRoot = fs.existsSync(root) ? fs.realpathSync(root) : path.resolve(root);
  const inside = (p) => {
    const resolved = resolvePath(p, realRoot);
    const rel = path.relative(realRoot, resolved);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  };
  for (const [name, s] of Object.entries(services)) {
    if (s.container_name) problems.push(`${name}: fixed container_name collides across runs`);
    if (s.privileged) problems.push(`${name}: privileged containers are not allowed`);
    for (const key of ['network_mode', 'pid', 'ipc', 'uts', 'cgroup', 'userns_mode']) {
      const val = s[key];
      if (val === 'host' || (typeof val === 'string' && /^(?:container|ns):/i.test(val))) {
        problems.push(`${name}: ${key}: ${val} breaks isolation`);
      }
    }
    if (Array.isArray(s.devices) && s.devices.length > 0) problems.push(`${name}: host devices break isolation`);
    if (Array.isArray(s.volumes_from) && s.volumes_from.length > 0) problems.push(`${name}: volumes_from reaches external containers`);
    for (const p of s.ports ?? []) if (p.published) problems.push(`${name}: published host port ${p.published} (use the Compose network during the gate)`);
    if (s.healthcheck?.disable) problems.push(`${name}: the healthcheck is disabled`);
    for (const v of s.volumes ?? []) {
      if (v.type !== 'bind') continue;
      const src = String(v.source ?? '');
      const resolved = resolvePath(src, realRoot);
      if (src.includes('docker.sock') || resolved.includes('docker.sock')) problems.push(`${name}: the Docker socket must not be mounted`);
      else if (!inside(src)) problems.push(`${name}: bind mount ${v.source} is outside the project`);
    }
  }
  for (const kind of ['networks', 'volumes']) {
    for (const [name, def] of Object.entries(model[kind] ?? {})) {
      if (def?.external) problems.push(`${kind}.${name}: external ${kind} are shared with other projects`);
      if (def?.driver_opts && Object.keys(def.driver_opts).length > 0) problems.push(`${kind}.${name}: driver options can reach outside the project`);
    }
  }
  const required = wanted.slice(0, -1).filter((n) => services[n] && (!services[n].healthcheck || services[n].healthcheck.disable));
  for (const n of required) problems.push(`${n}: add a healthcheck so the gate can wait for readiness`);
  return problems;
}

/**
 * Containers this gate must leave alone. Other factories' ephemeral stacks
 * (`factory-*`, `<project>-<8hex>`, `*-preview`) run concurrently on the same
 * daemon and are not interference.
 */
export const isPeerFactoryProject = (label) => {
  const s = String(label ?? '');
  return s.startsWith('factory-') || /-[0-9a-f]{8}$/.test(s) || s.endsWith('-preview');
};

export const isForeign = (label, project) => label !== project && !isPeerFactoryProject(label);

function foreignContainers(project) {
  const r = sh('docker', ['ps', '-a', '--no-trunc', '--format', '{{.ID}}\t{{.State}}\t{{.Label "com.docker.compose.project"}}'], { timeout: 30 });
  if (r.code !== 0) return { ok: false, error: r.stderr.trim() || `docker ps exited ${r.code}`, map: new Map() };
  const map = new Map();
  for (const line of r.stdout.split('\n').filter(Boolean)) {
    const [id, state, proj] = line.split('\t');
    if (isForeign(proj, project)) map.set(id, state);
  }
  return { ok: true, map };
}

/**
 * Boot the stack under a run-specific project name, wait for health, run the
 * test service against the live services, keep bounded logs and remove
 * everything this run created. Returns one check per phase.
 */
export function runCompose({ root, compose, runDir, id, budget = (s) => s }) {
  const checks = [];
  const docker = dockerAvailable();
  if (!docker.ok) return [check('compose:e2e', 'NOT_RUN', `${docker.reason}; the stack was not tested`)];

  const project = `factory-${id.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
  // `timeout_seconds` is the budget for build, health and the test together.
  const until = Date.now() + (compose.timeout_seconds ?? 600) * 1000;
  const left = () => Math.max(0, budget(Math.floor((until - Date.now()) / 1000)));
  const outOfTime = (phase) => check(`compose:${phase}`, 'FAIL', 'the gate ran out of time before this phase (raise compose.timeout_seconds or speed up the build)');
  const base = ['compose', '--project-directory', root, ...compose.files.flatMap((f) => ['-f', path.join(root, f)]), '-p', project, '--profile', '*'];
  const dc = (args, t) => sh('docker', [...base, ...args], { cwd: root, timeout: t ?? Math.max(1, left()) });
  const save = (name, r) => {
    const file = path.join(runDir, `${name}.log`);
    fs.writeFileSync(file, bounded(`${r.stdout}\n${r.stderr}`));
    return file;
  };

  const cfg = sh('docker', [...base, 'config', '--format', 'json'], { cwd: root, timeout: 60 });
  if (cfg.code !== 0) return [check('compose:policy', 'FAIL', 'the Compose files do not resolve', { details: [tail(cfg.stderr, 8)], log: save('compose-config', cfg) })];
  const wanted = [...compose.services, compose.test_service];
  const problems = lintModel(JSON.parse(cfg.stdout), root, wanted);
  if (problems.length > 0) return [check('compose:policy', 'FAIL', `${problems.length} isolation problem(s)`, { details: problems })];
  checks.push(check('compose:policy', 'PASS', 'isolated project, no host ports, sockets or outside mounts'));

  const before = foreignContainers(project);
  try {
    if (left() <= 0) return [...checks, outOfTime('build')];
    const build = dc(['build', ...wanted]);
    if (build.code !== 0) {
      checks.push(check('compose:build', 'FAIL', build.timedOut ? 'build timed out' : 'image build failed', { details: [tail(build.stderr, 15)], log: save('compose-build', build) }));
      return checks;
    }
    if (left() <= 5) {
      checks.push(outOfTime('health'));
      return checks;
    }
    const up = dc(['up', '-d', '--wait', '--wait-timeout', String(left()), ...compose.services], left() + 10);
    if (up.code !== 0) {
      checks.push(check('compose:health', 'FAIL', 'services did not become healthy', { details: [tail(up.stderr, 15)], log: save('compose-up', up) }));
      return checks;
    }
    checks.push(check('compose:health', 'PASS', `${compose.services.join(', ')} healthy`));
    if (left() <= 0) {
      checks.push(outOfTime('e2e'));
      return checks;
    }
    const run = dc(['run', '--rm', '-T', compose.test_service]);
    const log = save('compose-e2e', run);
    checks.push(run.code === 0
      ? check('compose:e2e', 'PASS', `${compose.test_service} passed against the live stack`, { log })
      : check('compose:e2e', 'FAIL', run.timedOut ? `${compose.test_service} timed out` : `${compose.test_service} exited ${run.code}`, { details: [tail(`${run.stdout}\n${run.stderr}`, 25)], log }));
  } finally {
    save('compose-services', dc(['logs', '--no-color', '--tail', '500'], 60));
    const down = dc(['down', '-v', '--remove-orphans', '--rmi', 'local', '--timeout', '5'], 180);
    const leftPs = sh('docker', ['ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`], { timeout: 30 });
    const leftContainers = leftPs.stdout.trim();
    const after = foreignContainers(project);
    // Containers that existed before the gate must be exactly as they were.
    // Ones that appeared meanwhile belong to someone else sharing the daemon.
    const drift = before.ok && after.ok
      ? [...before.map.keys()].filter((k) => before.map.get(k) !== after.map.get(k))
      : [];
    if (down.code !== 0 || leftPs.code !== 0 || leftContainers) {
      const details = [tail(down.stderr, 8), leftPs.code !== 0 ? (leftPs.stderr.trim() || `docker ps exited ${leftPs.code}`) : ''].filter(Boolean);
      checks.push(check('compose:cleanup', 'FAIL', 'the gate could not remove its own resources', { details, log: save('compose-down', down) }));
    } else if (!before.ok || !after.ok) {
      checks.push(check('compose:cleanup', 'FAIL', 'could not verify container isolation around the gate', { details: [before.error ?? after.error].filter(Boolean), environmental: true }));
    } else if (drift.length > 0) {
      checks.push(check('compose:cleanup', 'FAIL', `${drift.length} container(s) outside the gate's project changed while it ran`, { details: drift.map((d) => `${d.slice(0, 12)}: ${before.map.get(d)} -> ${after.map.get(d) ?? 'removed'}`), environmental: true }));
    } else {
      checks.push(check('compose:cleanup', 'PASS', 'containers, networks, volumes and local images removed'));
    }
  }
  return checks;
}
