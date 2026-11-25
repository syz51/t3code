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
});
