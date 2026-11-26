#!/usr/bin/env bash
# Sign or verify a macOS fork app bundle with a stable local code-signing identity so macOS
# Accessibility and Screen Recording grants survive fork updates.
# See docs/operations/fork.md#signing-identity.
# Usage:
#   scripts/fork-app-sign.sh [--identity <name-or-sha1>] [--keychain <path>] [path/to/app]
#   scripts/fork-app-sign.sh --check-identity [--identity <name-or-sha1>] [--keychain <path>]
#   scripts/fork-app-sign.sh --verify [path/to/app]
set -euo pipefail

fail() {
  echo "fork-app-sign: $*" >&2
  exit 1
}

mode="sign"
identity="${T3CODE_FORK_SIGNING_IDENTITY:-T3 Code Fork}"
keychain="${T3CODE_FORK_SIGNING_KEYCHAIN:-}"
app=""

while (($# > 0)); do
  case "$1" in
    --check-identity)
      mode="check-identity"
      shift
      ;;
    --verify)
      mode="verify"
      shift
      ;;
    --identity)
      (($# >= 2)) || fail "--identity requires a value"
      identity="$2"
      shift 2
      ;;
    --keychain)
      (($# >= 2)) || fail "--keychain requires a value"
      keychain="$2"
      shift 2
      ;;
    -h | --help)
      sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    --*)
      fail "unknown option $1"
      ;;
    *)
      [[ -z "$app" ]] || fail "pass at most one app path"
      app="$1"
      shift
      ;;
  esac
done

app="${app:-$HOME/.t3-fork/build/mac-arm64/T3 Code (Beta).app}"
plist() { /usr/libexec/PlistBuddy -c "Print :$2" "$1/Contents/Info.plist"; }

resolve_identity() {
  [[ -n "$identity" ]] || fail "signing identity name must not be empty"
  local raw
  if [[ -n "$keychain" ]]; then
    raw="$(security find-identity -p codesigning "$keychain" 2>&1)" ||
      fail "could not query keychain $keychain: $raw"
  else
    raw="$(security find-identity -p codesigning 2>&1)" ||
      fail "could not query code-signing identities: $raw"
  fi

  local matches
  matches="$(
    printf '%s\n' "$raw" | awk -v target="$identity" '
      /Valid identities only/ { exit }
      /^[[:space:]]*[0-9]+\)[[:space:]]+[0-9A-Fa-f]+[[:space:]]+"/ {
        line = $0
        sub(/^[[:space:]]*[0-9]+\)[[:space:]]+/, "", line)
        sha = substr(line, 1, 40)
        if (length(sha) != 40 || sha !~ /^[0-9A-Fa-f]+$/ || substr(line, 41, 1) !~ /[[:space:]]/) next
        rest = substr(line, 42)
        sub(/^[[:space:]]*"/, "", rest)
        sub(/".*$/, "", rest)
        if (tolower(sha) == tolower(target) || rest == target) {
          if (!seen[toupper(sha)]++) print toupper(sha)
        }
      }
    '
  )"

  if [[ -z "$matches" ]]; then
    fail "signing identity '$identity' not found in keychain${keychain:+ ($keychain)}; create it per docs/operations/fork.md#signing-identity"
  fi

  local count
  count="$(printf '%s\n' "$matches" | wc -l | tr -d ' ')"
  if [[ "$count" -ne 1 ]]; then
    fail "signing identity '$identity' is ambiguous ($count matches: $(printf '%s' "$matches" | tr '\n' ' ')); remove duplicates or set T3CODE_FORK_SIGNING_IDENTITY to a 40-char SHA-1"
  fi
  printf '%s\n' "$matches"
}

verify_app() {
  local target="$1"
  [[ -d "$target" ]] || fail "no app bundle at $target"
  local bundle_id
  bundle_id="$(plist "$target" CFBundleIdentifier 2>/dev/null)" ||
    fail "cannot read CFBundleIdentifier from $target"
  [[ -n "$bundle_id" ]] || fail "empty CFBundleIdentifier in $target"

  local verify_out
  if ! verify_out="$(codesign --verify --deep --strict "$target" 2>&1)"; then
    fail "$target failed codesign --verify --deep --strict: $verify_out"
  fi

  local dvvv
  if ! dvvv="$(codesign -dvvv "$target" 2>&1)"; then
    fail "cannot read signature details of $target: $dvvv"
  fi
  if printf '%s\n' "$dvvv" | grep -qE '^Signature=adhoc$|^CodeDirectory .*adhoc'; then
    fail "$target has an ad-hoc signature; fork builds must be signed with a stable identity"
  fi
  local authority
  authority="$(printf '%s\n' "$dvvv" | sed -n 's/^Authority=//p' | head -1)"
  [[ -n "$authority" ]] || fail "$target has no signing Authority"
  printf '%s\n' "$dvvv" | grep -qxF "Identifier=$bundle_id" ||
    fail "$target signature Identifier does not match CFBundleIdentifier ($bundle_id)"
  printf '%s\n' "$dvvv" | grep -qE '^Info\.plist entries=[0-9]+' ||
    fail "$target Info.plist is not bound by the signature"
  printf '%s\n' "$dvvv" | grep -qE '^Sealed Resources version=' ||
    fail "$target has no sealed resources in its signature"

  local req_out designated
  if ! req_out="$(codesign -d -r- "$target" 2>&1)"; then
    fail "cannot read designated requirement of $target: $req_out"
  fi
  designated="$(printf '%s\n' "$req_out" | sed -n 's/^designated => //p' | head -1)"
  [[ -n "$designated" ]] || fail "$target has no designated requirement (ad-hoc or unsigned)"
  if printf '%s\n' "$designated" | grep -qE '\bcdhash\b'; then
    fail "$target designated requirement pins a cdhash instead of a certificate ($designated)"
  fi
  if ! printf '%s\n' "$designated" | grep -qF "identifier \"$bundle_id\"" ||
    ! printf '%s\n' "$designated" | grep -qE '\bcertificate\b'; then
    fail "$target designated requirement does not pin identifier \"$bundle_id\" and certificate ($designated)"
  fi

  echo "Verified $target ($bundle_id, Authority=$authority)"
}

case "$mode" in
  check-identity)
    sha="$(resolve_identity)"
    echo "Signing identity ready: $identity ($sha)"
    ;;
  verify)
    verify_app "$app"
    ;;
  sign)
    [[ -d "$app" ]] || fail "no app bundle at $app"
    sha="$(resolve_identity)"
    codesign_args=(--force --deep --timestamp=none)
    if [[ -n "$keychain" ]]; then
      codesign_args+=(--keychain "$keychain")
    fi
    codesign_args+=(--sign "$sha" "$app")
    if ! codesign_out="$(codesign "${codesign_args[@]}" 2>&1)"; then
      fail "codesign failed for $app with identity $identity ($sha): $codesign_out"
    fi
    verify_app "$app"
    ;;
esac
