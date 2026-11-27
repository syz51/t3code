# Running the fork beside T3 Code

This fork (`syz51/t3code`) is tested next to the installed T3 Code app. The installed app owns
`~/.t3` and port 3773. Fork runs use `~/.t3-fork` and port 3799, so they never touch either.

## Branches

- `main` mirrors `upstream/main` (`pingdotgg/t3code`). It never carries fork commits, so it
  only fast-forwards.
- `fork` is `upstream/main` plus the fork's patches, joined by merge commits. Keep the patches
  few and small, and keep fork-only material in fork-only files such as this one, so merges
  stay clean.
- `fork` installs with bun instead of upstream's pnpm. See [Package manager](#package-manager).
- Patch work branches start from `fork`. A patch meant for upstream starts from `main` instead,
  and lands on `fork` once upstream merges it, or as a cherry-pick until then.

## State machine audit

[Implicit state machines](../internals/state-machines.md) lists the state machines that the fork
runs, where each transition is enforced, and each known gap with its board task. Read the entry
before you change one of these machines, and correct it when you do.

## Sync with upstream

A sync merges `upstream/main` into a branch from `fork` and lands it through a PR, so CI runs
before `fork` changes. `fork` is never rebased or force-pushed. The T3 scheduled task "Daily fork
upstream sync" starts one every day at 10:00 in a new thread on the Air, and that agent follows
this section.

```sh
git fetch upstream main
git fetch origin
git push origin upstream/main:main
git switch -c fork-sync-<yyyymmdd> origin/fork
git merge --no-ff upstream/main
```

Resolve conflicts as below, then:

```sh
bun scripts/fork-ci-runners.ts
bun install --frozen-lockfile
vp run check:changed upstream/main
git push -u origin fork-sync-<yyyymmdd>
gh pr create --repo syz51/t3code --base fork --head fork-sync-<yyyymmdd>
```

