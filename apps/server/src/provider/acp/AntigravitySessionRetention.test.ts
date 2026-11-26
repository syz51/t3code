// @effect-diagnostics nodeBuiltinImport:off -- fixtures write native SQLite session files and adjust file mtimes.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderSessionId, ThreadId } from "@t3tools/contracts";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../../config.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import { SCAN_CACHE_FILE_NAME } from "../../usage/usageScanCache.ts";
import * as AntigravitySessionRetention from "./AntigravitySessionRetention.ts";

const PROFILE_HASH = "ac0a3dfd6dddb20962cecff6ee5fe65e19d3923be20e52c5ab52ff877f7e4c32";
const NOW_MS = Date.UTC(2026, 10, 26, 12, 0, 0);
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const UUID = {
  deletedParent: "11111111-1111-4111-8111-111111111111",
  deletedDetachedChild: "22222222-2222-4222-8222-222222222222",
  deletedSwarmChild: "33333333-3333-4333-8333-333333333333",
  deletedDbChild: "44444444-4444-4444-8444-444444444444",
  deletedGrandchild: "55555555-5555-4555-8555-555555555555",
  settledAutoExpired: "66666666-6666-4666-8666-666666666666",
  settledAutoChild: "77777777-7777-4777-8777-777777777777",
  settledAutoFresh: "88888888-8888-4888-8888-888888888888",
  settledInteractiveRecent: "99999999-9999-4999-8999-999999999999",
  settledInteractiveOld: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  activeParent: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  activeChild: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  liveSettled: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  openHandleSettled: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  orphanOld: "12121212-1212-4121-8121-121212121212",
  orphanRecent: "34343434-3434-4343-8343-343434343434",
  corruptUsage: "56565656-5656-4565-8565-565656565656",
  forkedDeleted: "78787878-7878-4787-8787-787878787878",
} as const;

const varint = (value: number): number[] => {
  const bytes: number[] = [];
  while (value >= 0x80) {
    bytes.push((value & 0x7f) | 0x80);
    value = Math.floor(value / 0x80);
  }
  return [...bytes, value];
};
const protoField = (number: number, value: string | Uint8Array) => {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  return [...varint(number * 8 + 2), ...varint(bytes.length), ...bytes];
};
const proto = (...parts: number[][]) => Uint8Array.from(parts.flat());

function encodeInvokeSubagentStep(childIds: ReadonlyArray<string>): Uint8Array {
  const results = childIds.map((id) => protoField(10, proto(protoField(1, id))));
  return proto(protoField(143, proto(...results)));
}

function writeConversationDb(
  dbPath: string,
  options?: {
    readonly invokeChildren?: ReadonlyArray<string>;
    readonly outputTokens?: number;
    readonly corrupt?: boolean;
  },
) {
  if (options?.corrupt) {
    return NodeFSP.writeFile(dbPath, "not-a-sqlite-database");
  }
  const db = new NodeSqlite.DatabaseSync(dbPath);
  try {
    db.exec(
      "CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, step_format INTEGER, step_payload BLOB, metadata BLOB)",
    );
    if (options?.outputTokens !== undefined) {
      // Step protobuf: 100 input tokens, outputTokens output, timestamp 2026-08-01T10:00Z.
      const metadata = new Uint8Array([
        0x4a,
        4,
        0x10,
        100,
        0x18,
        options.outputTokens,
        ...Buffer.from("420608a087b7d306", "hex"),
      ]);
      db.prepare(
        "INSERT INTO steps (idx, step_type, step_format, step_payload, metadata) VALUES (?, 1, 0, NULL, ?)",
      ).run(0, metadata);
    }
    if (options?.invokeChildren && options.invokeChildren.length > 0) {
      db.prepare(
        "INSERT INTO steps (idx, step_type, step_format, step_payload, metadata) VALUES (?, 127, 0, ?, NULL)",
      ).run(1, encodeInvokeSubagentStep(options.invokeChildren));
    }
  } finally {
    db.close();
  }
  return Promise.resolve();
}

