#!/usr/bin/env bash
# Demonstrates the hooks milestone on a disposable project with a real Docker
# Compose stack: a guard denial, a failing gate, and a passing gate after the
# repair. Drives the same hook entry point Claude Code invokes.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLUGIN="$ROOT/plugins/factory"
FACTORY=(node "$PLUGIN/scripts/factory.mjs")
WORK="$(mktemp -d "${TMPDIR:-/tmp}/factory-demo.XXXXXX")"
APP="$WORK/notes-app"
trap 'rm -rf "$WORK"' EXIT

step() { printf '\n== %s\n' "$1"; }
die() { printf 'DEMO FAILED: %s\n' "$1" >&2; exit 1; }
hook() { node "$PLUGIN/scripts/hook.mjs"; }
event() { # event <name> <tool> <tool_input json>
  printf '{"hook_event_name":"%s","cwd":"%s","permission_mode":"default","tool_name":"%s","tool_input":%s}' "$1" "$APP" "${2:-}" "${3:-null}"
}

step "Create a disposable project"
cp -R "$ROOT/examples/notes-app" "$APP"
git -C "$APP" init -q -b main
git -C "$APP" -c user.name=demo -c user.email=demo@example.invalid add -A
git -C "$APP" -c user.name=demo -c user.email=demo@example.invalid commit -q -m "baseline"
"${FACTORY[@]}" doctor --repo "$APP"

step "Owner reviews which check proves each criterion, then activates the task"
RECORD="$WORK/trim-note-titles.acceptance.json"
"${FACTORY[@]}" prepare tasks/trim-note-titles.json --repo "$APP" --out "$RECORD"
if "${FACTORY[@]}" activate tasks/trim-note-titles.json --acceptance "$RECORD" --repo "$APP" 2>/dev/null; then
  die "activation must refuse a record nobody has reviewed"
fi
echo "(activation refuses the unreviewed draft)"
# The owner's review: both criteria are asserted by acceptance/e2e.mjs, so the proposed mapping stands.
node -e 'const fs=require("fs");const f=process.argv[1];const r=JSON.parse(fs.readFileSync(f));r.unresolved_decisions=[];fs.writeFileSync(f,JSON.stringify(r,null,2))' "$RECORD"
"${FACTORY[@]}" activate tasks/trim-note-titles.json --acceptance "$RECORD" --repo "$APP"

step "1. Guard denies an edit to a protected acceptance test"
OUT="$(event PreToolUse Edit "{\"file_path\":\"$APP/acceptance/e2e.mjs\"}" | hook)"
echo "$OUT"
grep -q '"permissionDecision":"deny"' <<<"$OUT" || die "expected a deny for acceptance/e2e.mjs"
OUT="$(event PreToolUse Bash '{"command":"echo SECRET=1 > .env"}' | hook)"
echo "$OUT"
grep -q '"permissionDecision":"deny"' <<<"$OUT" || die "expected a deny for a shell write to .env"
OUT="$(event PreToolUse Edit "{\"file_path\":\"$APP/src/title.mjs\"}" | hook)"
[ -z "$OUT" ] || die "expected the in-scope edit to be allowed, got: $OUT"
echo "(in-scope edit to src/title.mjs is allowed)"

step "2. An incomplete fix: the Stop hook runs the gate and blocks completion"
cat > "$APP/src/title.mjs" <<'JS'
export function normalizeTitle(title) {
  if (typeof title !== 'string') return null;
  return title.trim();
}
JS
OUT="$(event Stop | hook)"
echo "$OUT" | node -e 'const o=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(o.decision, "\n"+o.reason)'
grep -q '"decision":"block"' <<<"$OUT" || die "expected the gate to block the incomplete fix"
grep -q 'compose:e2e' <<<"$OUT" || die "expected the end-to-end check to be the failure"

step "3. The repair: the gate passes and the turn may end"
cat > "$APP/src/title.mjs" <<'JS'
export function normalizeTitle(title) {
  if (typeof title !== 'string') return null;
  const trimmed = title.trim();
  return trimmed === '' ? null : trimmed;
}
JS
OUT="$(event Stop | hook)"
echo "$OUT"
grep -q 'gate passed' <<<"$OUT" || die "expected the gate to pass after the repair"
"${FACTORY[@]}" status --repo "$APP"

step "Cleanup check"
LEFT="$(docker ps -a --filter 'label=com.docker.compose.project' --format '{{.Label "com.docker.compose.project"}}' | grep -c '^factory-' || true)"
[ "$LEFT" = "0" ] || die "$LEFT factory container(s) were left behind"
echo "No factory containers remain."
printf '\nDEMO PASSED: guard denial, failing gate, passing repair.\n'
