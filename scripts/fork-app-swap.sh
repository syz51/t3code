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
verify_signed_build() {
  local target="$1"
  local expected_id="$2"
  local verify_out dvvv req_out designated authority
  if ! verify_out="$(codesign --verify --deep --strict "$target" 2>&1)"; then
    fail "$target failed codesign --verify --deep --strict (refusing to install): $verify_out"
  fi
  if ! dvvv="$(codesign -dvvv "$target" 2>&1)"; then
    fail "cannot inspect signature of $target: $dvvv"
  fi
  if printf '%s\n' "$dvvv" | grep -qE '^Signature=adhoc$|^CodeDirectory .*adhoc'; then
    fail "$target is ad-hoc signed; sign it on the build host before installing"
  fi
  authority="$(printf '%s\n' "$dvvv" | sed -n 's/^Authority=//p' | head -1)"
  [[ -n "$authority" ]] || fail "$target has no signing Authority; refusing to install"
  printf '%s\n' "$dvvv" | grep -qxF "Identifier=$expected_id" ||
    fail "$target signature Identifier does not match $expected_id"
  printf '%s\n' "$dvvv" | grep -qE '^Info\.plist entries=[0-9]+' ||
    fail "$target Info.plist is not bound by its signature"
  printf '%s\n' "$dvvv" | grep -qE '^Sealed Resources version=' ||
    fail "$target has no sealed resources in its signature"
  if ! req_out="$(codesign -d -r- "$target" 2>&1)"; then
    fail "cannot read designated requirement of $target: $req_out"
  fi
  designated="$(printf '%s\n' "$req_out" | sed -n 's/^designated => //p' | head -1)"
  [[ -n "$designated" ]] || fail "$target has no designated requirement (ad-hoc or unsigned)"
  if printf '%s\n' "$designated" | grep -qE '\bcdhash\b'; then
    fail "$target designated requirement pins a cdhash instead of a certificate ($designated)"
  fi
  if ! printf '%s\n' "$designated" | grep -qF "identifier \"$expected_id\"" ||
    ! printf '%s\n' "$designated" | grep -qE '\bcertificate\b'; then
    fail "$target designated requirement does not pin identifier \"$expected_id\" and certificate ($designated)"
  fi
  fork_authority="$authority"
}

[[ -d "$fork_app" ]] || fail "no fork app at $fork_app; build it first"
[[ -d "$nightly_app" ]] || fail "no Nightly app at $nightly_app"
fork_version="$(plist "$fork_app" CFBundleShortVersionString)"
nightly_version="$(plist "$nightly_app" CFBundleShortVersionString)"
[[ "$fork_version" == *-fork.* ]] || fail "$fork_app is version $fork_version, not a fork build"
fork_bundle_id="$(plist "$fork_app" CFBundleIdentifier)"
[[ "$fork_bundle_id" == "$(plist "$nightly_app" CFBundleIdentifier)" ]] ||
  fail "the fork app and Nightly have different bundle ids"
[[ ! -e "$fork_target" ]] || fail "$fork_target already exists; roll back or remove it first"
fork_authority=""
verify_signed_build "$fork_app" "$fork_bundle_id"

echo "Fork build: $fork_app ($fork_version)"
echo "Signed by:  $fork_authority"
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
db_files=("$state_db")
[[ -e "$state_db-wal" ]] && db_files+=("$state_db-wal")
[[ -e "$state_db-shm" ]] && db_files+=("$state_db-shm")
db_users="$(lsof -t "${db_files[@]}" 2>/dev/null | tr '\n' ' ' || true)"
[[ -z "$db_users" ]] || refuse "processes still have $state_db open: $db_users"

need_kib=$(($(du -sk "$state_db" | cut -f1) * 2 + $(du -sk "$fork_app" | cut -f1)))
df_dir="$backup_root"
[[ -d "$df_dir" ]] || df_dir="$(dirname "$backup_root")"
free_kib="$(df -k "$df_dir" | awk 'NR == 2 { print $4 }')"
((free_kib > need_kib)) || fail "need $need_kib KiB free for the backup and the app, have $free_kib"

run mkdir -p "$(dirname "$backup_dir")"
run mkdir "$backup_dir"
backup_db="$backup_dir/statev2.sqlite"
echo "+ sqlite3 '$state_db' \"PRAGMA busy_timeout = 5000; VACUUM INTO '$backup_db'\""
if [[ $dry_run -eq 0 ]]; then
  # Open normally (never immutable=1) so any uncheckpointed -wal frames are replayed into the backup.
  if ! sqlite3 "$state_db" "PRAGMA busy_timeout = 5000; VACUUM INTO '${backup_db//\'/\'\'}'"; then
    rm -f "$backup_db" "$backup_db-wal" "$backup_db-shm"
    rmdir "$backup_dir" 2>/dev/null || true
    fail "database backup failed; nothing else changed"
  fi
  if [[ "$(sqlite3 "file:$backup_db?mode=ro" "PRAGMA quick_check")" != "ok" ]]; then
    rm -f "$backup_db" "$backup_db-wal" "$backup_db-shm"
    rmdir "$backup_dir" 2>/dev/null || true
    fail "the database backup failed its quick_check; nothing else changed"
  fi
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
