#!/usr/bin/env bash
# worktree.sh — agent worktree lifecycle for the utah-water-dashboard monorepo.
#
# Proposed production repository helper, retained with the development plan
# (specifications/04-ai-development-and-testing.md, "Repository topology,
# branches, and worktrees"). Copy to scripts/worktree.sh when the repository
# is bootstrapped in WD-001. It has not been executed against a production
# repository; syntax was checked with `bash -n` only.
#
# Conventions enforced:
#   - one task, one branch (feat/<WD-ID>-<slug>), one worktree, one writer
#   - worktrees live in a sibling directory of the primary clone
#   - only the orchestrator runs "remove" (after merge) and "list --stale"
#
# Usage (Git Bash on Windows or POSIX):
#   scripts/worktree.sh start  <WD-ID> <slug> [base-branch]   # orchestrator
#   scripts/worktree.sh sync   <WD-ID>                         # worker, inside worktree
#   scripts/worktree.sh push   <WD-ID>                         # worker, inside worktree
#   scripts/worktree.sh remove <WD-ID>                         # orchestrator, post-merge
#   scripts/worktree.sh list [--stale-days N]

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || { echo "run inside the repository" >&2; exit 1; })"
WORKTREE_PARENT="$(dirname "$REPO_ROOT")/utah-water-worktrees"
LOCKFILE="pnpm-lock.yaml"
STALE_DAYS=5

die() { echo "error: $*" >&2; exit 1; }

task_branch() { echo "feat/${1}-$(echo "$2" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9-' '-' | sed 's/-*$//;s/^\-*//')"; }
task_dir()    { echo "$(echo "$1" | tr '[:upper:]' '[:lower:]')-$(echo "$2" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9-' '-' | sed 's/-*$//;s/^\-*//')"; }

case "${1:-}" in
  start)
    [ $# -ge 3 ] || die "start needs <WD-ID> <slug> [base-branch]"
    ID="$2"; SLUG="$3"; BASE="${4:-origin/integration}"
    BR="$(task_branch "$ID" "$SLUG")"; DIR="$WORKTREE_PARENT/$(task_dir "$ID" "$SLUG")"
    git fetch origin
    [ -e "$DIR" ] && die "worktree directory already exists: $DIR"
    git show-ref --verify --quiet "refs/heads/$BR" && die "branch already exists: $BR"
    git worktree add "$DIR" -b "$BR" "$BASE"
    echo "worktree ready: $DIR"
    echo "worker next steps:"
    echo "  cd $DIR && pnpm install --frozen-lockfile"
    echo "  commit with trailers: Task: $ID / Refs: / Tests: / Agent:"
    ;;

  sync)
    [ $# -eq 2 ] || die "sync needs <WD-ID> (run inside that worktree)"
    git rev-parse --abbrev-ref HEAD | grep -q "^feat/$2-\|fix/$2-" || die "not on a branch of $2"
    git fetch origin integration
    git rebase origin/integration
    [ -f "$LOCKFILE" ] && pnpm install --frozen-lockfile
    ;;

  push)
    [ $# -eq 2 ] || die "push needs <WD-ID> (run inside that worktree)"
    BR="$(git rev-parse --abbrev-ref HEAD)"
    echo "$BR" | grep -q "^feat/$2-\|fix/$2-" || die "not on a branch of $2"
    git push --force-with-lease -u origin "$BR"
    echo "open the PR into integration using the PR template"
    ;;

  remove)
    [ $# -eq 2 ] || die "remove needs <WD-ID> (orchestrator, after merge)"
    BR="$(git branch --list "feat/$2-*" "fix/$2-*" | sed 's/^[* ]*//;s/ *$//')"
    DIRS="$(git worktree list --porcelain | awk -v id="$(echo "$2" | tr '[:upper:]' '[:lower:]')" '$1=="worktree"{d=$2} $1=="branch"{if ($2 ~ "feat/"id || $2 ~ "fix/"id) print d}')"
    [ -z "$DIRS" ] && die "no worktree found for $2"
    for D in $DIRS; do
      git worktree remove "$D"
      echo "removed worktree: $D"
      echo "cleanup checklist: stop dev servers; drop branch-named test schema; delete local env file"
    done
    for B in $BR; do git branch -D "$B" 2>/dev/null || true; done
    git worktree prune
    ;;

  list)
    shift
    if [ "${1:-}" = "--stale-days" ]; then STALE_DAYS="${2:?need N}"; fi
    git worktree list --porcelain | awk -v cutoff="$STALE_DAYS" '
      $1=="worktree" {dir=$2} $1=="branch" {printf "%s\t%s\n", dir, $2}' | while IFS=$'\t' read -r dir branch; do
        last="$(git -C "$dir" log -1 --format=%ct 2>/dev/null || echo 0)"
        age=$(( ($(date +%s) - last) / 86400 ))
        flag=""; [ "$age" -ge "$STALE_DAYS" ] && flag="  STALE(${age}d)"
        printf '%s  %s%s\n' "$branch" "$dir" "$flag"
      done
    ;;

  *)
    cat <<'EOF'
usage: scripts/worktree.sh <command> [args]
  start  <WD-ID> <slug> [base]   orchestrator: create worktree + feat branch
  sync   <WD-ID>                 worker: rebase on integration + frozen install
  push   <WD-ID>                 worker: force-with-lease push + PR reminder
  remove <WD-ID>                 orchestrator: post-merge cleanup
  list   [--stale-days N]        list worktrees, flagging stale ones
EOF
    exit 2
    ;;
esac