const seedSessionFiles = Effect.fn("seedSessionFiles")(function* (input: {
  readonly stateDir: string;
  readonly sessionId: string;
  readonly mtimeMs?: number;
  readonly detachedChildren?: ReadonlyArray<string>;
  readonly swarmChildren?: ReadonlyArray<string>;
  readonly dbChildren?: ReadonlyArray<string>;
  readonly artifacts?: ReadonlyArray<string>;
  readonly outputTokens?: number;
  readonly corruptDb?: boolean;
}) {
  const acpDir = NodePath.join(
    input.stateDir,
    "providers",
    "antigravity",
    PROFILE_HASH,
    "antigravity-acp",
  );
  const conversations = NodePath.join(acpDir, "conversations");
  const annotations = NodePath.join(acpDir, "annotations");
  const brain = NodePath.join(acpDir, "brain", input.sessionId);
  const sysGen = NodePath.join(brain, ".system_generated");
  const scratch = NodePath.join(brain, "scratch");

  yield* Effect.promise(async () => {
    await NodeFSP.mkdir(conversations, { recursive: true });
    await NodeFSP.mkdir(annotations, { recursive: true });
    await NodeFSP.mkdir(NodePath.join(sysGen, "logs"), { recursive: true });
    await NodeFSP.mkdir(scratch, { recursive: true });

    const dbPath = NodePath.join(conversations, `${input.sessionId}.db`);
    await writeConversationDb(dbPath, {
      ...(input.dbChildren === undefined ? {} : { invokeChildren: input.dbChildren }),
      ...(input.outputTokens === undefined ? {} : { outputTokens: input.outputTokens }),
      ...(input.corruptDb === undefined ? {} : { corrupt: input.corruptDb }),
    });
    await NodeFSP.writeFile(`${dbPath}-wal`, "wal-data");
    await NodeFSP.writeFile(`${dbPath}-shm`, "shm-data");
    await NodeFSP.writeFile(NodePath.join(annotations, `${input.sessionId}.pbtxt`), "annotation");
    await NodeFSP.writeFile(NodePath.join(sysGen, "logs", "transcript.jsonl"), '{"step":0}\n');
    await NodeFSP.writeFile(NodePath.join(scratch, "tmp.txt"), "scratch");

    if (input.detachedChildren && input.detachedChildren.length > 0) {
      const subDir = NodePath.join(sysGen, "subagents");
      await NodeFSP.mkdir(subDir, { recursive: true });
      for (const childId of input.detachedChildren) {
        await NodeFSP.writeFile(
          NodePath.join(subDir, `${childId}.json`),
          JSON.stringify({ conversationId: childId }),
        );
      }
    }
    if (input.swarmChildren && input.swarmChildren.length > 0) {
      const swarmDir = NodePath.join(sysGen, "swarm");
      await NodeFSP.mkdir(swarmDir, { recursive: true });
      const members = Object.fromEntries(
        input.swarmChildren.map((childId, idx) => [
          `worker-${idx + 1}`,
          { conversation_id: childId },
        ]),
      );
      await NodeFSP.writeFile(NodePath.join(swarmDir, "members.json"), JSON.stringify({ members }));
    }
    for (const artifact of input.artifacts ?? []) {
      const artifactPath = NodePath.join(brain, artifact);
      await NodeFSP.mkdir(NodePath.dirname(artifactPath), { recursive: true });
      await NodeFSP.writeFile(artifactPath, "user artifact");
    }

    if (input.mtimeMs !== undefined) {
      const atSeconds = input.mtimeMs / 1000;
      for (const target of [
        dbPath,
        `${dbPath}-wal`,
        `${dbPath}-shm`,
        NodePath.join(annotations, `${input.sessionId}.pbtxt`),
        NodePath.join(sysGen, "logs"),
        sysGen,
        scratch,
        brain,
      ]) {
        await NodeFSP.utimes(target, atSeconds, atSeconds).catch(() => undefined);
      }
    }
  });

  return {
    acpDir,
    dbPath: NodePath.join(conversations, `${input.sessionId}.db`),
    walPath: NodePath.join(conversations, `${input.sessionId}.db-wal`),
    shmPath: NodePath.join(conversations, `${input.sessionId}.db-shm`),
    annotationPath: NodePath.join(annotations, `${input.sessionId}.pbtxt`),
    brain,
    sysGen,
    scratch,
  };
});

