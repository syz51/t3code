#!/usr/bin/env bash
# Replace the installed fork app with a newer fork build: quit it, back it up, optionally
# defragment the live database, copy, reopen, prune old backups, and clean the staged build.
# See docs/operations/fork.md#update-the-fork-app.
# Usage: scripts/fork-app-update.sh [--dry-run] [--detach] [--keep-build] [--no-defrag] [app main pid]
set -uo pipefail

fail() {
  echo "fork-app-update: $*" >&2
  exit 1
}

dry_run=0
detach=0
keep_build=0
defrag_enabled="${T3_UPDATE_DEFRAG:-1}"
app_pid=""
for arg in "$@"; do
  case "$arg" in
    --dry-run) dry_run=1 ;;
    --detach) detach=1 ;;
    --keep-build) keep_build=1 ;;
    --no-defrag) defrag_enabled=0 ;;
    --*) fail "unknown option $arg" ;;
    *)
      [[ -z "$app_pid" && "$arg" =~ ^[0-9]+$ ]] || fail "pass at most one pid"
      app_pid="$arg"
      ;;
  esac
done

keep_count="${T3_UPDATE_KEEP-1}"
[[ "$keep_count" =~ ^[0-9]+$ ]] ||
  fail "T3_UPDATE_KEEP must be an integer >= 1 (got '$keep_count')"
