// @effect-diagnostics nodeBuiltinImport:off - Drives the real shell update script against a local SQLite fixture.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as HostProcess from "@t3tools/shared/HostProcess";
import { assert, describe, it } from "vite-plus/test";

const repoRoot = NodePath.resolve(import.meta.dirname, "..");
const updateScript = NodePath.join(repoRoot, "scripts", "fork-app-update.sh");
const rollbackScript = NodePath.join(repoRoot, "scripts", "fork-app-rollback.sh");

const makeFakeApp = (dir: string, version: string) => {
  const contents = NodePath.join(dir, "Contents");
  const macos = NodePath.join(contents, "MacOS");
  NodeFS.mkdirSync(macos, { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(contents, "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>com.t3tools.t3code</string>
  <key>CFBundleShortVersionString</key>
  <string>${version}</string>
</dict>
</plist>
`,
  );
};

const makeStubBin = (dir: string) => {
  const binDir = NodePath.join(dir, "bin");
  const openLog = NodePath.join(dir, "open.log");
  NodeFS.mkdirSync(binDir, { recursive: true });
  const writeExe = (name: string, body: string) => {
    const file = NodePath.join(binDir, name);
    NodeFS.writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
  };
  writeExe("sleep", "exit 0");
  writeExe("open", `printf '%s\\n' "$*" >> ${JSON.stringify(openLog)}`);
  return { binDir, openLog };
};

/**
 * Snapshot a WAL database while an active connection still holds uncheckpointed
 * frames in `-wal`, optionally after a partial PASSIVE checkpoint so the base
 * file alone has pages that require `-wal` to form a consistent B-tree.
 */
const seedUncheckpointedWalDb = (
  targetPath: string,
  options: { readonly keepShm: boolean; readonly partialCheckpoint?: boolean },
) => {
  const sourceDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-wal-seed-"));
  const sourcePath = NodePath.join(sourceDir, "statev2.sqlite");
  const writer = new NodeSqlite.DatabaseSync(sourcePath);
  const pinner = new NodeSqlite.DatabaseSync(sourcePath);
  try {
    writer.exec(`
      PRAGMA page_size = 4096;
      PRAGMA journal_mode = WAL;
      PRAGMA wal_autocheckpoint = 0;
      CREATE TABLE items (id INTEGER PRIMARY KEY, val TEXT NOT NULL);
      CREATE INDEX idx_items_val ON items(val);
    `);
    const insert = writer.prepare("INSERT INTO items (id, val) VALUES (?, ?)");
    const pad = "a".repeat(200);
    writer.exec("BEGIN");
    for (let i = 1; i <= 300; i++) insert.run(i, `v1-${i}-${pad}`);
    writer.exec("COMMIT");

    if (options.partialCheckpoint) {
      // Pin a reader on snapshot 1 so PASSIVE checkpoint can only copy up to here.
      pinner.exec("BEGIN");
      pinner.prepare("SELECT COUNT(*) FROM items").get();

      // Mutate pages heavily in WAL after the pinned read mark.
      const update = writer.prepare("UPDATE items SET val = ? WHERE id = ?");
      writer.exec("BEGIN");
      for (let i = 1; i <= 300; i++) update.run(`v2-${i}-${"b".repeat(200)}`, i);
      for (let i = 301; i <= 600; i++) insert.run(i, `v2-${i}-${"c".repeat(200)}`);
      writer.exec("COMMIT");

      // Checkpoint up to the reader's mark, leaving v2 pages only in -wal.
      writer.exec("PRAGMA wal_checkpoint(PASSIVE)");
    } else {
      writer.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      writer.exec("INSERT INTO items (id, val) VALUES (999, 'wal-only-row')");
    }

    // Copy files while connections remain open so -wal is preserved uncheckpointed.
    NodeFS.copyFileSync(sourcePath, targetPath);
    NodeFS.copyFileSync(`${sourcePath}-wal`, `${targetPath}-wal`);
    if (options.keepShm && NodeFS.existsSync(`${sourcePath}-shm`)) {
      NodeFS.copyFileSync(`${sourcePath}-shm`, `${targetPath}-shm`);
    }
  } finally {
    if (pinner.isTransaction) pinner.exec("COMMIT");
    pinner.close();
    writer.close();
    NodeFS.rmSync(sourceDir, { recursive: true, force: true });
  }
};

describe.skipIf(HostProcess.Platform.defaultValue() !== "darwin")("fork-app-update.sh", () => {
  it.each([
    { label: "with -shm removed", keepShm: false, partialCheckpoint: false, expectedCount: 301 },
    { label: "with -shm present", keepShm: true, partialCheckpoint: false, expectedCount: 301 },
    {
      label: "after partial checkpoint with uncheckpointed WAL frames",
      keepShm: false,
      partialCheckpoint: true,
      expectedCount: 600,
    },
  ])(
    "backs up an uncheckpointed WAL database ($label) and installs the new build",
    ({ keepShm, partialCheckpoint, expectedCount }) => {
      const workDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-fork-update-test-"));
      try {
        const installedApp = NodePath.join(workDir, "apps", "T3 Code (Beta).app");
        const newBuild = NodePath.join(workDir, "build", "T3 Code (Beta).app");
        const backupRoot = NodePath.join(workDir, "backups");
        const dbPath = NodePath.join(workDir, "userdata", "statev2.sqlite");
        const logFile = NodePath.join(workDir, "update.log");
        NodeFS.mkdirSync(NodePath.dirname(dbPath), { recursive: true });
        makeFakeApp(installedApp, "0.1.12-fork.20261125");
        makeFakeApp(newBuild, "0.1.12-fork.20261126");
        seedUncheckpointedWalDb(dbPath, { keepShm, partialCheckpoint });

        assert.isTrue(NodeFS.existsSync(`${dbPath}-wal`));
        assert.isAbove(NodeFS.statSync(`${dbPath}-wal`).size, 0);

        const { binDir } = makeStubBin(workDir);
        const result = NodeChildProcess.spawnSync("bash", [updateScript], {
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH ?? ""}`,
            T3_UPDATE_APP: installedApp,
            T3_UPDATE_BUILD: newBuild,
            T3_UPDATE_STATE_DB: dbPath,
            T3_UPDATE_BACKUP_ROOT: backupRoot,
            T3_UPDATE_LOG: logFile,
          },
        });

        assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
        assert.include(result.stdout, "installed version 0.1.12-fork.20261126");

        const backups = NodeFS.readdirSync(backupRoot);
        assert.equal(backups.length, 1);
        const backedUpDb = NodePath.join(backupRoot, backups[0]!, "statev2.sqlite");
        const verify = new NodeSqlite.DatabaseSync(backedUpDb, { readOnly: true });
        try {
          const check = verify.prepare("PRAGMA quick_check").get() as { quick_check: string };
          assert.equal(check.quick_check, "ok");
          const row = verify.prepare("SELECT COUNT(*) AS count FROM items").get() as {
            count: number;
          };
          assert.equal(row.count, expectedCount);
        } finally {
          verify.close();
        }
      } finally {
        NodeFS.rmSync(workDir, { recursive: true, force: true });
      }
    },
  );

  it("cleans up the empty backup directory and reopens the unchanged app when backup fails", () => {
    const workDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-fork-update-fail-"));
    try {
      const installedApp = NodePath.join(workDir, "apps", "T3 Code (Beta).app");
      const newBuild = NodePath.join(workDir, "build", "T3 Code (Beta).app");
      const backupRoot = NodePath.join(workDir, "backups");
      const dbPath = NodePath.join(workDir, "userdata", "statev2.sqlite");
      NodeFS.mkdirSync(NodePath.dirname(dbPath), { recursive: true });
      makeFakeApp(installedApp, "0.1.12-fork.20261125");
      makeFakeApp(newBuild, "0.1.12-fork.20261126");
      NodeFS.writeFileSync(dbPath, "not a sqlite database");

      const { binDir, openLog } = makeStubBin(workDir);
      const result = NodeChildProcess.spawnSync("bash", [updateScript], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
          T3_UPDATE_APP: installedApp,
          T3_UPDATE_BUILD: newBuild,
          T3_UPDATE_STATE_DB: dbPath,
          T3_UPDATE_BACKUP_ROOT: backupRoot,
        },
      });

      assert.equal(result.status, 1);
      assert.include(result.stdout, "database backup failed; nothing else changed");
      assert.equal(NodeFS.existsSync(backupRoot) ? NodeFS.readdirSync(backupRoot).length : 0, 0);
      assert.include(NodeFS.readFileSync(openLog, "utf8"), installedApp);
    } finally {
      NodeFS.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("dry-run previews pruned update backups and build cleanup without changing anything", () => {
    const workDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-fork-update-dry-"));
    try {
      const installedApp = NodePath.join(workDir, "apps", "T3 Code (Beta).app");
      const buildRoot = NodePath.join(workDir, "staged-build");
      const newBuild = NodePath.join(buildRoot, "mac-arm64", "T3 Code (Beta).app");
      const backupRoot = NodePath.join(workDir, "backups");
      const dbPath = NodePath.join(workDir, "userdata", "statev2.sqlite");
      NodeFS.mkdirSync(NodePath.dirname(dbPath), { recursive: true });
      NodeFS.mkdirSync(backupRoot, { recursive: true });
      makeFakeApp(installedApp, "0.1.12-fork.20261125");
      makeFakeApp(newBuild, "0.1.12-fork.20261126");
      seedUncheckpointedWalDb(dbPath, { keepShm: false });

      const existing = [
        "20261101-010000-update",
        "20261102-010000-update",
        "20261103-010000-update",
        "20261104-010000-update",
        "20261105-010000-update",
      ];
      for (const name of existing) {
        NodeFS.mkdirSync(NodePath.join(backupRoot, name), { recursive: true });
      }

      const result = NodeChildProcess.spawnSync("bash", [updateScript, "--dry-run"], {
        encoding: "utf8",
        env: {
          ...process.env,
          T3_UPDATE_APP: installedApp,
          T3_UPDATE_BUILD: newBuild,
          T3_UPDATE_BUILD_ROOT: buildRoot,
          T3_UPDATE_STATE_DB: dbPath,
          T3_UPDATE_BACKUP_ROOT: backupRoot,
          T3_UPDATE_KEEP: "4",
        },
      });

      assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
      assert.include(
        result.stdout,
        `Would prune old update backup: ${NodePath.join(backupRoot, existing[0]!)}`,
      );
      assert.include(
        result.stdout,
        `Would prune old update backup: ${NodePath.join(backupRoot, existing[1]!)}`,
      );
      assert.notInclude(
        result.stdout,
        `Would prune old update backup: ${NodePath.join(backupRoot, existing[2]!)}`,
      );
      assert.include(result.stdout, `Would remove staged build: ${buildRoot}`);
      assert.deepEqual(NodeFS.readdirSync(backupRoot).toSorted(), existing);
      assert.isTrue(NodeFS.existsSync(buildRoot));
    } finally {
      NodeFS.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("prunes old -update folders by name, protects first-swap/latest/symlinks/other names, preserves rollback, and removes staged build", () => {
    const workDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-fork-update-prune-"));
    try {
      const appsDir = NodePath.join(workDir, "apps");
      const installedApp = NodePath.join(appsDir, "T3 Code (Beta).app");
      const buildRoot = NodePath.join(workDir, "staged-build");
      const newBuild = NodePath.join(buildRoot, "mac-arm64", "T3 Code (Beta).app");
      const backupRoot = NodePath.join(workDir, "backups");
      const dbPath = NodePath.join(workDir, "userdata", "statev2.sqlite");
      NodeFS.mkdirSync(NodePath.dirname(dbPath), { recursive: true });
      NodeFS.mkdirSync(backupRoot, { recursive: true });
      makeFakeApp(installedApp, "0.1.12-fork.20261125");
      makeFakeApp(newBuild, "0.1.12-fork.20261126");
      seedUncheckpointedWalDb(dbPath, { keepShm: false });

      // Seed a real first-swap folder + latest symlink for rollback verification.
      const firstSwap = NodePath.join(backupRoot, "20261110-020054");
      makeFakeApp(NodePath.join(firstSwap, "T3 Code (Nightly).app"), "0.1.12-nightly.20261110");
      const swapDb = new NodeSqlite.DatabaseSync(NodePath.join(firstSwap, "statev2.sqlite"));
      swapDb.exec(
        "CREATE TABLE effect_sql_migrations (migration_id INTEGER PRIMARY KEY); INSERT INTO effect_sql_migrations VALUES (1);",
      );
      swapDb.close();
      NodeFS.writeFileSync(
        NodePath.join(firstSwap, "swap.env"),
        "nightly_version=0.1.12-nightly.20261110\nfork_version=0.1.12-fork.20261125\nfork_app=T3 Code (Beta).app\n",
      );
      NodeFS.symlinkSync(firstSwap, NodePath.join(backupRoot, "latest"));

      // Seed 4 prior -update folders; give the oldest-by-name a newer mtime than newer-by-name folders.
      const oldest = NodePath.join(backupRoot, "20261111-010000-update");
      const secondOldest = NodePath.join(backupRoot, "20261112-010000-update");
      const thirdNewest = NodePath.join(backupRoot, "20261113-010000-update");
      const fourthNewest = NodePath.join(backupRoot, "20261114-010000-update");
      for (const dir of [oldest, secondOldest, thirdNewest, fourthNewest]) {
        NodeFS.mkdirSync(dir, { recursive: true });
      }
      const futureSec = 1_900_000_000;
      NodeFS.utimesSync(oldest, futureSec, futureSec);

      // Seed protected non-matching folder and a symlink matching <time>-update.
      const nonMatching = NodePath.join(backupRoot, "beta-20261110-sync");
      NodeFS.mkdirSync(nonMatching, { recursive: true });
      const symlinkTarget = NodePath.join(workDir, "external-target");
      NodeFS.mkdirSync(symlinkTarget, { recursive: true });
      const symlinkUpdate = NodePath.join(backupRoot, "20261101-000000-update");
      NodeFS.symlinkSync(symlinkTarget, symlinkUpdate);

      const { binDir } = makeStubBin(workDir);
      const result = NodeChildProcess.spawnSync("bash", [updateScript], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
          T3_UPDATE_APP: installedApp,
          T3_UPDATE_BUILD: newBuild,
          T3_UPDATE_BUILD_ROOT: buildRoot,
          T3_UPDATE_STATE_DB: dbPath,
          T3_UPDATE_BACKUP_ROOT: backupRoot,
          T3_UPDATE_KEEP: "3",
        },
      });

      assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
      assert.isFalse(
        NodeFS.existsSync(oldest),
        "oldest-by-name must be removed despite newer mtime",
      );
      assert.isFalse(NodeFS.existsSync(secondOldest));
      assert.isTrue(NodeFS.existsSync(thirdNewest));
      assert.isTrue(NodeFS.existsSync(fourthNewest));
      assert.isTrue(NodeFS.existsSync(firstSwap));
      assert.isTrue(NodeFS.lstatSync(NodePath.join(backupRoot, "latest")).isSymbolicLink());
      assert.isTrue(NodeFS.existsSync(nonMatching));
      assert.isTrue(NodeFS.lstatSync(symlinkUpdate).isSymbolicLink());
      assert.isTrue(NodeFS.existsSync(symlinkTarget));
      assert.isFalse(NodeFS.existsSync(buildRoot), "staged build should be removed after launch");

      const updateDirs = NodeFS.readdirSync(backupRoot).filter((name) => {
        const full = NodePath.join(backupRoot, name);
        return !NodeFS.lstatSync(full).isSymbolicLink() && /^\d{8}-\d{6}-update$/.test(name);
      });
      assert.equal(updateDirs.length, 3);

      // Verify fork-app-rollback.sh --dry-run still passes against the first-swap folder.
      const rollbackDb = new NodeSqlite.DatabaseSync(dbPath);
      rollbackDb.exec(
        "CREATE TABLE IF NOT EXISTS effect_sql_migrations (migration_id INTEGER PRIMARY KEY); INSERT OR IGNORE INTO effect_sql_migrations VALUES (1);",
      );
      rollbackDb.close();
      const rollback = NodeChildProcess.spawnSync("bash", [rollbackScript, "--dry-run"], {
        encoding: "utf8",
        env: {
          ...process.env,
          T3_SWAP_APPS_DIR: appsDir,
          T3_SWAP_STATE_DB: dbPath,
          T3_SWAP_BACKUP_ROOT: backupRoot,
        },
      });
      assert.equal(rollback.status, 0, `stdout:\n${rollback.stdout}\nstderr:\n${rollback.stderr}`);
      assert.include(rollback.stdout, "Dry run: nothing changed.");
    } finally {
      NodeFS.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("defaults to T3_UPDATE_KEEP=1 and respects --keep-build", () => {
    const workDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-fork-update-keep1-"));
    try {
      const installedApp = NodePath.join(workDir, "apps", "T3 Code (Beta).app");
      const buildRoot = NodePath.join(workDir, "staged-build");
      const newBuild = NodePath.join(buildRoot, "mac-arm64", "T3 Code (Beta).app");
      const backupRoot = NodePath.join(workDir, "backups");
      const dbPath = NodePath.join(workDir, "userdata", "statev2.sqlite");
      NodeFS.mkdirSync(NodePath.dirname(dbPath), { recursive: true });
      NodeFS.mkdirSync(backupRoot, { recursive: true });
      makeFakeApp(installedApp, "0.1.12-fork.20261125");
      makeFakeApp(newBuild, "0.1.12-fork.20261126");
      seedUncheckpointedWalDb(dbPath, { keepShm: false });

      const priorA = NodePath.join(backupRoot, "20261120-010000-update");
      const priorB = NodePath.join(backupRoot, "20261121-010000-update");
      NodeFS.mkdirSync(priorA, { recursive: true });
      NodeFS.mkdirSync(priorB, { recursive: true });

      const { binDir } = makeStubBin(workDir);
      const result = NodeChildProcess.spawnSync("bash", [updateScript, "--keep-build"], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
          T3_UPDATE_APP: installedApp,
          T3_UPDATE_BUILD: newBuild,
          T3_UPDATE_BUILD_ROOT: buildRoot,
          T3_UPDATE_STATE_DB: dbPath,
          T3_UPDATE_BACKUP_ROOT: backupRoot,
        },
      });

      assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
      assert.isFalse(NodeFS.existsSync(priorA));
      assert.isFalse(NodeFS.existsSync(priorB));
      assert.equal(NodeFS.readdirSync(backupRoot).length, 1);
      assert.isTrue(NodeFS.existsSync(buildRoot), "--keep-build must preserve staged build");
    } finally {
      NodeFS.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("refuses T3_UPDATE_KEEP of 0 or non-numeric before quitting and removes no backup on failure", () => {
    const workDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-fork-update-invalid-"));
    try {
      const installedApp = NodePath.join(workDir, "apps", "T3 Code (Beta).app");
      const newBuild = NodePath.join(workDir, "build", "T3 Code (Beta).app");
      const backupRoot = NodePath.join(workDir, "backups");
      const dbPath = NodePath.join(workDir, "userdata", "statev2.sqlite");
      NodeFS.mkdirSync(NodePath.dirname(dbPath), { recursive: true });
      NodeFS.mkdirSync(backupRoot, { recursive: true });
      makeFakeApp(installedApp, "0.1.12-fork.20261125");
      makeFakeApp(newBuild, "0.1.12-fork.20261126");
      NodeFS.writeFileSync(dbPath, "not a sqlite database");
      const existing = NodePath.join(backupRoot, "20261110-010000-update");
      NodeFS.mkdirSync(existing, { recursive: true });

      const { binDir } = makeStubBin(workDir);
      for (const badKeep of ["0", "abc", "-2", ""]) {
        const res = NodeChildProcess.spawnSync("bash", [updateScript], {
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH ?? ""}`,
            T3_UPDATE_APP: installedApp,
            T3_UPDATE_BUILD: newBuild,
            T3_UPDATE_STATE_DB: dbPath,
            T3_UPDATE_BACKUP_ROOT: backupRoot,
            T3_UPDATE_KEEP: badKeep,
          },
        });
        assert.equal(res.status, 1);
        assert.include(res.stderr, "T3_UPDATE_KEEP must be an integer >= 1");
      }

      // A failed update (corrupt DB) must not prune existing backups or delete staged build.
      const failed = NodeChildProcess.spawnSync("bash", [updateScript], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
          T3_UPDATE_APP: installedApp,
          T3_UPDATE_BUILD: newBuild,
          T3_UPDATE_STATE_DB: dbPath,
          T3_UPDATE_BACKUP_ROOT: backupRoot,
          T3_UPDATE_KEEP: "1",
        },
      });
      assert.equal(failed.status, 1);
      assert.isTrue(NodeFS.existsSync(existing));
      assert.isTrue(NodeFS.existsSync(newBuild));
    } finally {
      NodeFS.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("logs a warning and still exits 0 when pruning an old backup fails", () => {
    const workDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-fork-update-rmfail-"));
    try {
      const installedApp = NodePath.join(workDir, "apps", "T3 Code (Beta).app");
      const newBuild = NodePath.join(workDir, "build", "T3 Code (Beta).app");
      const backupRoot = NodePath.join(workDir, "backups");
      const dbPath = NodePath.join(workDir, "userdata", "statev2.sqlite");
      NodeFS.mkdirSync(NodePath.dirname(dbPath), { recursive: true });
      NodeFS.mkdirSync(backupRoot, { recursive: true });
      makeFakeApp(installedApp, "0.1.12-fork.20261125");
      makeFakeApp(newBuild, "0.1.12-fork.20261126");
      seedUncheckpointedWalDb(dbPath, { keepShm: false });

      const lockedBackup = NodePath.join(backupRoot, "20261101-010000-update");
      NodeFS.mkdirSync(lockedBackup, { recursive: true });

      const { binDir, openLog } = makeStubBin(workDir);
      const rmStub = NodePath.join(binDir, "rm");
      NodeFS.writeFileSync(
        rmStub,
        `#!/usr/bin/env bash
for arg in "$@"; do
  if [[ "$arg" == *20261101-010000-update* ]]; then
    echo "rm: permission denied" >&2
    exit 1
  fi
done
exec /bin/rm "$@"
`,
        { mode: 0o755 },
      );

      const result = NodeChildProcess.spawnSync("bash", [updateScript], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
          T3_UPDATE_APP: installedApp,
          T3_UPDATE_BUILD: newBuild,
          T3_UPDATE_STATE_DB: dbPath,
          T3_UPDATE_BACKUP_ROOT: backupRoot,
          T3_UPDATE_KEEP: "1",
        },
      });

      assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
      assert.include(result.stdout, "warning: could not remove old update backup");
      assert.include(NodeFS.readFileSync(openLog, "utf8"), installedApp);
    } finally {
      NodeFS.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("reclaims intra-page B-tree slack on the live DB when above threshold, preserves backup, and honors --no-defrag", () => {
    const seedFragmentedDb = (targetPath: string) => {
      const db = new NodeSqlite.DatabaseSync(targetPath);
      try {
        db.exec(`
          PRAGMA page_size = 4096;
          PRAGMA auto_vacuum = INCREMENTAL;
          PRAGMA journal_mode = WAL;
          CREATE TABLE payloads (id INTEGER PRIMARY KEY, body TEXT NOT NULL);
        `);
        const insert = db.prepare("INSERT INTO payloads (id, body) VALUES (?, ?)");
        const big = "x".repeat(1200);
        db.exec("BEGIN");
        for (let i = 1; i <= 500; i++) insert.run(i, `${i}-${big}`);
        db.exec("COMMIT");
        // Shrink every other row in-place to create intra-page B-tree slack with freelist_count = 0.
        const update = db.prepare("UPDATE payloads SET body = ? WHERE id = ?");
        db.exec("BEGIN");
        for (let i = 1; i <= 500; i++) {
          if (i % 2 === 0) update.run(`short-${i}`, i);
        }
        db.exec("COMMIT");
        db.exec("PRAGMA incremental_vacuum; PRAGMA wal_checkpoint(TRUNCATE);");
        // Add an uncheckpointed WAL row to verify WAL replay is preserved during defrag swap.
        db.exec("INSERT INTO payloads (id, body) VALUES (501, 'wal-live-row')");
      } finally {
        db.close();
      }
    };

    const workDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-fork-update-defrag-"));
    try {
      const installedApp = NodePath.join(workDir, "apps", "T3 Code (Beta).app");
      const newBuildA = NodePath.join(workDir, "build-a", "T3 Code (Beta).app");
      const newBuildB = NodePath.join(workDir, "build-b", "T3 Code (Beta).app");
      const backupRootA = NodePath.join(workDir, "backups-a");
      const backupRootB = NodePath.join(workDir, "backups-b");
      const dbPath = NodePath.join(workDir, "userdata", "statev2.sqlite");
      NodeFS.mkdirSync(NodePath.dirname(dbPath), { recursive: true });
      makeFakeApp(installedApp, "0.1.12-fork.20261125");
      makeFakeApp(newBuildA, "0.1.12-fork.20261126");
      makeFakeApp(newBuildB, "0.1.12-fork.20261127");
      seedFragmentedDb(dbPath);
      const beforeSize = NodeFS.statSync(dbPath).size;

      const { binDir } = makeStubBin(workDir);

      // 1. --no-defrag leaves the fragmented live file size untouched.
      const noDefrag = NodeChildProcess.spawnSync(
        "bash",
        [updateScript, "--no-defrag", "--keep-build"],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH ?? ""}`,
            T3_UPDATE_APP: installedApp,
            T3_UPDATE_BUILD: newBuildA,
            T3_UPDATE_STATE_DB: dbPath,
            T3_UPDATE_BACKUP_ROOT: backupRootA,
            T3_UPDATE_DEFRAG_MIN_MIB: "0",
          },
        },
      );
      assert.equal(noDefrag.status, 0, `stdout:\n${noDefrag.stdout}\nstderr:\n${noDefrag.stderr}`);
      assert.include(noDefrag.stdout, "skipping live database defrag");
      assert.equal(NodeFS.statSync(dbPath).size, beforeSize);

      // 2. Default defrag (with min MiB 0 for small test fixture) shrinks live DB, clears stale WAL/SHM, and keeps valid backup.
      const defrag = NodeChildProcess.spawnSync("bash", [updateScript], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
          T3_UPDATE_APP: installedApp,
          T3_UPDATE_BUILD: newBuildB,
          T3_UPDATE_STATE_DB: dbPath,
          T3_UPDATE_BACKUP_ROOT: backupRootB,
          T3_UPDATE_DEFRAG_MIN_MIB: "0",
        },
      });
      assert.equal(defrag.status, 0, `stdout:\n${defrag.stdout}\nstderr:\n${defrag.stderr}`);
      assert.include(defrag.stdout, "defragmented live database verified");
      const afterSize = NodeFS.statSync(dbPath).size;
      assert.isBelow(afterSize, beforeSize, "live DB should measurably shrink after defrag");
      assert.isFalse(NodeFS.existsSync(`${dbPath}-wal`));
      assert.isFalse(NodeFS.existsSync(`${dbPath}-shm`));

      const verifyLive = new NodeSqlite.DatabaseSync(dbPath, { readOnly: true });
      try {
        assert.equal(
          (verifyLive.prepare("PRAGMA quick_check").get() as { quick_check: string }).quick_check,
          "ok",
        );
        assert.equal(
          (verifyLive.prepare("SELECT COUNT(*) AS count FROM payloads").get() as { count: number })
            .count,
          501,
        );
        const walRow = verifyLive.prepare("SELECT body FROM payloads WHERE id = 501").get() as {
          body: string;
        };
        assert.equal(walRow.body, "wal-live-row");
      } finally {
        verifyLive.close();
      }

      // Backup exists and passes quick_check with all 501 rows.
      const backups = NodeFS.readdirSync(backupRootB);
      assert.equal(backups.length, 1);
      const verifyBackup = new NodeSqlite.DatabaseSync(
        NodePath.join(backupRootB, backups[0]!, "statev2.sqlite"),
        { readOnly: true },
      );
      try {
        assert.equal(
          (verifyBackup.prepare("PRAGMA quick_check").get() as { quick_check: string }).quick_check,
          "ok",
        );
        assert.equal(
          (
            verifyBackup.prepare("SELECT COUNT(*) AS count FROM payloads").get() as {
              count: number;
            }
          ).count,
          501,
        );
      } finally {
        verifyBackup.close();
      }
    } finally {
      NodeFS.rmSync(workDir, { recursive: true, force: true });
    }
  });
});