const insertThreadRow = Effect.fn("insertThreadRow")(function* (input: {
  readonly threadId: string;
  readonly nativeSessionId: string;
  readonly updatedAtMs: number;
  readonly settledAtMs?: number | null;
  readonly deletedAtMs?: number | null;
  readonly relationshipToParent?: string | null;
  readonly providerSessionId?: string;
  readonly providerThreadStatus?: string;
  readonly forkedFromThreadId?: string;
}) {
  const sql = yield* SqlClient.SqlClient;
  const updatedAt = DateTime.formatIso(DateTime.makeUnsafe(input.updatedAtMs));
  const settledAt =
    input.settledAtMs == null ? null : DateTime.formatIso(DateTime.makeUnsafe(input.settledAtMs));
  const deletedAt =
    input.deletedAtMs == null ? null : DateTime.formatIso(DateTime.makeUnsafe(input.deletedAtMs));
  const payload = {
    title: "Test thread",
    settledAt,
    lineage: {
      parentThreadId: null,
      relationshipToParent: input.relationshipToParent ?? null,
      rootThreadId: input.threadId,
    },
    ...(input.forkedFromThreadId === undefined
      ? {}
      : { forkedFrom: { type: "run", threadId: input.forkedFromThreadId } }),
  };
  yield* sql`
    INSERT INTO orchestration_v2_projection_threads (
      thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
      created_at, updated_at, deleted_at, payload_json
    ) VALUES (
      ${input.threadId}, 'project:test', 'Test thread', 'antigravity',
      'full-access', 'default', ${updatedAt}, ${updatedAt}, ${deletedAt}, ${JSON.stringify(payload)}
    )
  `;
  const providerSessionId = input.providerSessionId ?? `provider-session:${input.threadId}`;
  yield* sql`
    INSERT INTO orchestration_v2_projection_provider_sessions (
      provider_session_id, thread_id, provider, status, updated_at, payload_json
    ) VALUES (
      ${providerSessionId}, ${input.threadId}, 'antigravity', 'stopped', ${updatedAt},
      ${JSON.stringify({ id: providerSessionId, driver: "antigravity" })}
    )
  `;
  yield* sql`
    INSERT INTO orchestration_v2_projection_provider_threads (
      provider_thread_id, thread_id, provider, provider_session_id, status, updated_at, payload_json
    ) VALUES (
      ${`pt:${input.threadId}:${input.nativeSessionId}`},
      ${input.threadId},
      'antigravity',
      ${providerSessionId},
      ${input.providerThreadStatus ?? "idle"},
      ${updatedAt},
      ${JSON.stringify({
        driver: "antigravity",
        providerInstanceId: "antigravity",
        nativeThreadRef: {
          driver: "antigravity",
          nativeId: input.nativeSessionId,
          strength: "strong",
        },
      })}
    )
  `;
});

const baseLayer = ServerConfig.layerTest(process.cwd(), { prefix: "agy-retention-" }).pipe(
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provideMerge(NodeServices.layer),
);

