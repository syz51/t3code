# Running the fork beside T3 Code

This fork (`syz51/t3code`) is tested next to the installed T3 Code app. The installed app owns
`~/.t3` and port 3773. Fork runs use `~/.t3-fork` and port 3799, so they never touch either.

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
backup into a separate directory instead:

```sh
mkdir -p ~/.t3-fork-full/userdata
sqlite3 -readonly ~/.t3/userdata/statev2.sqlite ".backup '$HOME/.t3-fork-full/userdata/statev2.sqlite'"
```

## Run

```sh
cd apps/server
vp run start serve --base-dir ~/.t3-fork --port 3799
```

It prints a pairing URL for `http://localhost:3799`. Open it in a browser that is not paired
with the installed app. Stop the server with Ctrl+C.
