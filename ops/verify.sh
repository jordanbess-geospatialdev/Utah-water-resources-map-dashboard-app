#!/usr/bin/env bash
# =============================================================================
# ops/verify.sh — WD-024 zero-dependency static operations verifier.
#
# No package.json, no Node, no third-party tools: bash + coreutils. Read-only
# and idempotent (run twice, same result). The hot loops use bash builtins
# only (regex =~, parameter expansion) so verification costs a handful of
# process spawns total, not one per line. Wired into CI as the `ops-verify`
# job in .github/workflows/ci.yml and re-run by the release suite.
# See ops/README.md for the check catalog.
#
# Checks:
#   1 secrets-placeholder   literal secret values in infra/** config files fail
#   2 image-digest-pin      bare/unpinned image tags in infra/** YAML fail
#   3 ci-gates-intact       ci.yml keeps gate/secrets/build jobs + concurrency
#   4 release-no-autopush   release.yml is dispatch-only, never pushes/deploys
#   5 yaml-structure        key-presence + no tabs + indentation parity
#
# Convention: inside .github/workflows/**, a run-block line beginning with
# "$ " is an OPERATOR prompt (rendered into generated instruction text), not
# an executable CI command — check 4 skips those lines by design.
# =============================================================================
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${ROOT}"

FAILURES=0
CHECKS=0

ok()   { CHECKS=$((CHECKS + 1)); printf 'ops-verify: ok   %s\n' "$1"; }
fail() { CHECKS=$((CHECKS + 1)); FAILURES=$((FAILURES + 1)); printf 'ops-verify: FAIL %s\n' "$1" >&2; }
note() { printf 'ops-verify:      %s\n' "$1" >&2; }

# Bash 4+ required for ${var,,}; assert once so failure mode is clear.
if [ -z "${BASH_VERSINFO:-}" ] || [ "${BASH_VERSINFO[0]}" -lt 4 ]; then
  echo "ops-verify: bash >= 4 required" >&2
  exit 2
fi

SECRET_KEY_RE='(password|passwd|secret|token|api[_-]?key|store[_-]?key|signing[_-]?key|private[_-]?key|credential)'
DIGEST_RE='@sha256:[0-9a-f]{64}$'
PUSH_RE='(git[[:space:]]+push|gh[[:space:]]+release[[:space:]]+(create|upload)|docker[[:space:]]+push|npm[[:space:]]+publish|terraform[[:space:]]+apply|gcloud[[:space:]].*(deploy|apply))'

# find config files under a directory (structured config types only; code and
# prose are excluded by type so identifiers in scripts are not false
# positives — the CI secret scan and pre-commit hook remain the pattern net).
find_config() {
  find "$1" -type f \( -name '*.yaml' -o -name '*.yml' -o -name '*.env' \
    -o -name '.env.example' -o -name '*.env.example' -o -name '*.example' \) 2>/dev/null | sort
}

# --- check 1: secret values must be placeholders ------------------------------
# 12+ secret-ish assignments were expected at authoring time; the count is
# reported, not asserted — the assertion is "zero literal values".
check_secret_placeholders() {
  local bad=0 total=0 f line t key k lk rest v
  while IFS= read -r f; do
    [ -f "$f" ] || continue
    while IFS= read -r line || [ -n "$line" ]; do
      t="${line#"${line%%[![:space:]]*}"}"          # ltrim (builtin)
      t="${t%"${t##*[![:space:]]}"}"                # rtrim (builtin)
      case "$t" in ''|'#'*) continue ;; esac
      case "$t" in
        *:*) key="${t%%:*}" ; rest="${t#*:}" ;;
        *=*) key="${t%%=*}" ; rest="${t#*=}" ;;
        *)   continue ;;                            # no assignment on this line
      esac
      k="${key#"${key%%[![:space:]]*}"}"            # trim key
      k="${k%"${k##*[![:space:]]}"}"
      lk="${k,,}"                                   # lowercase (builtin)
      [[ "$lk" =~ $SECRET_KEY_RE ]] || continue
      v="${rest%%'#'*}"                             # strip trailing comment
      v="${v#"${v%%[![:space:]]*}"}"
      v="${v%"${v##*[![:space:]]}"}"
      total=$((total + 1))
      case "$v" in
        *'${'*) continue ;;                          # ${VAR} / ${SECRET_REF:name} placeholder
        '<'*) continue ;;                            # <placeholder>
        '')    continue ;;                           # declared, value supplied elsewhere
      esac
      case "${v,,}" in
        replace-with*|placeholder*|pending*|tbd*|secret-ref*) continue ;;
      esac
      bad=$((bad + 1))
      fail "secrets-placeholder: literal-looking value for '$k' in $f"
      note "line: $t"
    done < "$f"
  done < <(find_config infra)
  [ "$bad" -eq 0 ] && ok "secrets-placeholder: ${total} secret-ish assignments in infra/** are all placeholders"
}