it.effect(
  "purges deleted threads and cascades across subagents, swarm members, DB invoke steps, and nested grandchildren",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const fs = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig.ServerConfig;
      const archivedPaths: string[] = [];

      const parent = yield* seedSessionFiles({
        stateDir: config.stateDir,
        sessionId: UUID.deletedParent,
        detachedChildren: [UUID.deletedDetachedChild],
        swarmChildren: [UUID.deletedSwarmChild],
        dbChildren: [UUID.deletedDbChild],
        artifacts: ["plan.md"],
        outputTokens: 13,
      });
      const detachedChild = yield* seedSessionFiles({
        stateDir: config.stateDir,
        sessionId: UUID.deletedDetachedChild,
        detachedChildren: [UUID.deletedGrandchild],
        outputTokens: 5,
      });
      const swarmChild = yield* seedSessionFiles({
        stateDir: config.stateDir,
        sessionId: UUID.deletedSwarmChild,
      });
      const dbChild = yield* seedSessionFiles({
        stateDir: config.stateDir,
        sessionId: UUID.deletedDbChild,
      });
      const grandchild = yield* seedSessionFiles({
        stateDir: config.stateDir,
        sessionId: UUID.deletedGrandchild,
      });

      yield* insertThreadRow({
        threadId: "thread-deleted",
        nativeSessionId: UUID.deletedParent,
        updatedAtMs: NOW_MS - HOUR_MS,
        deletedAtMs: NOW_MS,
      });

      const result = yield* AntigravitySessionRetention.AntigravitySessionRetention.pipe(
        Effect.flatMap((service) => service.purgeDeletedThread(ThreadId.make("thread-deleted"))),
        Effect.provide(
          AntigravitySessionRetention.layer.pipe(
            Layer.provide(
              Layer.succeed(AntigravitySessionRetention.OpenFileProbe, () =>
                Effect.succeed(new Set()),
              ),
            ),
            Layer.provide(
              Layer.succeed(AntigravitySessionRetention.UsageArchiver, (_dir, files) =>
                Effect.sync(() => {
                  archivedPaths.push(
                    ...files.filter((f) => f.records.length > 0).map((f) => f.path),
                  );
                  return true;
                }),
              ),
            ),
          ),
        ),
      );

      assert.equal(result.deletedSessions, 1);
      assert.equal(result.removedSubagentSessions, 4);
      assert.isAbove(result.reclaimedBytes, 0);
      assert.lengthOf(archivedPaths, 2);

      for (const target of [parent, detachedChild, swarmChild, dbChild, grandchild]) {
        assert.isFalse(yield* fs.exists(target.dbPath));
        assert.isFalse(yield* fs.exists(target.walPath));
        assert.isFalse(yield* fs.exists(target.shmPath));
        assert.isFalse(yield* fs.exists(target.annotationPath));
        assert.isFalse(yield* fs.exists(target.brain));
      }
    }).pipe(Effect.provide(baseLayer)),
);

