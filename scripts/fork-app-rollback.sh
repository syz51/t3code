#!/usr/bin/env bash
# Undo scripts/fork-app-swap.sh: put Nightly back and, when the fork migrated the database past
# the backup, restore the backup. See docs/operations/fork.md#switch-to-the-fork-build.
# Usage: scripts/fork-app-rollback.sh [--dry-run] [--restore-db] [backup dir]
set -euo pipefail

dry_run=0
restore_db=auto
while [[ "${1:-}" == --* ]]; do
  case "$1" in
    --dry-run) dry_run=1 ;;
    --restore-db) restore_db=yes ;;
    *)
      echo "fork-app-rollback: unknown option $1" >&2
      exit 1
      ;;
  esac
  shift
done

apps_dir="${T3_SWAP_APPS_DIR:-/Applications}"
state_db="${T3_SWAP_STATE_DB:-$HOME/.t3/userdata/statev2.sqlite}"
backup_root="${T3_SWAP_BACKUP_ROOT:-$HOME/.t3-swap-backup}"
backup_dir="$(cd "${1:-$backup_root/latest}" && pwd -P)"
nightly_backup="$backup_dir/T3 Code (Nightly).app"
nightly_app="$apps_dir/T3 Code (Nightly).app"

fail() {
  echo "fork-app-rollback: $*" >&2
  exit 1
}
run() {
  echo "+ $*"
  if [[ $dry_run -eq 0 ]]; then "$@"; fi
}
# pgrep -f takes a regex, and app names contain parentheses.
# shellcheck disable=SC2009
running_from() { ps -axo command= | grep -F "$1/Contents/MacOS/" | grep -v grep || true; }
refuse() {
  if [[ $dry_run -eq 1 ]]; then echo "The real rollback would stop here: $*"; else fail "$*"; fi
}
last_migration() { sqlite3 "file:$1?mode=ro" "SELECT coalesce(max(migration_id), 0) FROM effect_sql_migrations"; }

[[ -f "$backup_dir/swap.env" ]] || fail "$backup_dir has no swap.env; pass the backup folder the swap printed"
fork_app_name="$(sed -n 's/^fork_app=//p' "$backup_dir/swap.env")"
fork_app="$apps_dir/$fork_app_name"
[[ -d "$nightly_backup" ]] || fail "no Nightly app in $backup_dir"
[[ -f "$backup_dir/statev2.sqlite" ]] || fail "no database backup in $backup_dir"
[[ ! -e "$nightly_app" ]] || fail "$nightly_app already exists"

echo "Backup:   $backup_dir"
echo "Fork app: $fork_app"
[[ -z "$(running_from "$fork_app")" ]] || refuse "the fork app is running; quit it and run this again"
db_users="$(lsof -t "$state_db" 2>/dev/null | tr '\n' ' ' || true)"
[[ -z "$db_users" ]] || refuse "processes still have $state_db open: $db_users"

current="$(last_migration "$state_db")"
backed_up="$(last_migration "$backup_dir/statev2.sqlite")"
echo "Last migration: $current now, $backed_up in the backup"
if [[ $restore_db == auto ]]; then
  if ((current > backed_up)); then restore_db=yes; else restore_db=no; fi
fi

if [[ -d "$fork_app" ]]; then
  run mv "$fork_app" "$backup_dir/$fork_app_name"
fi
if [[ $restore_db == yes ]]; then
  # Keep the fork's database beside the backup instead of deleting it.
  for suffix in "" -wal -shm; do
    if [[ -e "$state_db$suffix" ]]; then
      run mv "$state_db$suffix" "$backup_dir/statev2.fork.sqlite$suffix"
    fi
  done
  run cp "$backup_dir/statev2.sqlite" "$state_db"
else
  echo "Keeping the current database: Nightly reads it, and it holds the work done on the fork."
fi
run mv "$nightly_backup" "$nightly_app"

echo
if [[ $dry_run -eq 1 ]]; then
  echo "Dry run: nothing changed."
else
  echo "Done. Open Nightly with: open '$nightly_app'"
fi