# --- check 2: image references are digest-pinned or release placeholders ------
check_image_pins() {
  local bad=0 total=0 f line t v
  while IFS= read -r f; do
    [ -f "$f" ] || continue
    while IFS= read -r line; do
      t="${line#"${line%%[![:space:]]*}"}"
      t="${t%"${t##*[![:space:]]}"}"
      case "$t" in '#'*) continue ;; esac
      [[ "$t" =~ ^image:[[:space:]]*[^[:space:]]+ ]] || continue
      v="${t#image:}"
      v="${v#"${v%%[![:space:]]*}"}"
      v="${v%"${v##*[![:space:]]}"}"
      v="${v%%'#'*}"                                 # strip trailing comment
      v="${v#"${v%%[![:space:]]*}"}"; v="${v%"${v##*[![:space:]]}"}"
      total=$((total + 1))
      case "$v" in
        *'${'*) continue ;;                          # ${RELEASE_IMAGE_*_DIGEST} resolved from the manifest
      esac
      [[ "$v" =~ $DIGEST_RE ]] && continue
      bad=$((bad + 1))
      fail "image-digest-pin: image '$v' in $f is not digest-pinned (expected tag@sha256:<64-hex> or a \${RELEASE_IMAGE_*} placeholder)"
    done < "$f"
  done < <(find infra -type f \( -name '*.yaml' -o -name '*.yml' \) 2>/dev/null | sort)
  [ "$bad" -eq 0 ] && ok "image-digest-pin: ${total} image references in infra/** are digest-pinned or release placeholders"
}

# --- check 3: ci.yml keeps the existing gates --------------------------------
check_ci_gates() {
  local ci=".github/workflows/ci.yml" bad=0
  [ -f "$ci" ] || { fail "ci-gates-intact: $ci missing"; return; }
  grep -q '^  gate:' "$ci" \
    || { fail "ci-gates-intact: job 'gate' missing from $ci"; bad=1; }
  grep -q '^  secrets:' "$ci" \
    || { fail "ci-gates-intact: job 'secrets' (secret scan) missing from $ci"; bad=1; }
  grep -q '^  build:' "$ci" \
    || { fail "ci-gates-intact: job 'build' missing from $ci"; bad=1; }
  grep -q 'node scripts/gate.mjs all' "$ci" \
    || { fail "ci-gates-intact: gate job no longer invokes 'node scripts/gate.mjs all'"; bad=1; }
  grep -qE '^  pull_request:' "$ci" \
    || { fail "ci-gates-intact: pull_request trigger missing from $ci"; bad=1; }
  { grep -q '^concurrency:' "$ci" && grep -q 'group: ci-' "$ci"; } \
    || { fail "ci-gates-intact: one-run-per-ref concurrency guard missing from $ci"; bad=1; }
  [ "$bad" -eq 0 ] && ok "ci-gates-intact: gate/secrets/build jobs, gate invocation and concurrency guard present"
}

# --- check 4: release.yml is dispatch-only and never pushes -------------------
check_release_no_autopush() {
  local rel=".github/workflows/release.yml" bad=0 line t
  [ -f "$rel" ] || { fail "release-no-autopush: $rel missing"; return; }
  grep -q '^  workflow_dispatch:' "$rel" \
    || { fail "release-no-autopush: workflow_dispatch trigger missing"; bad=1; }
  while IFS= read -r line; do
    t="${line#"${line%%[![:space:]]*}"}"
    t="${t%"${t##*[![:space:]]}"}"
    case "$t" in
      'push:'|'schedule:'|'pull_request:'|'workflow_call:'|'repository_dispatch:')
        fail "release-no-autopush: non-dispatch trigger '$t' found (must be workflow_dispatch only)"
        bad=1 ;;
    esac
  done < "$rel"
  while IFS= read -r line; do
    t="${line#"${line%%[![:space:]]*}"}"
    t="${t%"${t##*[![:space:]]}"}"
    case "$t" in
      '#'*) continue ;;   # comment
      '$'*) continue ;;   # operator prompt inside generated instruction text
    esac
    if [[ "$t" =~ $PUSH_RE ]]; then
      fail "release-no-autopush: executable push/deploy/apply command found: $t"
      bad=1
    fi
  done < "$rel"
  grep -q 'requires explicit environment authorization' "$rel" \
    || { fail "release-no-autopush: fail-closed deploy authorization message missing"; bad=1; }
  grep -q 'exit 1' "$rel" \
    || { fail "release-no-autopush: deploy stub no longer exits non-zero"; bad=1; }
  [ "$bad" -eq 0 ] && ok "release-no-autopush: dispatch-only; no executable push/publish/apply; deploy stub fails closed"
}