it.effect(
  "enforces 24h automated vs 7d interactive settled retention, preserves user artifacts, protects active/live/open/forked sessions, and sweeps aged orphans",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const fs = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig.ServerConfig;

      // 1. Settled automated thread past 24h (with user artifacts + child subagent) -> pruned, artifact kept, child deleted.
      const autoExpired = yield* seedSessionFiles({
        stateDir: config.stateDir,
        sessionId: UUID.settledAutoExpired,
        detachedChildren: [UUID.settledAutoChild],
        artifacts: ["report.md", ".user_uploaded/shot.png"],
        outputTokens: 9,
      });
      const autoChild = yield* seedSessionFiles({
        stateDir: config.stateDir,
        sessionId: UUID.settledAutoChild,
        artifacts: ["child-note.md"],
      });
      yield* insertThreadRow({
        threadId: "mcp:auto-expired",
        nativeSessionId: UUID.settledAutoExpired,
        updatedAtMs: NOW_MS - 25 * HOUR_MS,
        settledAtMs: NOW_MS - 25 * HOUR_MS,
      });

      // 2. Settled automated thread under 24h -> kept.
      const autoFresh = yield* seedSessionFiles({
        stateDir: config.stateDir,
        sessionId: UUID.settledAutoFresh,
      });
      yield* insertThreadRow({
        threadId: "thread:subagent:auto-fresh",
        nativeSessionId: UUID.settledAutoFresh,
        updatedAtMs: NOW_MS - 12 * HOUR_MS,
        settledAtMs: NOW_MS - 12 * HOUR_MS,
      });

      // 3. Settled interactive thread at 3 days (<7d) -> kept.
      const interactiveRecent = yield* seedSessionFiles({
        stateDir: config.stateDir,
        sessionId: UUID.settledInteractiveRecent,
      });
      yield* insertThreadRow({
        threadId: "interactive-recent",
        nativeSessionId: UUID.settledInteractiveRecent,
        updatedAtMs: NOW_MS - 3 * DAY_MS,
        settledAtMs: NOW_MS - 3 * DAY_MS,
      });

      // 4. Settled interactive thread at 8 days (>=7d), no user artifacts -> pruned & empty brain removed.
      const interactiveOld = yield* seedSessionFiles({
        stateDir: config.stateDir,
        sessionId: UUID.settledInteractiveOld,
      });
      yield* insertThreadRow({
        threadId: "interactive-old",
        nativeSessionId: UUID.settledInteractiveOld,
        updatedAtMs: NOW_MS - 8 * DAY_MS,
        settledAtMs: NOW_MS - 8 * DAY_MS,
      });

      // 5. Active/unsettled parent + child older than 24h -> BOTH protected (child not swept as orphan!).
      const activeParent = yield* seedSessionFiles({
        stateDir: config.stateDir,
        sessionId: UUID.activeParent,
        detachedChildren: [UUID.activeChild],
        mtimeMs: NOW_MS - 48 * HOUR_MS,
      });
      const activeChild = yield* seedSessionFiles({
        stateDir: config.stateDir,
        sessionId: UUID.activeChild,
        mtimeMs: NOW_MS - 48 * HOUR_MS,
      });
      yield* insertThreadRow({
        threadId: "active-thread",
        nativeSessionId: UUID.activeParent,
        updatedAtMs: NOW_MS - 48 * HOUR_MS,
        settledAtMs: null,
      });

      // 6. Settled thread with live in-process session -> protected.
      const liveSettled = yield* seedSessionFiles({
        stateDir: config.stateDir,
        sessionId: UUID.liveSettled,
      });
      yield* insertThreadRow({
        threadId: "mcp:live-settled",
        nativeSessionId: UUID.liveSettled,
        providerSessionId: "provider-session:still-live",
        updatedAtMs: NOW_MS - 48 * HOUR_MS,
        settledAtMs: NOW_MS - 48 * HOUR_MS,
      });

      // 7. Settled thread whose WAL is held open by an OS process -> skipped.
      const openHandle = yield* seedSessionFiles({
        stateDir: config.stateDir,
        sessionId: UUID.openHandleSettled,
      });
      yield* insertThreadRow({
        threadId: "mcp:open-handle",
        nativeSessionId: UUID.openHandleSettled,
        updatedAtMs: NOW_MS - 48 * HOUR_MS,
        settledAtMs: NOW_MS - 48 * HOUR_MS,
      });

      // 8. Deleted source thread still shown by a live run-fork -> protected.
      const forkedDeleted = yield* seedSessionFiles({
        stateDir: config.stateDir,
        sessionId: UUID.forkedDeleted,
      });
      yield* insertThreadRow({
        threadId: "deleted-fork-source",
        nativeSessionId: UUID.forkedDeleted,
        updatedAtMs: NOW_MS - 48 * HOUR_MS,
        deletedAtMs: NOW_MS - 48 * HOUR_MS,
      });
      yield* insertThreadRow({
        threadId: "live-fork-child",
        nativeSessionId: UUID.activeParent,
        updatedAtMs: NOW_MS - HOUR_MS,
        settledAtMs: null,
        forkedFromThreadId: "deleted-fork-source",
      });

      // 9. Orphans: one older than 24h (swept), one newer than 24h (kept).
      const orphanOld = yield* seedSessionFiles({
        stateDir: config.stateDir,
        sessionId: UUID.orphanOld,
        mtimeMs: NOW_MS - 30 * HOUR_MS,
      });
      const orphanRecent = yield* seedSessionFiles({
        stateDir: config.stateDir,
        sessionId: UUID.orphanRecent,
        mtimeMs: NOW_MS - 2 * HOUR_MS,
      });

      const canonicalOpenWal = yield* fs.realPath(openHandle.walPath);
      const result = yield* AntigravitySessionRetention.AntigravitySessionRetention.pipe(
        Effect.flatMap((service) => service.pruneSessions()),
        Effect.provide(
          AntigravitySessionRetention.layer.pipe(
            Layer.provide(
              Layer.succeed(AntigravitySessionRetention.LiveSessionProbe, (id) =>
                Effect.succeed(id === ProviderSessionId.make("provider-session:still-live")),
              ),
            ),
            Layer.provide(
              Layer.succeed(AntigravitySessionRetention.OpenFileProbe, () =>
                Effect.succeed(new Set([canonicalOpenWal])),
              ),
            ),
            Layer.provide(
              Layer.succeed(AntigravitySessionRetention.UsageArchiver, () => Effect.succeed(true)),
            ),
          ),
        ),
      );

      assert.equal(result.prunedSettledSessions, 2);
      assert.equal(result.removedSubagentSessions, 1);
      assert.equal(result.removedOrphanSessions, 1);
      assert.equal(result.skippedOpenSessions, 1);

      // Settled automated expired: DB/annotations/.system_generated/scratch removed, user artifacts kept.
      assert.isFalse(yield* fs.exists(autoExpired.dbPath));
      assert.isFalse(yield* fs.exists(autoExpired.annotationPath));
      assert.isFalse(yield* fs.exists(autoExpired.sysGen));
      assert.isFalse(yield* fs.exists(autoExpired.scratch));
      assert.isTrue(yield* fs.exists(NodePath.join(autoExpired.brain, "report.md")));
      assert.isTrue(
        yield* fs.exists(NodePath.join(autoExpired.brain, ".user_uploaded", "shot.png")),
      );
      // Its child subagent was fully removed.
      assert.isFalse(yield* fs.exists(autoChild.dbPath));
      assert.isFalse(yield* fs.exists(autoChild.brain));

      // Settled interactive old (no user artifacts): brain dir removed too.
      assert.isFalse(yield* fs.exists(interactiveOld.dbPath));
      assert.isFalse(yield* fs.exists(interactiveOld.brain));

      // Protected sessions stay untouched.
      for (const kept of [
        autoFresh,
        interactiveRecent,
        activeParent,
        activeChild,
        liveSettled,
        openHandle,
        forkedDeleted,
        orphanRecent,
      ]) {
        assert.isTrue(yield* fs.exists(kept.dbPath), `expected kept: ${kept.dbPath}`);
        assert.isTrue(yield* fs.exists(kept.sysGen), `expected kept: ${kept.sysGen}`);
      }

      // Aged orphan fully swept.
      assert.isFalse(yield* fs.exists(orphanOld.dbPath));
      assert.isFalse(yield* fs.exists(orphanOld.brain));
    }).pipe(Effect.provide(baseLayer)),
);