Fix CI failures on the branch. Merge the PR with a merge commit (`gh pr merge --merge`), never a
squash, so `fork` keeps upstream's history and the next merge finds the right base. Then
[deliver the build](#deliver-the-build).

Agent Context Budget fails when upstream grew the agent context since the last sync. The fork's
own instruction edits make its budget differ from upstream's, so compare growth, not values. Before
opening the PR, run `git diff <old> upstream/main -- apps/server/src/provider/agentContextBudget.json`,
where `<old>` is `git merge-base origin/fork upstream/main` taken before the merge. When upstream
grew the budget and no number grew more on the branch than in that diff, the growth is upstream's:
pass `--label agent-context-increase` to `gh pr create`. If the label is added after the PR is
opened (or an `opened` run finishes before the label lands and fails), add the label and rerun the
failed run (`gh run rerun <run-id> --failed`); the workflow reads the PR's live labels at run time,
so no empty commit is needed.

On macOS, some server tests fail locally because temporary paths resolve to `/private/var` or
the file system ignores case. CI runs them on Linux; trust its result there.

### Package files

`package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml` and `.pnpmfile.cjs` conflict whenever
upstream changes them. Never merge `bun.lock`, `bunfig.toml` or the converted `package.json` by
hand. Regenerate them from upstream's files:

```sh
git checkout upstream/main -- package.json pnpm-lock.yaml pnpm-workspace.yaml .pnpmfile.cjs
bun scripts/fork-convert-to-bun.ts
bun install
git add -A package.json bun.lock bunfig.toml pnpm-lock.yaml pnpm-workspace.yaml .pnpmfile.cjs
```

The script migrates upstream's lockfile and workspace into `package.json` and `bun.lock`,
writes `bunfig.toml`, formats both as `vp fmt` does, and deletes the pnpm files. It
fails when bun still warns, for example about a patch that no longer applies to a new version.
Fix that in `package.json` and run `bun install`.

### Workflows, scripts and docs

The fork keeps `AGENTS.md` under Antigravity's 24,000-byte per-file rule cap by linking to `docs/internals/00_glossary.md` and `docs/internals/15_testing.md` instead of repeating those sections inline. When upstream edits those sections, keep the link summary in `AGENTS.md` and mirror any new rule into `docs/internals/15_testing.md` or `docs/internals/00_glossary.md`.

The fork's bun edits conflict when upstream edits the same lines. Keep upstream's change and redo
the fork's edit in it: `bun install` for pnpm installs, `bun.lock` for `pnpm-lock.yaml`, and
`package.json` for `pnpm-workspace.yaml`. A filtered bun install leaves out the root package,
which owns `vite-plus`, so add `--filter=@t3tools/monorepo` to every filtered install; without
it `vp` cannot load the task graph. `apps/mobile/eas.json` pins the same bun version as
`packageManager`; update both together.

Upstream also adds steps that merge cleanly but still use pnpm or corepack. After each merge,
`git grep -n 'pnpm\|corepack' -- .github` must find only comments; convert the rest the same way.

`fork-ci-runners.ts` maps upstream's Blacksmith runner labels, which the fork has no
installation for, to GitHub-hosted runners. It scales each mapped job's timeouts by the vCPUs it
loses, because the hosted runners have 3 or 4. A reusable workflow takes the largest loss among
the runners its callers pass. Each mapped line keeps upstream's label or timeout in a
`# fork-mapped:` or `# fork-scaled:` comment, so a rerun rescales from upstream's value. The
script also checks that Agent Context Budget compares with the PR's base branch, because `fork`
lags `main` until the sync. Upstream's check reads the PR merge's first parent, which is that
base. The fork also changes `agent-context-budget.yml` to read live PR labels via `gh api` (with
`pull-requests: read`) instead of `github.event.pull_request.labels`, so `gh pr create --label`
and reruns see the current labels; keep that change if an upstream edit conflicts there.

A `runs-on` or `timeout-minutes` line conflicts when upstream edits it. In each conflict hunk,
keep upstream's side, then rerun the script. Do not check out a whole workflow file from either
side: that drops either upstream's changes or the fork's bun edits elsewhere in the file.

The script fails when a label names an OS it has no runner for, or when upstream changed how
the budget check reads its base. Add the runner to `hostedRunners`, or make the check read the
PR's base branch again.

In `ci.yml`, the two background installs of the browser secret helper libraries call
`.github/scripts/fork-apt-install.sh` under a `# fork-apt:` comment, where upstream calls
`apt-get` directly. On the hosted runners `setup-apt-mirrors` changes nothing, because their
sources already read a mirror list that names only `ubuntu.com` hosts, so one stalled zone
stopped every job at the 10-minute wait without a log. The script limits each `apt-get` call and
retries a failed update or install on a mirror outside that zone. After each merge,
`git grep -c 'fork-apt:' .github/workflows/ci.yml` must print `.github/workflows/ci.yml:2`; when
upstream edits those lines, keep its package list and pass it to the script.

In `scripts/check-changed.ts`, `comparisonBase` also tries each remote's `fork` branch, where
upstream tries only each remote's `main`. With no ref, `vp run check:changed` compares against
the candidate whose merge base has the fewest commits before `HEAD`. A branch from `fork` so
compares against `origin/fork` and checks only its own changes, not the whole fork diff. A branch
from a `main` still compares against that main, and a tie reports the main. A sync branch holds
both histories, so pass `upstream/main` there as [Sync with upstream](#sync-with-upstream) says.
After each merge, `git grep -c '"fork"' scripts/check-changed.ts` must print
`scripts/check-changed.ts:1`; when upstream edits those lines, keep its change and add the `fork`
candidates again.

### Other conflicts

Resolve a conflict in another fork patch by keeping upstream's behavior and redoing the patch on
top. When that needs a design choice, the sync [fails](#when-the-sync-fails).

For [Antigravity native keyring auth](#antigravity-native-keyring-auth--cli-usage-limits), after
each merge,
`git grep -n 'antigravity-oauth-token\|AGY_ACP_FORCE_FILE_STORAGE\|SSH_CONNECTION' -- apps/server/src/provider ':!*test*'`
must match only the stripping sets and comment in `antigravityAuthSupport.ts` and
`antigravityCliUsageLimits.ts` (also enforced in CI by `antigravityAuthSupport.test.ts`).

### When the sync fails

Only `gh pr merge` changes `fork`, so a sync that stops earlier leaves `fork` as it was. Nothing
is half-merged: the work stays on the sync branch or its PR. Do not merge, and do not deliver a
build.

- **A conflict the agent cannot resolve.** Run `git merge --abort`. File a task on the `t3code`
  board that names the fork patch, its files and the upstream commit it conflicts with.
- **A check the agent cannot fix.** Leave the PR open and unmerged. File a board task that names
  the PR, the check and its error.

The next sync starts again from `origin/fork`. Close the older sync PR once a newer one merges.

### Deliver the build

After the sync PR merges, update the installed app on both Macs with
[`scripts/fork-app-update.sh`](#update-the-fork-app). The update quits the app, which ends every
running thread on that Mac, the sync's own thread on the Air included.

1. On the Air, check out the merged `origin/fork` and build the app as in
   [Desktop app](#desktop-app). On macOS, a `-fork.` build automatically signs the `.app` with the
   Air's [`T3 Code Fork` identity](#signing-identity) (`scripts/fork-app-sign.sh`) before writing
   `~/.t3-fork/build/mac-arm64/` and fails loudly when that identity is missing.
2. Update the Pro first. It has no checkout and needs no signing identity of its own, so copy the
   already-signed build and the update script:

   ```sh
   rsync -a --delete ~/.t3-fork/build/mac-arm64/ roy-macbook-pro:.t3-fork/build/mac-arm64/
   rsync -a scripts/fork-app-update.sh roy-macbook-pro:.t3-fork/
   ssh roy-macbook-pro '~/.t3-fork/fork-app-update.sh --dry-run && ~/.t3-fork/fork-app-update.sh --detach'
   ```

   `scripts/fork-app-update.sh` verifies the signature on either Mac and refuses unsigned or
   ad-hoc builds before stopping the running app. About three minutes later,
   `ssh roy-macbook-pro 'tail -3 ~/.t3-fork/update.log'` must end with `finished` and the new
   version. When the Pro is asleep or the update fails there, file a board task and continue with
   the Air.

3. Finish everything else: the board task, the report and the final reply.
4. Update the Air last, as the last command of the turn: `scripts/fork-app-update.sh --detach`.

## Antigravity native keyring auth & CLI usage limits

The fork lets the official first-party `agy` CLI use its native OS keyring authentication without
spoofing `SSH_CONNECTION`, setting `AGY_ACP_FORCE_FILE_STORAGE=1`, or cloning plaintext
`antigravity-oauth-token` files into temporary profile directories. `GEMINI_HOME` remains isolated
per T3 profile for sessions, brain artifacts, hooks, MCP config, and skills, and isolated helper
profiles (`text-profile-*`) skip user hooks/MCP/rules links without copying credentials. This
invariant is checked in CI by `antigravityAuthSupport.test.ts` and as a post-merge grep check under
[Other conflicts](#other-conflicts).

Upstream removed direct HTTP calls to Google's internal Antigravity quota APIs (`#43026`). The
fork keeps **Usage → Limits** working for Antigravity via the official first-party CLI's
`-p /usage --output-format json --print-timeout 15s` command in the fork-only module
[antigravityCliUsageLimits.ts](../../apps/server/src/provider/antigravityCliUsageLimits.ts),
attached in [AntigravityDriver.ts](../../apps/server/src/provider/Drivers/AntigravityDriver.ts)
without modifying `AntigravityProvider.ts`. It runs with the user's real `HOME` and native OS
keyring (stripping `SSH_*`, `GEMINI_HOME`, `AGY_ACP_FORCE_FILE_STORAGE`, `DISPLAY`/`WAYLAND_DISPLAY`,
and ambient API-key variables, with `AGENT_BOARD_HOOKS=off`) under a 5-minute shared cache (never on
the 1-minute health check) and automatically yields if upstream later re-adds native `usageLimits`
to `AntigravityProvider`. If upstream does, remove the wrapper call in `AntigravityDriver.ts` and
delete `antigravityCliUsageLimits.ts` and its test.

## State retention

The fork adds two rules to the 6-hourly history compaction in
[ProjectionMaintenance](../../apps/server/src/orchestration-v2/ProjectionMaintenance.ts). `t3 doctor`
runs the same pass. They stop older history from growing; they do not make the file much smaller.

| Table                                    | Readers                                               | Fork rule                                              |
| ---------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------ |
| `orchestration_events`                   | reconnect replay, command-id retries, prompt anchors  | drop superseded `turn-item.updated` and `node.updated` |
| `orchestration_v2_projection_turn_items` | thread views, `getTurnItem`, thread find, MCP context | trim items of threads settled for 7 days               |
| `orchestration_v2_projection_nodes`      | thread views, recovery                                | none                                                   |

- **Superseded updates.** Both event types carry the whole entity, so a newer one replaces an
  older one. Each entity keeps its first update, because clients append an entity where they
  first see it. It also keeps its newest update and any prompt anchor that a later row borrows.
  Updates written by a command stay, so a retry of that command still replays them. The pass
  drops only rows older than the previous pass's mark, which is at least an hour old.
  Provider-turn updates stay, because later ones inherit `tokenUsage` (upstream PR #22548
  handles them).
- **Settled threads.** For a settled thread unchanged for 7 days, each finished command or tool
  text output longer than 17,408 characters keeps its first and last 8,192 characters, with a
  note saying how much was removed. Structured tool output, such as images, stays. Reasoning text
  becomes empty and shows as a "Thinking" row. Messages, diffs and checkpoints stay. Removed
  output cannot be recovered.
- **Antigravity ACP session files.** The fork also runs
  [AntigravitySessionRetention](../../apps/server/src/provider/acp/AntigravitySessionRetention.ts)
  alongside the 6-hourly compaction pass, in `t3 doctor`, and immediately on `thread.deleted`
  (`thread-content.purge`):
  - **Deleted threads:** once no live session or open file handle remains, resolves linked
    `invoke_subagent` / swarm child UUIDs (from `brain/<root>/.system_generated/subagents/`,
    `brain/<root>/.system_generated/swarm/members.json`, and `conversations/<root>.db`), archives
    their usage records into the persistent usage scan cache, and removes
    `conversations/<id>.db*`, `brain/<id>/`, and `annotations/<id>.pbtxt` for both children and
    parent.
  - **Settled threads:** after **24 hours** for automated (`mcp:`, `subagent:`, `delegated-task:`)
    threads and **7 days** for interactive threads, cascades full removal to child subagent
    sessions and prunes the parent's `conversations/<id>.db*`, `annotations/<id>.pbtxt`,
    `brain/<id>/.system_generated/`, and `brain/<id>/scratch/`. User-facing artifacts directly
    under `brain/<id>/` stay until thread deletion. Reopening a pruned settled thread cleanly
    starts a fresh Antigravity session using T3's portable context handoff.
  - **Orphan sessions:** native session files unreferenced by `statev2.sqlite` or any protected
    parent session are swept once older than **24 hours** and not held open by any process.
  - **Safety guards:** active/unsettled threads, live in-process sessions, files with open OS
    handles (`lsof`), and `.db` files whose usage records fail to scan or persist to the usage
    cache are never removed.

Related upstream work: issue #28903 (retention for events and turn items), PR #29806 (one-day
event window) and PR #22548 (provider-turn updates).

## Package manager

`fork` uses bun 1.4 (`packageManager` in `package.json`). `bun install` reads the workspaces,
catalog, overrides, patches and package extensions from `package.json`, and `bunfig.toml` holds the
install settings. pnpm features with no direct bun equivalent:

| pnpm setting                                     | On `fork`                                                              |
| ------------------------------------------------ | ---------------------------------------------------------------------- |
| `allowBuilds`                                    | `trustedDependencies`: only the `true` entries may run install scripts |
| `"-"` overrides (drop a dependency)              | Dropped; the next re-resolve of their parents installs them            |
| `catalog:` in `packageExtensions`                | Replaced with the catalog version                                      |
| `patchedDependencies` on a `file:` tarball       | Keyed by the tarball path, as bun requires                             |
| `publicHoistPattern`, `minimumReleaseAgeExclude` | In `bunfig.toml`; bun exempts every version of an excluded package     |
| `.pnpmfile.cjs` (WSL architectures on Windows)   | Dropped; on Windows with WSL, pass bun's `--os` and `--cpu` flags      |
| `strictPeerDependencies`, `peerDependencyRules`  | Dropped; bun does not fail on unmet peers                              |
| `permissions` (skills that dependencies ship)    | Dropped; bun does not link them                                        |

Still on upstream's tooling, so not usable where pnpm and Vite+ are not installed:

- Vite+ (`vp`) still runs lint, format, tests, builds, the dev runner and CI. Only install and
  `typecheck:bun` run without it. `fork-convert-to-bun.ts` deletes upstream's `prepare` script
  (`vp config --no-agent`), so no install sets up the git hooks. Run `vp config --no-agent`
  once in the main checkout; worktrees share its `core.hooksPath`.
- Tests, knip and the dev runner need Node, not bun's runtime. Bun has no `node:sea`, which the
  server imports, and it treats `undici` as built in, so knip reports `undici` unused. Where
  `BUN_OPTIONS=--bun` is set, `bun run` swaps Node for bun; use `vp run <script>` or
  `BUN_OPTIONS= bun run <script>`.
- `scripts/build-cli-archive.ts` and `scripts/release-smoke.ts` still stage installs for pnpm,
  so the CLI archive and release smoke test do not work yet. The desktop build below stages
  with bun.
- The dev container and `apps/mobile/deps/README.md` still name pnpm.

## Prerequisites

- Bun 1.4 or newer.
- Node 26.13.1 (`engines.node`), which runs the app. With fnm: `fnm install 26.13.1`, then prefix each command
  below with `fnm exec --using=26.13.1`.
- `vp` for the build, run and desktop steps below, installed as the
  [root README](../../README.md#install-vp) says.

## Build

From the repository root of a clean clone:

```sh
bun install
vp run --filter @t3tools/web build
vp run --filter t3 build:bundle
```

The server bundle lands in `apps/server/dist` and serves the web build from `apps/web/dist`.

## Copy the state database

Never point a fork server at `~/.t3`. Copy the live data into `~/.t3-fork` instead:

```sh
vp run migrate-dev-db --base-dir ~/.t3-fork
```

It reads `~/.t3/userdata/statev2.sqlite` read-only and writes a pruned copy (5 recent projects,
10 stopped threads each, no scheduled tasks or pending work). Raise `--projects` and
`--threads-per-project` for more data. Stop the fork server first; the command rewrites the copy.

For work that needs the whole database, such as measuring its size, take a full read-only
copy into a separate directory instead. `.backup` restarts on every write by the running app
and may never finish; `VACUUM INTO` copies one consistent snapshot (about 2 minutes for 4.4 GB):

```sh
mkdir -p ~/.t3-fork-full/userdata
sqlite3 "file:$HOME/.t3/userdata/statev2.sqlite?mode=ro" "VACUUM INTO '$HOME/.t3-fork-full/userdata/statev2.sqlite'"
```

## Run

```sh
cd apps/server
vp run start serve --base-dir ~/.t3-fork --port 3799
```

It prints a pairing URL for `http://localhost:3799`. Open it in a browser that is not paired
with the installed app. Stop the server with Ctrl+C.

## Desktop app

```sh
cp .env.example .env
T3CODE_DESKTOP_VERSION=0.1.8-fork.$(date +%Y%m%d) \
  vp run dist:desktop:artifact --platform mac --target dir --arch arm64 --output-dir ~/.t3-fork/build
```

`.env` carries the public T3 Connect config that official builds bake in. Without it, the app
never loads a T3 Connect sign-in and every relay environment shows "still loading its T3 Connect
sign-in". A fork version refuses to build without it.

On macOS, a `-fork.` build checks for the local `T3 Code Fork` signing identity up front and runs
`scripts/fork-app-sign.sh` on the packaged `.app` before writing
`~/.t3-fork/build/mac-arm64/T3 Code (Beta).app` (about a minute total). The build fails loudly
when the identity is missing. Do not open the built app from Finder while Nightly runs. To try it
beside Nightly, give it its own home folder, so it uses its own Electron data folder,
single-instance lock and state. That home has no provider logins, so it suits a launch check, not
agent turns:

```sh
mkdir -p /tmp/t3-fork-home
HOME=/tmp/t3-fork-home T3CODE_HOME=/tmp/t3-fork-home/.t3 T3CODE_PORT=3799 \
  ~/.t3-fork/build/mac-arm64/T3\ Code\ \(Beta\).app/Contents/MacOS/T3\ Code\ \(Beta\) &
fork_pid=$!
```

Quit it with `kill $fork_pid`. Afterwards, run
`/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -u ~/.t3-fork/build/mac-arm64/T3\ Code\ \(Beta\).app`
so `t3code://` links keep opening Nightly.

`T3CODE_DESKTOP_VERSION` is `<core>-fork.<YYYYMMDD>`, where `<core>` is the core of the newest
upstream nightly tag (`git tag -l 'v*-nightly*' --sort=-creatordate | head -1`). Clients compare
only the core with their own, so a matching core shows no version-mismatch banner, and the build
reads as Stable. Without the variable the build takes `apps/desktop/package.json` (an older core),
and clients show the banner. Avoid:

- an older core, such as `0.1.7-fork.*`, which also sorts below `0.1.7`, so mobile offers `0.1.7`
  as an update;
- `-nightly.`, `-preview.` and `-pr.` suffixes, which rename the app and pose as an official
  channel build.

Apart from its version, it has the same identity as Nightly:

|               | Fork build                                | Nightly                          |
| ------------- | ----------------------------------------- | -------------------------------- |
| Name          | T3 Code (Beta), 0.1.8-fork.YYYYMMDD       | T3 Code (Nightly), 0.1.8-nightly |
| Bundle id     | `com.t3tools.t3code`                      | `com.t3tools.t3code`             |
| Signature     | Self-signed (`T3 Code Fork`, Air only)    | Developer ID, team ARK85ZXQ4Z    |
| URL schemes   | `t3code`, `t3code-dev`, `http`, `https`   | same                             |
| Update feed   | none (no `app-update.yml`)                | T3's nightly channel             |
| State         | `~/.t3` unless `T3CODE_HOME` is set       | `~/.t3`                          |
| Electron data | `~/Library/Application Support/t3code-v2` | same                             |

The single-instance lock lives in the Electron data folder, so a second app with this identity
quits or hands off to the one already running.

### Signing identity

macOS keys Accessibility and Screen Recording grants (TCC) to an app's designated requirement.
Ad-hoc builds pin a per-build `cdhash`, so every rebuild drops those grants. Signing fork builds
with one stable self-signed identity produces a designated requirement of
`identifier "com.t3tools.t3code" and certificate leaf = H"<sha1>"`, which stays identical across
rebuilds on both Macs.

- **Single build host:** The signing identity (`T3 Code Fork`, overridable via
  `T3CODE_FORK_SIGNING_IDENTITY`) lives only in the Air's login keychain
  (`~/Library/Keychains/login.keychain-db`). Keep the private key on the Air only: never commit
  it, and never copy it to CI, the Pro, or shared storage.
- **Pro needs no identity:** The Air signs the `.app` before the `rsync` in
  [Deliver the build](#deliver-the-build). The embedded certificate satisfies
  `codesign --verify --deep --strict` and TCC on the Pro with no keychain setup there.
- **Create or recreate the identity on the Air (one time):**

  ```sh
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  cat >"$tmp/ext.cnf" <<'EOF'
  [req]
  distinguished_name = dn
  x509_extensions = codesign
  prompt = no
  [dn]
  CN = T3 Code Fork
  [codesign]
  keyUsage = critical, digitalSignature
  extendedKeyUsage = critical, codeSigning
  basicConstraints = critical, CA:FALSE
  EOF
  /usr/bin/openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
    -keyout "$tmp/key.pem" -out "$tmp/cert.pem" -config "$tmp/ext.cnf"
  /usr/bin/openssl pkcs12 -export -name "T3 Code Fork" -inkey "$tmp/key.pem" -in "$tmp/cert.pem" \
    -out "$tmp/id.p12" -passout pass:temp-import
  security import "$tmp/id.p12" -k ~/Library/Keychains/login.keychain-db \
    -P temp-import -T /usr/bin/codesign
  # Allow unattended signing by /usr/bin/codesign with no GUI prompt (prompts for the Air login keychain password once).
  security set-key-partition-list -S apple-tool:,apple:,codesign: -s -l "T3 Code Fork" \
    ~/Library/Keychains/login.keychain-db
  scripts/fork-app-sign.sh --check-identity
  ```

  Recreating the identity creates a new certificate fingerprint, so you must re-grant the one-time
  macOS permissions below once per Mac after installing a build signed by the new identity. Remove
  any old `T3 Code Fork` identity from the login keychain first so `scripts/fork-app-sign.sh` does
  not refuse an ambiguous match.

- **Verify a signed build or installed app:**

  ```sh
  codesign --verify --deep --strict "/Applications/T3 Code (Beta).app"
  codesign -dvvv "/Applications/T3 Code (Beta).app"
  codesign -d -r- "/Applications/T3 Code (Beta).app"
  ```

  Expect `Authority=T3 Code Fork` (not `Signature=adhoc`), `Identifier=com.t3tools.t3code`,
  `Info.plist entries=...`, `Sealed Resources version=...`, and
  `designated => identifier "com.t3tools.t3code" and certificate leaf = H"..."`.

### One-time macOS privacy grants

After installing the first build signed with `T3 Code Fork` (or after recreating the identity),
grant permissions once on each Mac (Air and Pro):

1. Open **System Settings > Privacy & Security > Accessibility** and **Screen Recording**.
2. **Remove any stale `T3 Code` (`com.t3tools.t3code`) entry left by Nightly or an ad-hoc build**
   (select it and click `-`, or run `tccutil reset Accessibility com.t3tools.t3code` and
   `tccutil reset ScreenCapture com.t3tools.t3code`). Keeping a Nightly entry leaves macOS
   checking the old Developer ID requirement even when the toggle looks enabled.
3. Add `/Applications/T3 Code (Beta).app` to both **Accessibility** and **Screen Recording**,
   toggle both on, and quit and reopen the app.
4. From a T3 Code terminal session on that Mac, verify that the desktop helper sees both grants:

   ```sh
   state="${DESKTOP_MCP_STATE:-${XDG_STATE_HOME:-$HOME/.local/state}/desktop-mcp}"
   "$(ls -t "$state"/desktop-helper-* | grep -v '\.tmp$' | head -1)" permissions
   ```

   Both `accessibility` and `screenRecording` must print `true` and remain `true` across future
   fork updates with no new grant.

There are two ways to use a fork build daily:

- **Replace Nightly.** Keep the same `~/.t3` state and update by syncing `fork`, rebuilding and
  replacing the app. See [Switch to the fork build](#switch-to-the-fork-build) and
  [Update the fork app](#update-the-fork-app).
- **Run beside Nightly.** This needs fork patches to the bundle id (`DESKTOP_APP_ID` in
  `scripts/build-desktop-artifact.ts`), the Electron data folder (`DesktopUserData.ts`), the URL
  schemes and the default state folder (`DesktopStatePaths.ts`). Updates are rebuilds as above.
  Rollback is deleting the fork app and its state folder.

## Switch to the fork build

`scripts/fork-app-swap.sh` replaces Nightly with a fork build, and `scripts/fork-app-rollback.sh`
undoes it. Quitting Nightly ends every running agent thread, so only run them by hand, never from
an agent inside Nightly.

1. Build the app as in [Desktop app](#desktop-app).
2. Run `scripts/fork-app-swap.sh --dry-run`. It runs while Nightly is open and lists what the swap
   would do or refuse.
3. Quit Nightly (T3 Code > Quit).
4. Run `scripts/fork-app-swap.sh`. It refuses while Nightly runs or anything holds
   `statev2.sqlite` open. It backs up `statev2.sqlite` with `VACUUM INTO` to
   `~/.t3-swap-backup/<time>/`, moves Nightly there, and copies the fork app into `/Applications`.
5. Open `/Applications/T3 Code (Beta).app`. Switching from Nightly's Developer ID signature to
   the fork signing identity requires the one-time
   [macOS privacy grants](#one-time-macos-privacy-grants) and keychain approval once per Mac;
   subsequent fork updates signed with the same identity keep those grants.

To update an installed fork app, see [Update the fork app](#update-the-fork-app).

To roll back:

1. Quit the fork app.
2. Run `scripts/fork-app-rollback.sh --dry-run`, then `scripts/fork-app-rollback.sh`. It moves the
   fork app into the backup folder and moves Nightly back.
3. Open Nightly. Its updater brings it up to date.

The rollback restores the database backup only when the fork ran newer migrations than the backup
holds. Nightly starts on a newer database but does not know its schema. It keeps the fork's database
beside the backup as `statev2.fork.sqlite`. Otherwise it keeps the current database, with the work
done on the fork. Pass `--restore-db` to restore the backup anyway. Pass a backup folder when `latest` does not
point at the swap to undo. If the fork app fails to start, its recovery page offers to download its own
version from upstream releases. No such release exists, so roll back instead.

## Update the fork app

`scripts/fork-app-update.sh` replaces the installed fork app with a newer fork build. An agent
inside the app may run it, because the script does its work after the app has quit.

1. Build the app as in [Desktop app](#desktop-app) (on macOS this signs the `.app` with the
   `T3 Code Fork` identity before writing `~/.t3-fork/build/mac-arm64/`).
2. Run `scripts/fork-app-update.sh --dry-run`. It runs while the app is open, verifies the new
   build's signature (refusing unsigned or ad-hoc builds) and lists the steps without changing
   anything.
3. Run `scripts/fork-app-update.sh --detach`. It returns at once and logs to
   `~/.t3-fork/update.log`.

The quit ends every running thread on that Mac, also threads of other agents, and they do not
continue on their own. Send a message to a thread afterwards to resume it. `--detach` runs the
update in a new session; without it, the update stops with the agent that started it.

The detached run waits 75 seconds, so the agent's last reply is saved, then asks the app to quit.
When the app still runs after 90 seconds, it sends SIGTERM to the app's main process only: the
process under `Contents/MacOS` that launchd owns, or the pid passed as an argument. Once the app
and `statev2.sqlite` are free, it backs up the database with `VACUUM INTO` (verifying
`PRAGMA quick_check = ok`) and moves the old app to `~/.t3-swap-backup/<time>-update/`, copies the
new build into `/Applications` and opens it. When a step fails, it reopens the old app and the log
says which step.

- **Live database defragmentation.** Because `VACUUM INTO` already produces a verified compacted
  snapshot while the app is stopped, the update reuses it to replace the live `statev2.sqlite`
  whenever reclaiming intra-page B-tree slack saves at least **10%** (`T3_UPDATE_DEFRAG_MIN_PCT`)
  and **64 MiB** (`T3_UPDATE_DEFRAG_MIN_MIB`). It clones the verified snapshot into place (clearing
  the old `-wal`/`-shm` together and checking `PRAGMA quick_check = ok` before unlinking the old
  file) while keeping the pre-swap backup in `~/.t3-swap-backup/<time>-update/statev2.sqlite`. Pass
  `--no-defrag` (or `T3_UPDATE_DEFRAG=0`) to skip replacing the live database.
- **Backup retention.** After the new app opens, the script prunes older
  `<YYYYMMDD>-<HHMMSS>-update` backup folders directly under `~/.t3-swap-backup/`, keeping the
  newest **`T3_UPDATE_KEEP=1`** by default (counting the folder created by the current run). Set
  `T3_UPDATE_KEEP=<N>` (`N >= 1`) to keep more. Pruning orders strictly by folder name (never
  modification time), never follows symlinks, never touches `latest`, its target, or non-`-update`
  folders (such as the initial Nightly swap), and skips pruning if the update fails. `--dry-run`
  lists the folders that would be pruned without changing anything.
- **Staged build cleanup.** After `ditto` and launching the new app succeed, the script removes
  the staged build directory (`~/.t3-fork/build` for default builds). Pass `--keep-build` to
  preserve it (for example when building once and inspecting the bundle).

To go back to the previous build, quit the app and move the old app from that backup folder to
`/Applications`. Restore the database backup only when the newer build ran migrations the older
one does not know. Verify an installed or copied fork build with
`codesign --verify --deep --strict "/Applications/T3 Code (Beta).app"` (or
`scripts/fork-app-sign.sh --verify "/Applications/T3 Code (Beta).app"`).
