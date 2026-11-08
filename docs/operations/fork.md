# Running the fork beside T3 Code

This fork (`syz51/t3code`) is tested next to the installed T3 Code app. The installed app owns
`~/.t3` and port 3773. Fork runs use `~/.t3-fork` and port 3799, so they never touch either.

## Branches

- `main` mirrors `upstream/main` (`pingdotgg/t3code`). It never carries fork commits, so it
  only fast-forwards.
- `fork` is `upstream/main` plus the fork's patches. Keep them few and small, and keep
  fork-only material in fork-only files such as this one, so rebases stay clean.
- Patch work branches start from `fork`. A patch meant for upstream starts from `main` instead,
  and lands on `fork` once upstream merges it, or as a cherry-pick until then.

## Sync with upstream

```sh
git fetch upstream main
git push origin upstream/main:main
git switch fork
git rebase upstream/main
vp i
vp run check:changed upstream/main
git push --force-with-lease=fork:<old fork sha> origin fork
```

When the rebase conflicts, run `git rebase --abort` and leave `fork` as it was. File a board task
that names the conflicting patch, its files and the upstream commit it conflicts with. When a
check fails, file a task with the failing check and its output, and do not push.

## Prerequisites

- `vp`, installed as the [root README](../../README.md#install-vp) says. With
  `VP_NODE_MANAGER=no`, `vp` uses the `node` on `PATH`.
- Node 26.12.1 (`engines.node`). With fnm: `fnm install 26.12.1`, then prefix each command
  below with `fnm exec --using=26.12.1`.

## Build

From the repository root of a clean clone:

```sh
vp i
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
vp run dist:desktop:artifact --platform mac --target dir --arch arm64 --output-dir ~/.t3-fork/build
```

It builds an unsigned (ad-hoc signed) app at `~/.t3-fork/build/mac-arm64/T3 Code (Beta).app` in
about a minute. Do not open it while Nightly runs. As built, it has the same identity as Nightly:

|               | Fork build                                | Nightly                          |
| ------------- | ----------------------------------------- | -------------------------------- |
| Name          | T3 Code (Beta), 0.1.7                     | T3 Code (Nightly), 0.1.8-nightly |
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
  access. To roll back, quit the fork app and reinstall Nightly from T3's download page. A fork
  build that ran newer migrations can leave `~/.t3` ahead of Nightly, so copy
  `statev2.sqlite` with the `VACUUM INTO` command above before switching.
- **Run beside Nightly.** This needs fork patches to the bundle id (`DESKTOP_APP_ID` in
  `scripts/build-desktop-artifact.ts`), the Electron data folder (`DesktopUserData.ts`), the URL
  schemes and the default state folder (`DesktopStatePaths.ts`). Updates are rebuilds as above.
  Rollback is deleting the fork app and its state folder.