it.effect(
  "refuses to delete a session when usage scanning fails or scan-cache persistence fails",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const fs = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig.ServerConfig;

      const corrupt = yield* seedSessionFiles({
        stateDir: config.stateDir,
        sessionId: UUID.corruptUsage,
        corruptDb: true,
      });
      yield* insertThreadRow({
        threadId: "mcp:corrupt",
        nativeSessionId: UUID.corruptUsage,
        updatedAtMs: NOW_MS - 48 * HOUR_MS,
        settledAtMs: NOW_MS - 48 * HOUR_MS,
      });

      const valid = yield* seedSessionFiles({
        stateDir: config.stateDir,
        sessionId: UUID.settledAutoExpired,
        outputTokens: 17,
      });
      yield* insertThreadRow({
        threadId: "mcp:persist-fail",
        nativeSessionId: UUID.settledAutoExpired,
        updatedAtMs: NOW_MS - 48 * HOUR_MS,
        settledAtMs: NOW_MS - 48 * HOUR_MS,
      });

      const result = yield* AntigravitySessionRetention.AntigravitySessionRetention.pipe(
        Effect.flatMap((service) => service.pruneSessions()),
        Effect.provide(
          AntigravitySessionRetention.layer.pipe(
            Layer.provide(
              Layer.succeed(AntigravitySessionRetention.OpenFileProbe, () =>
                Effect.succeed(new Set()),
              ),
            ),
            Layer.provide(
              Layer.succeed(AntigravitySessionRetention.UsageArchiver, () => Effect.succeed(false)),
            ),
          ),
        ),
      );

      assert.equal(result.prunedSettledSessions, 0);
      assert.equal(result.skippedUsageErrorSessions, 2);
      assert.isTrue(yield* fs.exists(corrupt.dbPath));
      assert.isTrue(yield* fs.exists(valid.dbPath));
    }).pipe(Effect.provide(baseLayer)),
);