# --- check 5: YAML structure sanity (key presence, no tabs, indent parity) ----
require_keys() {
  # $1 file, rest: fixed-string patterns that must be present
  local f="$1"; shift
  local p bad=0
  for p in "$@"; do
    grep -qF "$p" "$f" || { fail "yaml-structure: $f missing required content '$p'"; bad=1; }
  done
  [ "$bad" -eq 0 ]
}

require_files() {
  local f bad=0
  for f in "$@"; do
    [ -f "$f" ] || { fail "yaml-structure: required file missing: $f"; bad=1; }
  done
  [ "$bad" -eq 0 ]
}

check_yaml_structure() {
  local bad=0 f files n

  require_files \
    infra/runtime/README.md \
    infra/runtime/services/backend.yaml \
    infra/runtime/services/worker.yaml \
    infra/runtime/services/neoserver-vm.yaml \
    ops/README.md ops/monitoring.md \
    ops/runbooks/deploy.md ops/runbooks/rollback.md \
    ops/runbooks/backup-restore.md ops/runbooks/incident.md \
    ops/drills/README.md || bad=1

  [ -f infra/runtime/services/backend.yaml ] && require_keys infra/runtime/services/backend.yaml \
    'kind: Service' 'minInstances' 'maxInstances' 'concurrency:' 'timeoutSeconds' \
    'vpcEgress' 'connectorRef' 'connectionPools' 'maxConnections' 'queueCaps' \
    'maxDepth' '${SECRET_REF:' || bad=1
  [ -f infra/runtime/services/worker.yaml ] && require_keys infra/runtime/services/worker.yaml \
    'kind: WorkerService' 'maxInstances' 'queueCaps' 'maxAttempts' 'maxConcurrent' \
    'connectionPools' 'ingress: none' '${SECRET_REF:' || bad=1
  [ -f infra/runtime/services/neoserver-vm.yaml ] && require_keys infra/runtime/services/neoserver-vm.yaml \
    'kind: StatefulVM' 'singleActiveInstance' 'maxReplicas: 1' 'persistentDisk' \
    'maintenanceWindow' 'storeBackup' 'keyRecovery' 'cacheRefresh' \
    '@sha256:' '${SECRET_REF:neoserver-store-key}' || bad=1
  [ -f .github/workflows/ci.yml ] && require_keys .github/workflows/ci.yml \
    'full-matrix' 'lockfile-integrity' 'ops-verify' 'bash ops/verify.sh' \
    'pnpm install --frozen-lockfile' || bad=1
  [ -f .github/workflows/release.yml ] && require_keys .github/workflows/release.yml \
    'version_tag' 'environment:' 'preflight:' 'suite:' 'manifest:' 'deploy:' \
    'release-manifest.json' 'pnpm-lock.yaml' || bad=1

  # no tab characters in any workflow or runtime/compose YAML (tabs are
  # invalid YAML indentation and break parsers and reviewers alike)
  files="$(printf '%s\n' .github/workflows/ci.yml .github/workflows/release.yml \
    infra/neoserver/docker-compose.yml; \
    find infra/runtime -type f \( -name '*.yaml' -o -name '*.yml' \) 2>/dev/null | sort)"
  while IFS= read -r f; do
    [ -f "$f" ] || continue
    if awk 'index($0, "\t") { found = 1 } END { exit found ? 0 : 1 }' "$f"; then
      fail "yaml-structure: tab character found in $f"
      bad=1
    fi
  done <<< "$files"

  # indentation parity: runtime definition files use 2-space steps; an odd
  # leading-space count signals a broken block (cheap structural parse).
  while IFS= read -r f; do
    [ -f "$f" ] || continue
    n="$(awk '{
      line = $0; indent = 0
      while (substr(line, 1, 1) == " ") { indent++; line = substr(line, 2) }
      if (length(line) > 0 && indent % 2 != 0) { print FNR; exit }
    }' "$f")"
    if [ -n "${n:-}" ]; then
      fail "yaml-structure: odd indentation (not 2-space steps) at $f line $n"
      bad=1
    fi
  done <<< "$(find infra/runtime -type f \( -name '*.yaml' -o -name '*.yml' \) 2>/dev/null | sort)"

  [ "$bad" -eq 0 ] && ok "yaml-structure: required keys/files present; no tabs; runtime YAML indent parity holds"
}

# --- run ----------------------------------------------------------------------
echo "ops-verify: repo root ${ROOT}"
check_secret_placeholders
check_image_pins
check_ci_gates
check_release_no_autopush
check_yaml_structure
echo "ops-verify: ${CHECKS} checks, ${FAILURES} failures"
if [ "$FAILURES" -ne 0 ]; then
  exit 1
fi
exit 0
