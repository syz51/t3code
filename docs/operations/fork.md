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

## Sync with upstream

A sync merges `upstream/main` into a branch from `fork` and lands it through a PR, so CI runs
before `fork` changes. `fork` is never rebased or force-pushed. The T3 scheduled task "Weekly fork
upstream sync" starts one every Monday at 10:00 in a new thread on the Air, and that agent follows
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
own instruction edits make its budget differ from upstream's, so compare growth, not values. Run
`git diff <old> upstream/main -- apps/server/src/provider/agentContextBudget.json`, where `<old>`
is `git merge-base origin/fork upstream/main` taken before the merge. When no number grew more on
the branch than in that diff, the growth is upstream's: add the `agent-context-increase` label to
the PR.

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
script also makes Agent Context Budget compare with the PR's base branch, because `fork` lags
`main` until the sync.

A `runs-on` or `timeout-minutes` line conflicts when upstream edits it. In each conflict hunk,
keep upstream's side, then rerun the script. Do not check out a whole workflow file from either
side: that drops either upstream's changes or the fork's bun edits elsewhere in the file.

The script fails when a label names an OS it has no runner for, or when upstream changed the
budget fetch. Add the runner to `hostedRunners` or redo the edit by hand.

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
   [Desktop app](#desktop-app).
2. Update the Pro first. It has no checkout, so copy the build and the script:

   ```sh
   rsync -a --delete ~/.t3-fork/build/mac-arm64/ roy-macbook-pro:.t3-fork/build/mac-arm64/
   rsync -a scripts/fork-app-update.sh roy-macbook-pro:.t3-fork/
   ssh roy-macbook-pro '~/.t3-fork/fork-app-update.sh --dry-run && ~/.t3-fork/fork-app-update.sh --detach'
   ```

   About three minutes later, `ssh roy-macbook-pro 'tail -3 ~/.t3-fork/update.log'` must end with
   `finished` and the new version. When the Pro is asleep or the update fails there, file a board
   task and continue with the Air.

3. Finish everything else: the board task, the report and the final reply.
4. Update the Air last, as the last command of the turn: `scripts/fork-app-update.sh --detach`.

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
- Node 26.12.1 (`engines.node`), which runs the app. With fnm: `fnm install 26.12.1`, then prefix each command
  below with `fnm exec --using=26.12.1`.
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

It builds an unsigned (ad-hoc signed) app at `~/.t3-fork/build/mac-arm64/T3 Code (Beta).app` in
about a minute. Do not open it from Finder while Nightly runs. To try it beside Nightly, give it
its own home folder, so it uses its own Electron data folder, single-instance lock and state.
That home has no provider logins, so it suits a launch check, not agent turns:

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
| Signature     | ad-hoc                                    | Developer ID, team ARK85ZXQ4Z    |
| URL schemes   | `t3code`, `t3code-dev`, `http`, `https`   | same                             |
| Update feed   | none (no `app-update.yml`)                | T3's nightly channel             |
| State         | `~/.t3` unless `T3CODE_HOME` is set       | `~/.t3`                          |
| Electron data | `~/Library/Application Support/t3code-v2` | same                             |

The single-instance lock lives in the Electron data folder, so a second app with this identity
quits or hands off to the one already running.

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
5. Open `/Applications/T3 Code (Beta).app`. The new signature makes macOS ask again for privacy
   permissions and keychain access.

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

1. Build the app as in [Desktop app](#desktop-app).
2. Run `scripts/fork-app-update.sh --dry-run`. It runs while the app is open, checks the build and
   lists the steps without changing anything.
3. Run `scripts/fork-app-update.sh --detach`. It returns at once and logs to
   `~/.t3-fork/update.log`.

The quit ends every running thread on that Mac, also threads of other agents, and they do not
continue on their own. Send a message to a thread afterwards to resume it. `--detach` runs the
update in a new session; without it, the update stops with the agent that started it.

The detached run waits 75 seconds, so the agent's last reply is saved, then asks the app to quit.
When the app still runs after 90 seconds, it sends SIGTERM to the app's main process only: the
process under `Contents/MacOS` that launchd owns, or the pid passed as an argument. Once the app
and `statev2.sqlite` are free, it backs up the database with `VACUUM INTO` and moves the old app
to `~/.t3-swap-backup/<time>-update/`, copies the new build into `/Applications` and opens it.
When a step fails, it reopens the old app and the log says which step.

To go back to the previous build, quit the app and move the old app from that backup folder to
`/Applications`. Restore the database backup only when the newer build ran migrations the older
one does not know. Ad-hoc signed builds fail `codesign --verify --deep` ("code has no
resources"), so that command does not check a copy.
