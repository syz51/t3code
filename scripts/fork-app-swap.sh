#!/usr/bin/env bash
# Replace T3 Code (Nightly) with a fork build. See docs/operations/fork.md#switch-to-the-fork-build.
# Usage: scripts/fork-app-swap.sh [--dry-run] [path/to/fork.app]
set -euo pipefail

fail() {
  echo "fork-app-swap: $*" >&2
  exit 1
}

dry_run=0
fork_app=""
for arg in "$@"; do
  case "$arg" in
    --dry-run) dry_run=1 ;;
    --*) fail "unknown option $arg" ;;
    *)
      [[ -z "$fork_app" ]] || fail "pass at most one app"
      fork_app="$arg"
      ;;
  esac
done

apps_dir="${T3_SWAP_APPS_DIR:-/Applications}"
state_db="${T3_SWAP_STATE_DB:-$HOME/.t3/userdata/statev2.sqlite}"
backup_root="${T3_SWAP_BACKUP_ROOT:-$HOME/.t3-swap-backup}"
fork_app="${fork_app:-$HOME/.t3-fork/build/mac-arm64/T3 Code (Beta).app}"
nightly_app="$apps_dir/T3 Code (Nightly).app"
fork_target="$apps_dir/$(basename "$fork_app")"
backup_dir="$backup_root/$(date +%Y%m%d-%H%M%S)"
lsregister="${T3_SWAP_LSREGISTER:-/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister}"

run() {
  echo "+ $*"
  if [[ $dry_run -eq 0 ]]; then "$@"; fi
}
plist() { /usr/libexec/PlistBuddy -c "Print :$2" "$1/Contents/Info.plist"; }
# Matches the app and its helpers, including Squirrel's ShipIt applying an update after quit.
# pgrep -f takes a regex, and app names contain parentheses.
# shellcheck disable=SC2009
running_from() { ps -axo command= | grep -F "$1/Contents/" | grep -v grep || true; }

[[ -d "$fork_app" ]] || fail "no fork app at $fork_app; build it first"
[[ -d "$nightly_app" ]] || fail "no Nightly app at $nightly_app"
fork_version="$(plist "$fork_app" CFBundleShortVersionString)"
nightly_version="$(plist "$nightly_app" CFBundleShortVersionString)"
[[ "$fork_version" == *-fork.* ]] || fail "$fork_app is version $fork_version, not a fork build"
[[ "$(plist "$fork_app" CFBundleIdentifier)" == "$(plist "$nightly_app" CFBundleIdentifier)" ]] ||
  fail "the fork app and Nightly have different bundle ids"
[[ ! -e "$fork_target" ]] || fail "$fork_target already exists; roll back or remove it first"

echo "Fork build: $fork_app ($fork_version)"
echo "Nightly:    $nightly_app ($nightly_version)"
echo "Database:   $state_db"
echo "Backup:     $backup_dir"

# The dry run reports what the real swap would refuse, so it can run while Nightly is open.
refuse() {
  if [[ $dry_run -eq 1 ]]; then echo "The real swap would stop here: $*"; else fail "$*"; fi
}
[[ -z "$(running_from "$nightly_app")" ]] ||
  refuse "Nightly or its updater is running; quit it (T3 Code > Quit) and run this again"
[[ -f "$state_db" ]] || fail "no database at $state_db"
db_users="$(lsof -t "$state_db" 2>/dev/null | tr '\n' ' ' || true)"
[[ -z "$db_users" ]] || refuse "processes still have $state_db open: $db_users"

need_kib=$(($(du -sk "$state_db" | cut -f1) * 2 + $(du -sk "$fork_app" | cut -f1)))
df_dir="$backup_root"
[[ -d "$df_dir" ]] || df_dir="$(dirname "$backup_root")"
free_kib="$(df -k "$df_dir" | awk 'NR == 2 { print $4 }')"
((free_kib > need_kib)) || fail "need $need_kib KiB free for the backup and the app, have $free_kib"

run mkdir -p "$backup_dir"
backup_db="$backup_dir/statev2.sqlite"
echo "+ sqlite3 'file:$state_db?mode=ro&immutable=1' \"VACUUM INTO '$backup_db'\""
if [[ $dry_run -eq 0 ]]; then
  # WAL database with no -shm once the app quits: a plain mode=ro open fails, and nothing holds it now.
  sqlite3 "file:$state_db?mode=ro&immutable=1" "VACUUM INTO '${backup_db//\'/\'\'}'"
  [[ "$(sqlite3 "file:$backup_db?mode=ro" "PRAGMA quick_check")" == "ok" ]] ||
    fail "the database backup failed its quick_check; nothing else changed"
  printf 'nightly_version=%s\nfork_version=%s\nfork_app=%s\n' \
    "$nightly_version" "$fork_version" "$(basename "$fork_app")" >"$backup_dir/swap.env"
fi
# Point latest here before moving anything, so a failed copy still rolls back from this backup.
run ln -sfn "$backup_dir" "$backup_root/latest"
run mv "$nightly_app" "$backup_dir/"
run ditto "$fork_app" "$fork_target"
# Keep t3code:// links and the shared bundle id from opening the backed-up Nightly.
run "$lsregister" -u "$backup_dir/$(basename "$nightly_app")" || echo "warning: lsregister failed"

echo
if [[ $dry_run -eq 1 ]]; then
  echo "Dry run: nothing changed."
else
  echo "Done. Open the fork build with: open '$fork_target'"
  echo "Roll back with: scripts/fork-app-rollback.sh"
fi