it.effect(
  "archives usage to usage-scan-cache-v17.json offline before deleting in doctor mode",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;

      const session = yield* seedSessionFiles({
        stateDir: config.stateDir,
        sessionId: UUID.settledAutoExpired,
        outputTokens: 21,
      });
      yield* insertThreadRow({
        threadId: "mcp:offline-archive",
        nativeSessionId: UUID.settledAutoExpired,
        updatedAtMs: NOW_MS - 48 * HOUR_MS,
        settledAtMs: NOW_MS - 48 * HOUR_MS,
      });

      const result = yield* AntigravitySessionRetention.AntigravitySessionRetention.pipe(
        Effect.flatMap((service) => service.pruneSessions()),
        Effect.provide(
          AntigravitySessionRetention.layer.pipe(
            Layer.provide(
              Layer.succeed(AntigravitySessionRetention.OpenFileProbe, () =>
                Effect.succeed(new Set()),
              ),
            ),
            Layer.provide(AntigravitySessionRetention.layerOfflineUsageArchiver),
          ),
        ),
      );

      assert.equal(result.prunedSettledSessions, 1);
      assert.isFalse(yield* fs.exists(session.dbPath));
      const cacheRaw = yield* fs.readFileString(path.join(config.stateDir, SCAN_CACHE_FILE_NAME));
      const cacheDoc = JSON.parse(cacheRaw) as {
        files: Record<string, { p: string; r: unknown[] }>;
      };
      const archivedEntries = Object.values(cacheDoc.files).filter(
        (entry) => entry.p === "antigravity",
      );
      assert.lengthOf(archivedEntries, 1);
      assert.isAbove(archivedEntries[0]!.r.length, 0);
    }).pipe(Effect.provide(baseLayer)),
);

it.effect.skipIf(!symlinksSupported)(
  "never follows symlinks placed inside conversations or brain",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const outside = yield* fs.makeTempDirectoryScoped({ prefix: "agy-outside-" });
      const outsideFile = path.join(outside, "precious.db");
      yield* fs.writeFileString(outsideFile, "do-not-delete");

      const conversations = path.join(
        config.stateDir,
        "providers",
        "antigravity",
        PROFILE_HASH,
        "antigravity-acp",
        "conversations",
      );
      yield* fs.makeDirectory(conversations, { recursive: true });
      yield* fs.symlink(outsideFile, path.join(conversations, `${UUID.orphanOld}.db`));

      yield* AntigravitySessionRetention.AntigravitySessionRetention.pipe(
        Effect.flatMap((service) => service.pruneSessions()),
        Effect.provide(
          AntigravitySessionRetention.layer.pipe(
            Layer.provide(
              Layer.succeed(AntigravitySessionRetention.OpenFileProbe, () =>
                Effect.succeed(new Set()),
              ),
            ),
            Layer.provide(
              Layer.succeed(AntigravitySessionRetention.UsageArchiver, () => Effect.succeed(true)),
            ),
          ),
        ),
      );

      assert.isTrue(yield* fs.exists(outsideFile));
    }).pipe(Effect.provide(baseLayer)),
);
