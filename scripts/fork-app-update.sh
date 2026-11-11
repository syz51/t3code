#!/usr/bin/env bash
# Replace the installed fork app with a newer fork build: quit it, back it up, copy, reopen.
# See docs/operations/fork.md#update-the-fork-app.
# Usage: scripts/fork-app-update.sh [--dry-run] [--detach] [app main pid]
set -uo pipefail

fail() {
  echo "fork-app-update: $*" >&2
  exit 1
}

dry_run=0
detach=0
app_pid=""
for arg in "$@"; do
  case "$arg" in
    --dry-run) dry_run=1 ;;
    --detach) detach=1 ;;
    --*) fail "unknown option $arg" ;;
    *)
      [[ -z "$app_pid" && "$arg" =~ ^[0-9]+$ ]] || fail "pass at most one pid"
      app_pid="$arg"
      ;;
  esac
done

app="${T3_UPDATE_APP:-/Applications/T3 Code (Beta).app}"
new="${T3_UPDATE_BUILD:-$HOME/.t3-fork/build/mac-arm64/T3 Code (Beta).app}"
db="${T3_UPDATE_STATE_DB:-$HOME/.t3/userdata/statev2.sqlite}"
log_file="${T3_UPDATE_LOG:-$HOME/.t3-fork/update.log}"
backup="${T3_UPDATE_BACKUP_ROOT:-$HOME/.t3-swap-backup}/$(date +%Y%m%d-%H%M%S)-update"
app_name="$(basename "$app" .app)"
# The agent that starts the update runs inside the app; its reply must persist before the quit.
quit_delay=75

log() { echo "[$(date '+%F %T')] $*"; }
run() {
  echo "+ $*"
  if [[ $dry_run -eq 0 ]]; then "$@"; fi
}
plist() { /usr/libexec/PlistBuddy -c "Print :$2" "$1/Contents/Info.plist"; }
# The main process is the one launchd owns. pgrep -x finds nothing on some Macs, and helpers
# and CLI children also run from Contents/MacOS.
main_pids() {
  ps -axo pid=,ppid=,command= | awk -v prefix="$app/Contents/MacOS/" '
    $2 == 1 { cmd = $0; sub(/^ *[0-9]+ +[0-9]+ /, "", cmd); if (index(cmd, prefix) == 1) print $1 }'
}
is_app_pid() { ps -p "$1" -o command= | grep -qF "$app/Contents/MacOS/"; }
# shellcheck disable=SC2009
busy() {
  ps -axo command= | grep -F "$app/Contents/" | grep -v grep >/dev/null && return 0
  [[ -n "$(lsof -t "$db" 2>/dev/null)" ]]
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
  open "$app"
}

[[ -d "$new" ]] || fail "no new build at $new; build it first"
[[ -d "$app" ]] || fail "no installed app at $app; use scripts/fork-app-swap.sh for the first install"
[[ -f "$db" ]] || fail "no database at $db"
new_version="$(plist "$new" CFBundleShortVersionString)" || fail "cannot read the version of $new"
old_version="$(plist "$app" CFBundleShortVersionString)" || fail "cannot read the version of $app"
[[ "$new_version" == *-fork.* ]] || fail "$new is version $new_version, not a fork build"
[[ "$(plist "$new" CFBundleIdentifier)" == "$(plist "$app" CFBundleIdentifier)" ]] ||
  fail "the new build and the installed app have different bundle ids"

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
  echo "Installed: $app ($old_version)"
  echo "Main pid:  ${app_pid:-none, the app is not running}"
  echo "Database:  $db"
  echo "Backup:    $backup"
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
  T3_UPDATE_LOG="$log_file" perl -MPOSIX -e '
    fork and exit; POSIX::setsid(); fork and exit;
    open STDIN, "<", "/dev/null"; open STDOUT, ">>", $ENV{T3_UPDATE_LOG}; open STDERR, ">&", \*STDOUT;
    exec @ARGV' -- "$0" ${app_pid:+"$app_pid"} || fail "could not start the detached run"
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
      lsof -t "$db"
      exit 1
    fi
  fi
  log "app and database are free; backing up to $backup"
fi

backup_db="$backup/statev2.sqlite"
old_app="$backup/$(basename "$app")"
echo "+ mkdir -p '$backup'"
echo "+ sqlite3 'file:$db?mode=ro&immutable=1' \"VACUUM INTO '$backup_db'\""
if [[ $dry_run -eq 0 ]]; then
  mkdir -p "$backup" || {
    reopen
    exit 1
  }
  # WAL database with no -shm once the app quits: a plain mode=ro open fails, and nothing holds it now.
  if ! sqlite3 "file:$db?mode=ro&immutable=1" "VACUUM INTO '${backup_db//\'/\'\'}'" ||
    [[ "$(sqlite3 "file:$backup_db?mode=ro" "PRAGMA quick_check")" != "ok" ]]; then
    log "database backup failed; nothing else changed"
    reopen
    exit 1
  fi
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
run open "$app" || log "warning: could not open $app; open it by hand"

if [[ $dry_run -eq 1 ]]; then
  echo
  echo "Dry run: nothing changed."
else
  log "finished; installed version $(plist "$app" CFBundleShortVersionString); old app and database backup are in $backup"
fi
