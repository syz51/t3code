# Running the fork beside T3 Code

This fork (`syz51/t3code`) is tested next to the installed T3 Code app. The installed app owns
`~/.t3` and port 3773. Fork runs use `~/.t3-fork` and port 3799, so they never touch either.

## Branches

- `main` mirrors `upstream/main` (`pingdotgg/t3code`). It never carries fork commits, so it
  only fast-forwards.
- `fork` is `upstream/main` plus the fork's patches. Keep them few and small, and keep
  fork-only material in fork-only files such as this one, so rebases stay clean.
- `fork` installs with bun instead of upstream's pnpm. See [Package manager](#package-manager).
- Patch work branches start from `fork`. A patch meant for upstream starts from `main` instead,
  and lands on `fork` once upstream merges it, or as a cherry-pick until then.

## Sync with upstream

```sh
git fetch upstream main
git push origin upstream/main:main
git switch fork
git rebase upstream/main
bun install --frozen-lockfile
bun run typecheck:bun
git push --force-with-lease=fork:<old fork sha> origin fork
```

`typecheck:bun` typechecks every package without Vite+. It is the only check here: the fork's CI
does not run, and lint, format, knip and tests still need Vite+ (see
[Package manager](#package-manager)). Where Vite+ is installed, also run
`vp run check:changed upstream/main` before pushing.

The bun conversion is four commits, from "build: switch the fork's package manager from pnpm to
bun" to "docs(fork): sync upstream with bun …". They edit upstream files, so they conflict
whenever upstream changes those files.

The first commit conflicts whenever upstream changes `package.json`, `pnpm-lock.yaml` or
`pnpm-workspace.yaml`. Never merge `bun.lock`, `bunfig.toml` or the converted `package.json` by
hand. Regenerate them from upstream's files:

```sh
git checkout upstream/main -- package.json pnpm-lock.yaml pnpm-workspace.yaml .pnpmfile.cjs
bun scripts/fork-convert-to-bun.ts
git add -A package.json bun.lock bunfig.toml pnpm-lock.yaml pnpm-workspace.yaml .pnpmfile.cjs
git rebase --continue
```

The script migrates upstream's lockfile and workspace into `package.json` and `bun.lock`,
writes `bunfig.toml`, formats `package.json` as `vp fmt` does, and deletes the pnpm files. It
fails when bun still warns, for example about a patch that no longer applies to a new version.
Fix that in `package.json` and run `bun install`.

The other three commits conflict when upstream edits a workflow, script or doc they change. Keep
upstream's change and redo the commit's edit in it: `bun install` for pnpm installs, `bun.lock`
for `pnpm-lock.yaml`, and `package.json` for `pnpm-workspace.yaml`. `apps/mobile/eas.json` pins
the same bun version as `packageManager`; update both together.

When the rebase conflicts in any other patch, run `git rebase --abort` and leave `fork` as it was. File a board task
that names the conflicting patch, its files and the upstream commit it conflicts with. When a
check fails, file a task with the failing check and its output, and do not push.

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
  `typecheck:bun` run without it. `bun install` skips upstream's `prepare` script, which
  calls Vite+, so it does not install the git hooks.
- The release scripts (`scripts/build-desktop-artifact.ts`, `scripts/build-cli-archive.ts`,
  `scripts/release-smoke.ts`) still read `pnpm-workspace.yaml` and stage installs for pnpm, so
  the desktop and CLI builds below do not work yet.
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
T3CODE_DESKTOP_VERSION=0.1.8-fork.$(date +%Y%m%d) \
  vp run dist:desktop:artifact --platform mac --target dir --arch arm64 --output-dir ~/.t3-fork/build
```

It builds an unsigned (ad-hoc signed) app at `~/.t3-fork/build/mac-arm64/T3 Code (Beta).app` in
about a minute. Do not open it while Nightly runs.

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

- **Replace Nightly.** Quit Nightly and copy the fork app into `/Applications`. It keeps the
  same `~/.t3` state. Nightly updates stop, so update by syncing `fork`, rebuilding and copying
  the app again. The new signature makes macOS ask again for privacy permissions and keychain
  access. Keep the Nightly app (move it out of `/Applications`) and roll back by quitting the
  fork app and moving Nightly back. If the fork app fails to start, its recovery page offers to
  download its own version from upstream releases; no such release exists, so use the kept
  Nightly instead. A fork build that ran newer migrations can leave `~/.t3` ahead of Nightly, so
  copy `statev2.sqlite` with the `VACUUM INTO` command above before switching.
- **Run beside Nightly.** This needs fork patches to the bundle id (`DESKTOP_APP_ID` in
  `scripts/build-desktop-artifact.ts`), the Electron data folder (`DesktopUserData.ts`), the URL
  schemes and the default state folder (`DesktopStatePaths.ts`). Updates are rebuilds as above.
  Rollback is deleting the fork app and its state folder.