keep_count=$((10#$keep_count))
((keep_count >= 1)) ||
  fail "T3_UPDATE_KEEP must be an integer >= 1 (got '${T3_UPDATE_KEEP-1}')"

[[ "$defrag_enabled" == "0" || "$defrag_enabled" == "1" ]] ||
  fail "T3_UPDATE_DEFRAG must be 0 or 1 (got '$defrag_enabled')"

defrag_min_pct="${T3_UPDATE_DEFRAG_MIN_PCT-10}"
[[ "$defrag_min_pct" =~ ^[0-9]+$ ]] ||
  fail "T3_UPDATE_DEFRAG_MIN_PCT must be an integer between 0 and 100 (got '$defrag_min_pct')"
defrag_min_pct=$((10#$defrag_min_pct))
((defrag_min_pct <= 100)) ||
  fail "T3_UPDATE_DEFRAG_MIN_PCT must be an integer between 0 and 100 (got '${T3_UPDATE_DEFRAG_MIN_PCT-10}')"

defrag_min_mib="${T3_UPDATE_DEFRAG_MIN_MIB-64}"
[[ "$defrag_min_mib" =~ ^[0-9]+$ ]] ||
  fail "T3_UPDATE_DEFRAG_MIN_MIB must be a non-negative integer (got '$defrag_min_mib')"
defrag_min_mib=$((10#$defrag_min_mib))

app="${T3_UPDATE_APP:-/Applications/T3 Code (Beta).app}"
new="${T3_UPDATE_BUILD:-$HOME/.t3-fork/build/mac-arm64/T3 Code (Beta).app}"
db="${T3_UPDATE_STATE_DB:-$HOME/.t3/userdata/statev2.sqlite}"
log_file="${T3_UPDATE_LOG:-$HOME/.t3-fork/update.log}"
backup_root="${T3_UPDATE_BACKUP_ROOT:-$HOME/.t3-swap-backup}"
backup="$backup_root/$(date +%Y%m%d-%H%M%S)-update"
app_name="$(basename "$app" .app)"
# The agent that starts the update runs inside the app; its reply must persist before the quit.
quit_delay=75

if [[ -n "${T3_UPDATE_BUILD_ROOT:-}" ]]; then
  build_cleanup_target="$T3_UPDATE_BUILD_ROOT"
elif [[ "$new" == "$HOME/.t3-fork/build/"* ]]; then
  build_cleanup_target="$HOME/.t3-fork/build"
else
  build_cleanup_target="$new"
fi

log() { echo "[$(date '+%F %T')] $*"; }
run() {
  echo "+ $*"
  if [[ $dry_run -eq 0 ]]; then "$@"; fi
}
plist() { /usr/libexec/PlistBuddy -c "Print :$2" "$1/Contents/Info.plist"; }
file_bytes() {
  [[ -f "$1" ]] && stat -f%z "$1" || echo 0
}
# The main process is the one launchd owns. pgrep -x finds nothing on some Macs, and helpers
# and CLI children also run from Contents/MacOS.
main_pids() {
  ps -axo pid=,ppid=,command= | awk -v prefix="$app/Contents/MacOS/" '
    $2 == 1 { cmd = $0; sub(/^ *[0-9]+ +[0-9]+ /, "", cmd); if (index(cmd, prefix) == 1) print $1 }'
}
is_app_pid() { ps -p "$1" -o command= | grep -qF "$app/Contents/MacOS/"; }
db_open_pids() {
  local db_files=("$db")
  [[ -e "$db-wal" ]] && db_files+=("$db-wal")
  [[ -e "$db-shm" ]] && db_files+=("$db-shm")
  lsof -t "${db_files[@]}" 2>/dev/null || true
}
# shellcheck disable=SC2009
busy() {
  ps -axo command= | grep -F "$app/Contents/" | grep -v grep >/dev/null && return 0
  [[ -n "$(db_open_pids)" ]]
}
wait_free() {
  for _ in $(seq "$1"); do
    busy || return 0
    sleep 2
  done
  return 1
}
reopen() {
  log "reopening the unchanged app"
  env -u ELECTRON_RUN_AS_NODE open "$app"
}
# Self-contained signature check: this script is rsynced standalone to the Pro without helper scripts.
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
  build_authority="$authority"
}

# Lists real `<8 digits>-<6 digits>-update` directories directly in $backup_root, sorted by name.
list_update_backups() {
  [[ -d "$backup_root" ]] || return 0
  local entry base
  local -a names=()
  for entry in "$backup_root"/*; do
    [[ -e "$entry" ]] || continue
    [[ ! -L "$entry" && -d "$entry" ]] || continue
    base="$(basename "$entry")"
    if [[ "$base" =~ ^[0-9]{8}-[0-9]{6}-update$ ]]; then
      names+=("$base")
    fi
  done
  if ((${#names[@]} > 0)); then
    printf '%s\n' "${names[@]}" | LC_ALL=C sort
  fi
}

# Computes which existing backup folders in $backup_root should be pruned to keep the newest $keep_count.
# When $1 == "dry-run", includes the planned $(basename "$backup") as the newest folder.
plan_pruned_backups() {
  local mode="${1:-real}"
  local current_base latest_real=""
  current_base="$(basename "$backup")"
  if [[ -e "$backup_root/latest" ]]; then
    latest_real="$(CDPATH='' cd "$backup_root/latest" 2>/dev/null && pwd -P || true)"
  fi

  local -a all_names=()
  local name
  while IFS= read -r name; do
    [[ -n "$name" ]] && all_names+=("$name")
  done < <(list_update_backups)

  if [[ "$mode" == "dry-run" ]]; then
    local already_present=0
    if ((${#all_names[@]} > 0)); then
      for name in "${all_names[@]}"; do
        if [[ "$name" == "$current_base" ]]; then
          already_present=1
          break
        fi
      done
    fi
    if [[ $already_present -eq 0 ]]; then
      all_names+=("$current_base")
    fi
    if ((${#all_names[@]} > 0)); then
      local -a sorted=()
      while IFS= read -r name; do
        [[ -n "$name" ]] && sorted+=("$name")
      done < <(printf '%s\n' "${all_names[@]}" | LC_ALL=C sort)
      all_names=("${sorted[@]}")
    fi
  fi

  local total="${#all_names[@]}"
  if ((total <= keep_count)); then
    return 0
  fi

  local prune_n=$((total - keep_count))
  local i candidate candidate_real
  for ((i = 0; i < prune_n; i++)); do
    name="${all_names[$i]}"
    [[ "$name" == "$current_base" ]] && continue
    candidate="$backup_root/$name"
    [[ ! -L "$candidate" && -d "$candidate" ]] || continue
    if [[ -n "$latest_real" ]]; then
      candidate_real="$(CDPATH='' cd "$candidate" 2>/dev/null && pwd -P || true)"
      [[ -n "$candidate_real" && "$candidate_real" == "$latest_real" ]] && continue
    fi
    printf '%s\n' "$candidate"
  done
}

prune_old_backups() {
  local target
  while IFS= read -r target; do
    [[ -n "$target" ]] || continue
    log "pruning old update backup: $target"
    if ! rm -rf "$target"; then
      log "warning: could not remove old update backup $target"
    fi
  done < <(plan_pruned_backups real)
}

canonical_path() {
  local target="$1"
  if [[ -d "$target" ]]; then
    CDPATH='' cd "$target" 2>/dev/null && pwd -P
    return
  fi
  local parent base
  parent="$(dirname "$target")"
  base="$(basename "$target")"
  parent="$(CDPATH='' cd "$parent" 2>/dev/null && pwd -P)" || return 1
  if [[ "$parent" == "/" ]]; then
    printf '/%s\n' "$base"
  else
    printf '%s/%s\n' "$parent" "$base"
  fi
}

safe_build_cleanup_target() {
  [[ -n "$build_cleanup_target" ]] || return 1
  [[ ! -L "$build_cleanup_target" && -e "$build_cleanup_target" ]] || return 1
  local resolved home_resolved
  resolved="$(canonical_path "$build_cleanup_target")" || return 1
  home_resolved="$(canonical_path "$HOME" 2>/dev/null || printf '%s' "$HOME")"
  case "$resolved" in
    "" | "/" | "/Applications" | "/Library" | "/System" | "/Users" | "/usr" | "$home_resolved")
      return 1
      ;;
  esac
  return 0
}

cleanup_staged_build() {
  if [[ $keep_build -eq 1 ]]; then
    log "keeping staged build at $build_cleanup_target (--keep-build)"
    return 0
  fi
  if ! safe_build_cleanup_target; then
    return 0
  fi
  log "removing staged build: $build_cleanup_target"
  if ! rm -rf "$build_cleanup_target"; then
    log "warning: could not remove staged build $build_cleanup_target"
  fi
}

# Replaces the live $db with a verified copy of the already-vacuumed $backup_db when intra-page
# slack exceeds the configured thresholds. Preserves $backup_db as the verified pre-swap backup.
maybe_defrag_live_db() {
  local backup_db="$1"
  if [[ $defrag_enabled -eq 0 ]]; then
    log "skipping live database defrag (--no-defrag / T3_UPDATE_DEFRAG=0)"
    return 0
  fi

  local db_bytes wal_bytes live_bytes compact_bytes reclaim_bytes min_bytes reclaim_pct
  db_bytes="$(file_bytes "$db")"
  wal_bytes="$(file_bytes "$db-wal")"
  live_bytes=$((db_bytes + wal_bytes))
  compact_bytes="$(file_bytes "$backup_db")"
  if ((live_bytes <= 0 || compact_bytes <= 0)); then
    return 0
  fi
  reclaim_bytes=$((live_bytes - compact_bytes))
  min_bytes=$((defrag_min_mib * 1024 * 1024))
  if ((reclaim_bytes <= 0 || reclaim_bytes < min_bytes)); then
    log "live database slack below threshold (live=${live_bytes}B, compacted=${compact_bytes}B); keeping live file"
    return 0
  fi
  reclaim_pct=$((reclaim_bytes * 100 / live_bytes))
  if ((reclaim_pct < defrag_min_pct)); then
    log "live database slack ${reclaim_pct}% below ${defrag_min_pct}% threshold; keeping live file"
    return 0
  fi

  if [[ -n "$(db_open_pids)" ]]; then
    log "warning: database became busy before defrag swap; keeping live file"
    return 0
  fi

  local staged_db="$db.defrag.$$"
  local pre_swap="$db.pre-defrag.$$"
  log "reclaiming intra-page database slack: ${live_bytes}B -> ${compact_bytes}B (${reclaim_pct}% / $((reclaim_bytes / 1048576)) MiB)"
  # Clone copy-on-write on APFS when available; fall back to regular copy otherwise.
  if ! (cp -c "$backup_db" "$staged_db" 2>/dev/null || cp "$backup_db" "$staged_db"); then
    rm -f "$staged_db"
    log "warning: could not stage compacted database; keeping live file"
    return 0
  fi
  if [[ "$(sqlite3 "file:$staged_db?mode=ro" "PRAGMA quick_check")" != "ok" ]]; then
    rm -f "$staged_db"
    log "warning: staged compacted database failed quick_check; keeping live file"
    return 0
  fi

  # Move the live DB and any -wal/-shm aside together so stale WAL frames can never attach to the new file.
  local moved_wal=0 moved_shm=0
  if ! mv "$db" "$pre_swap"; then
    rm -f "$staged_db"
    log "warning: could not move live database aside; keeping live file"
    return 0
  fi
  if [[ -e "$db-wal" ]]; then
    if mv "$db-wal" "$pre_swap-wal"; then
      moved_wal=1
    else
      mv "$pre_swap" "$db" 2>/dev/null || true
      rm -f "$staged_db"
      log "warning: could not move live -wal aside; restored live file"
      return 0
    fi
  fi
  if [[ -e "$db-shm" ]]; then
    if mv "$db-shm" "$pre_swap-shm"; then
      moved_shm=1
    else
      mv "$pre_swap" "$db" 2>/dev/null || true
      [[ $moved_wal -eq 1 ]] && mv "$pre_swap-wal" "$db-wal" 2>/dev/null || true
      rm -f "$staged_db"
      log "warning: could not move live -shm aside; restored live file"
      return 0
    fi
  fi

  if ! mv "$staged_db" "$db" ||
    [[ "$(sqlite3 "file:$db?mode=ro" "PRAGMA quick_check")" != "ok" ]]; then
    log "warning: defragmented database swap failed verification; restoring original live file"
    rm -f "$db" "$staged_db"
    mv "$pre_swap" "$db"
    [[ $moved_wal -eq 1 ]] && mv "$pre_swap-wal" "$db-wal"
    [[ $moved_shm -eq 1 ]] && mv "$pre_swap-shm" "$db-shm"
    return 0
  fi

  rm -f "$pre_swap" "$pre_swap-wal" "$pre_swap-shm"
  log "defragmented live database verified (${compact_bytes}B, pre-swap backup preserved at $backup_db)"
}

[[ -d "$new" ]] || fail "no new build at $new; build it first"
[[ -d "$app" ]] || fail "no installed app at $app; use scripts/fork-app-swap.sh for the first install"
[[ -f "$db" ]] || fail "no database at $db"
new_version="$(plist "$new" CFBundleShortVersionString)" || fail "cannot read the version of $new"
old_version="$(plist "$app" CFBundleShortVersionString)" || fail "cannot read the version of $app"
[[ "$new_version" == *-fork.* ]] || fail "$new is version $new_version, not a fork build"
new_bundle_id="$(plist "$new" CFBundleIdentifier)" || fail "cannot read the bundle id of $new"
old_bundle_id="$(plist "$app" CFBundleIdentifier)" || fail "cannot read the bundle id of $app"
[[ "$new_bundle_id" == "$old_bundle_id" ]] ||
  fail "the new build and the installed app have different bundle ids"
build_authority=""
verify_signed_build "$new" "$new_bundle_id"

if [[ -n "$app_pid" ]]; then
  is_app_pid "$app_pid" || fail "pid $app_pid is not a process of $app"
else
  app_pid="$(main_pids)"
  [[ "$app_pid" != *$'\n'* ]] || fail "more than one main process of $app: $(echo "$app_pid" | tr '\n' ' ')"
fi

need_kib=$(($(du -sk "$db" | cut -f1) * 2 + $(du -sk "$new" | cut -f1)))
free_kib="$(df -k "$HOME" | awk 'NR == 2 { print $4 }')"
((free_kib > need_kib)) || fail "need $need_kib KiB free for the backup and the app, have $free_kib"

if [[ $dry_run -eq 1 ]]; then
  echo "New build: $new ($new_version)"
  echo "Signed by: $build_authority"
  echo "Installed: $app ($old_version)"
  echo "Main pid:  ${app_pid:-none, the app is not running}"
  echo "Database:  $db"
  echo "Backup:    $backup (keep newest $keep_count)"
  if [[ $defrag_enabled -eq 1 ]]; then
    echo "Defrag:    enabled when VACUUM INTO saves >= ${defrag_min_pct}% and >= ${defrag_min_mib} MiB"
  else
    echo "Defrag:    disabled (--no-defrag / T3_UPDATE_DEFRAG=0)"
  fi
  if [[ $keep_build -eq 1 ]]; then
    echo "Build dir: keep $build_cleanup_target (--keep-build)"
  else
    echo "Build dir: would remove $build_cleanup_target after launch"
  fi
  if [[ $detach -eq 1 ]]; then echo "Would run in a new session, with output appended to $log_file"; fi
  echo "+ sleep $quit_delay"
  if [[ -n "$app_pid" ]]; then
    echo "+ osascript -e 'tell application \"$app_name\" to quit'"
    echo "  if the app still runs after 90 s: kill -TERM $app_pid (twice), then wait 120 s more"
  fi
elif [[ $detach -eq 1 ]]; then
  # Quitting the app ends the agent that started this script, and the app stops that agent's
  # whole session. A double fork with setsid leaves this run outside it.
  mkdir -p "$(dirname "$log_file")" || fail "cannot create the folder of $log_file"
  detach_args=()
  [[ $keep_build -eq 1 ]] && detach_args+=("--keep-build")
  [[ $defrag_enabled -eq 0 ]] && detach_args+=("--no-defrag")
  [[ -n "$app_pid" ]] && detach_args+=("$app_pid")
  T3_UPDATE_LOG="$log_file" perl -MPOSIX -e '
    fork and exit; POSIX::setsid(); fork and exit;
    open STDIN, "<", "/dev/null"; open STDOUT, ">>", $ENV{T3_UPDATE_LOG}; open STDERR, ">&", \*STDOUT;
    exec @ARGV' -- "$0" ${detach_args[@]+"${detach_args[@]}"} || fail "could not start the detached run"
  echo "Started detached. The app quits in about $quit_delay s. Log: $log_file"
  exit 0
else
  log "update $old_version -> $new_version started; waiting ${quit_delay}s so the agent's reply persists"
  sleep "$quit_delay"
  if [[ -n "$app_pid" ]]; then
    log "asking the app to quit"
    osascript -e "tell application \"$app_name\" to quit" 2>&1
  fi
  if ! wait_free 45; then
    # Only the pid verified above, and only while it is still the app (pids are reused).
    if [[ -n "$app_pid" ]] && is_app_pid "$app_pid"; then
      log "app still running after 90s; SIGTERM to pid $app_pid (twice)"
      kill -TERM "$app_pid"
      sleep 5
      kill -TERM "$app_pid" 2>/dev/null
    fi
    if ! wait_free 60; then
      log "still busy; nothing changed"
      # shellcheck disable=SC2009
      ps -axo pid=,command= | grep -F "$app/Contents/" | grep -v grep
      db_open_pids
      exit 1
    fi
  fi
  log "app and database are free; backing up to $backup"
fi

backup_db="$backup/statev2.sqlite"
old_app="$backup/$(basename "$app")"
echo "+ mkdir -p '$(dirname "$backup")' && mkdir '$backup'"
echo "+ sqlite3 '$db' \"PRAGMA busy_timeout = 5000; VACUUM INTO '$backup_db'\""
if [[ $dry_run -eq 0 ]]; then
  if ! mkdir -p "$(dirname "$backup")" || ! mkdir "$backup"; then
    log "could not create backup folder $backup; nothing else changed"
    reopen
    exit 1
  fi
  # Open normally (never immutable=1) so any uncheckpointed -wal frames are replayed into the backup.
  if ! sqlite3 "$db" "PRAGMA busy_timeout = 5000; VACUUM INTO '${backup_db//\'/\'\'}'" ||
    [[ "$(sqlite3 "file:$backup_db?mode=ro" "PRAGMA quick_check")" != "ok" ]]; then
    log "database backup failed; nothing else changed"
    rm -f "$backup_db" "$backup_db-wal" "$backup_db-shm"
    rmdir "$backup" 2>/dev/null || true
    reopen
    exit 1
  fi
  maybe_defrag_live_db "$backup_db"
fi
run mv "$app" "$backup/" || {
  log "could not move the old app"
  reopen
  exit 1
}
if ! run ditto "$new" "$app"; then
  log "copy failed; restoring the old app"
  rm -rf "$app"
  mv "$old_app" "$app"
  reopen
  exit 1
fi
if [[ $dry_run -eq 1 ]]; then
  run env -u ELECTRON_RUN_AS_NODE open "$app"
  while IFS= read -r target; do
    [[ -n "$target" ]] && echo "Would prune old update backup: $target"
  done < <(plan_pruned_backups dry-run)
  if [[ $keep_build -eq 0 ]] && safe_build_cleanup_target; then
    echo "Would remove staged build: $build_cleanup_target"
  fi
  echo
  echo "Dry run: nothing changed."
else
  if run env -u ELECTRON_RUN_AS_NODE open "$app"; then
    prune_old_backups
    cleanup_staged_build
  else
    log "warning: could not open $app; open it by hand (keeping old backups and staged build)"
  fi
  log "finished; installed version $(plist "$app" CFBundleShortVersionString); old app and database backup are in $backup"
fi
