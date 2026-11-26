// @effect-diagnostics nodeBuiltinImport:off -- Reads native SQLite child links, file mtimes, and POSIX open-file probes directly.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import type { ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../../config.ts";
import * as UsageService from "../../usage/UsageService.ts";
import { readAntigravityUsageFiles } from "../Drivers/antigravityUsageReader.ts";
import { protoFields } from "./AntigravityChildWork.ts";
import { antigravityManagedPath, antigravityProfileRoot } from "./AntigravityProfilePaths.ts";

const ANTIGRAVITY_SETTLED_AUTOMATED_RETENTION = Duration.hours(24);
const ANTIGRAVITY_SETTLED_INTERACTIVE_RETENTION = Duration.days(7);
const ANTIGRAVITY_ORPHAN_RETENTION_GRACE = Duration.hours(24);

const SESSION_DB_SUFFIXES = [".db", ".db-wal", ".db-shm", ".db-journal", ".meta"] as const;
const PRESERVED_BRAIN_PRUNE_SUBDIRS = [".system_generated", "scratch"] as const;

// Matches AntigravityChildWork.ts constants for classic invoke_subagent step decoding.
const STEP_INVOKE_SUBAGENT = 143;
const INVOKE_RESULTS = 10;
const INVOKE_SUBAGENT_STEP_TYPE = 127;
const MAX_STEP_BYTES = 1024 * 1024;
const MAX_INVOKE_ROWS = 200;
const MAX_DESCENDANTS_PER_ROOT = 256;
const LSOF_CHUNK_SIZE = 64;
const USAGE_ARCHIVE_BATCH_SIZE = 16;

const isNativeSessionId = Schema.is(Schema.String.check(Schema.isUUID(4)));
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

const decodeSwarmRoster = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      members: Schema.optional(
        Schema.Record(
          Schema.String,
          Schema.Struct({
            conversation_id: Schema.optional(Schema.String),
          }),
        ),
      ),
    }),
  ),
);

export interface AntigravitySessionRetentionResult {
  readonly deletedSessions: number;
  readonly prunedSettledSessions: number;
  readonly removedSubagentSessions: number;
  readonly removedOrphanSessions: number;
  readonly skippedOpenSessions: number;
  readonly skippedUsageErrorSessions: number;
  readonly reclaimedBytes: number;
}

export interface AntigravitySessionInspection {
  readonly prunableSessions: number;
  readonly deletedSessions: number;
  readonly settledSessions: number;
  readonly subagentSessions: number;
  readonly orphanSessions: number;
  readonly reclaimableBytes: number;
}

export const EMPTY_RETENTION_RESULT: AntigravitySessionRetentionResult = {
  deletedSessions: 0,
  prunedSettledSessions: 0,
  removedSubagentSessions: 0,
  removedOrphanSessions: 0,
  skippedOpenSessions: 0,
  skippedUsageErrorSessions: 0,
  reclaimedBytes: 0,
};

const EMPTY_INSPECTION: AntigravitySessionInspection = {
  prunableSessions: 0,
  deletedSessions: 0,
  settledSessions: 0,
  subagentSessions: 0,
  orphanSessions: 0,
  reclaimableBytes: 0,
};

export class AntigravitySessionRetentionError extends Schema.TaggedError<AntigravitySessionRetentionError>()(
  "AntigravitySessionRetentionError",
  {
    operation: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Antigravity session retention failed during ${this.operation}.`;
  }
}

export type LiveSessionCheck = (providerSessionId: ProviderSessionId) => Effect.Effect<boolean>;

/** Checks whether a provider session is currently live in-process. Defaults to false (offline). */
export class LiveSessionProbe extends Context.Reference<LiveSessionCheck>(
  "t3/provider/acp/AntigravitySessionRetention/LiveSessionProbe",
  { defaultValue: () => () => Effect.succeed(false) },
) {}

/** Archives parsed Antigravity usage files before their `.db` files are deleted. */
export class UsageArchiver extends Context.Reference<
  (stateDir: string, files: ReadonlyArray<UsageService.ArchivedUsageFile>) => Effect.Effect<boolean>
>("t3/provider/acp/AntigravitySessionRetention/UsageArchiver", {
  defaultValue: () => (_stateDir, _files) => Effect.succeed(true),
}) {}

export type OpenFileCheck = (
  candidatePaths: ReadonlyArray<string>,
) => Effect.Effect<ReadonlySet<string>>;

const defaultOpenFileCheck: OpenFileCheck = Effect.fnUntraced(function* (
  candidatePaths: ReadonlyArray<string>,
) {
  if (candidatePaths.length === 0 || (yield* HostProcess.Platform) === "win32") {
    return new Set<string>();
  }
  const open = new Set<string>();
  for (let start = 0; start < candidatePaths.length; start += LSOF_CHUNK_SIZE) {
    const chunk = candidatePaths.slice(start, start + LSOF_CHUNK_SIZE);
    const chunkOpen = yield* Effect.promise(
      () =>
        new Promise<ReadonlySet<string>>((resolve) => {
          NodeChildProcess.execFile(
            "lsof",
            ["-F", "n", "--", ...chunk],
            { timeout: 5_000, maxBuffer: 4 * 1024 * 1024 },
            (error, stdout) => {
              const found = new Set<string>();
              if (stdout.length > 0) {
                for (const line of stdout.split(/\r?\n/)) {
                  if (line.startsWith("n") && line.length > 1) {
                    found.add(line.slice(1));
                  }
                }
              }
              if (error === null) {
                resolve(found);
                return;
              }
              const errCode: unknown = (error as { readonly code?: unknown }).code;
              // Exit code 1 with empty stdout means no process has any of the files open.
              if (errCode === 1 || errCode === "ENOENT") {
                resolve(found);
                return;
              }
              // Fail closed on unexpected probe errors so live files are never deleted.
              for (const candidate of chunk) found.add(candidate);
              resolve(found);
            },
          );
        }),
    );
    for (const filePath of chunkOpen) {
      open.add(filePath);
      const canonical = yield* Effect.promise(() =>
        NodeFSP.realpath(filePath).catch(() => undefined),
      );
      if (canonical !== undefined) open.add(canonical);
    }
  }
  return open;
});

/** Detects files held open by a live OS process. Overridable in tests. */
export class OpenFileProbe extends Context.Reference<OpenFileCheck>(
  "t3/provider/acp/AntigravitySessionRetention/OpenFileProbe",
  { defaultValue: () => defaultOpenFileCheck },
) {}

export interface AntigravitySessionRetentionShape {
  readonly pruneSessions: (
    betweenPages?: Effect.Effect<void>,
  ) => Effect.Effect<AntigravitySessionRetentionResult, AntigravitySessionRetentionError>;
  readonly purgeDeletedThread: (
    threadId: ThreadId,
    options?: { readonly isSessionLive?: LiveSessionCheck },
  ) => Effect.Effect<AntigravitySessionRetentionResult, AntigravitySessionRetentionError>;
  readonly inspect: () => Effect.Effect<
    AntigravitySessionInspection,
    AntigravitySessionRetentionError
  >;
}

export class AntigravitySessionRetention extends Context.Reference<AntigravitySessionRetentionShape>(
  "t3/provider/acp/AntigravitySessionRetention",
  {
    defaultValue: () => ({
      pruneSessions: () => Effect.succeed(EMPTY_RETENTION_RESULT),
      purgeDeletedThread: () => Effect.succeed(EMPTY_RETENTION_RESULT),
      inspect: () => Effect.succeed(EMPTY_INSPECTION),
    }),
  },
) {}

/** Automated (`mcp:` / `subagent:` / `delegated-task:`) threads use the shorter 24h settled retention window. */
function isAutomatedAntigravityThread(
  threadId: string,
  relationshipToParent: string | null,
): boolean {
  return (
    threadId.startsWith("mcp:") ||
    threadId.startsWith("subagent:") ||
    threadId.startsWith("thread:subagent:") ||
    threadId.startsWith("thread:delegated-task:") ||
    relationshipToParent === "subagent"
  );
}

interface ThreadRetentionRow {
  readonly thread_id: string;
  readonly deleted_at: string | null;
  readonly updated_at: string;
  readonly settled_at: string | null;
  readonly relationship_to_parent: string | null;
  readonly is_shown: number;
  readonly has_active_run: number;
  readonly has_pending_request: number;
  readonly has_active_provider_thread: number;
}

type SessionAction =
  | { readonly kind: "full"; readonly category: "deleted" | "subagent" | "orphan" }
  | { readonly kind: "settled-parent" };

async function listProfileRoots(stateDir: string): Promise<ReadonlyArray<string>> {
  const antigravityDir = NodePath.join(stateDir, "providers", "antigravity");
  const baseInfo = await NodeFSP.lstat(antigravityDir).catch(() => undefined);
  if (baseInfo === undefined || baseInfo.isSymbolicLink() || !baseInfo.isDirectory()) {
    return [];
  }
  const entries = await NodeFSP.readdir(antigravityDir).catch(() => []);
  const roots: string[] = [];
  for (const name of entries) {
    const candidate = NodePath.join(antigravityDir, name);
    const info = await NodeFSP.lstat(candidate).catch(() => undefined);
    if (info === undefined || info.isSymbolicLink() || !info.isDirectory()) continue;
    const root = await antigravityProfileRoot(candidate);
    if (root === undefined) continue;
    const acp = await antigravityManagedPath(root, ["antigravity-acp"], "directory");
    if (acp !== undefined) roots.push(root);
  }
  return roots;
}

async function discoverDirectChildSessionIds(
  profileRoot: string,
  rootSessionId: string,
): Promise<ReadonlyArray<string>> {
  const discovered = new Set<string>();

  // 1. agy 1.5+ detached subagent descriptors in brain/<root>/.system_generated/subagents/*.json
  const subagentsDir = await antigravityManagedPath(
    profileRoot,
    ["antigravity-acp", "brain", rootSessionId, ".system_generated", "subagents"],
    "directory",
  );
  if (subagentsDir !== undefined) {
    const entries = await NodeFSP.readdir(subagentsDir.path).catch(() => []);
    for (const name of entries) {
      if (!name.endsWith(".json")) continue;
      const candidate = name.slice(0, -5);
      if (isNativeSessionId(candidate) && candidate !== rootSessionId) {
        discovered.add(candidate);
      }
    }
  }

  // 2. Native swarm roster in brain/<root>/.system_generated/swarm/members.json
  const swarmRoster = await antigravityManagedPath(
    profileRoot,
    ["antigravity-acp", "brain", rootSessionId, ".system_generated", "swarm", "members.json"],
    "file",
  );
  if (swarmRoster !== undefined && swarmRoster.info.size <= MAX_STEP_BYTES) {
    const raw = await NodeFSP.readFile(swarmRoster.path, "utf8").catch(() => undefined);
    const decoded = raw === undefined ? undefined : Option.getOrUndefined(decodeSwarmRoster(raw));
    if (decoded?.members !== undefined) {
      for (const member of Object.values(decoded.members)) {
        const convId = member.conversation_id;
        if (convId !== undefined && isNativeSessionId(convId) && convId !== rootSessionId) {
          discovered.add(convId);
        }
      }
    }
  }

  // 3. Classic invoke_subagent steps inside conversations/<root>.db
  const dbEntry = await antigravityManagedPath(
    profileRoot,
    ["antigravity-acp", "conversations", `${rootSessionId}.db`],
    "file",
  );
  if (dbEntry !== undefined) {
    let database: NodeSqlite.DatabaseSync | undefined;
    try {
      database = new NodeSqlite.DatabaseSync(dbEntry.path, { readOnly: true });
      database.exec("PRAGMA busy_timeout = 100");
      const hasSteps = database
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'steps'")
        .get();
      if (hasSteps !== undefined) {
        const rows = database
          .prepare(
            "SELECT step_payload FROM steps WHERE step_type = ? AND step_format = 0 AND length(step_payload) <= ? LIMIT ?",
          )
          .all(INVOKE_SUBAGENT_STEP_TYPE, MAX_STEP_BYTES, MAX_INVOKE_ROWS);
        for (const row of rows) {
          if (
            row === null ||
            typeof row !== "object" ||
            !("step_payload" in row) ||
            !(row.step_payload instanceof Uint8Array)
          ) {
            continue;
          }
          try {
            for (const [field, value] of protoFields(row.step_payload)) {
              if (field !== STEP_INVOKE_SUBAGENT) continue;
              for (const [subField, subValue] of protoFields(value)) {
                if (subField !== INVOKE_RESULTS) continue;
                for (const [resField, resValue] of protoFields(subValue)) {
                  if (resField !== 1) continue;
                  const childId = utf8Decoder.decode(resValue).trim();
                  if (isNativeSessionId(childId) && childId !== rootSessionId) {
                    discovered.add(childId);
                  }
                }
              }
            }
          } catch {
            // Skip undecodable step blobs.
          }
        }
      }
    } catch {
      // Unreadable or locked conversation DBs are skipped safely.
    } finally {
      database?.close();
    }
  }

  return [...discovered];
}

async function discoverDescendantSessionIds(
  profileRoot: string,
  rootSessionId: string,
): Promise<ReadonlyArray<string>> {
  const seen = new Set<string>([rootSessionId]);
  const descendants: string[] = [];
  const queue: string[] = [rootSessionId];
  while (queue.length > 0 && descendants.length < MAX_DESCENDANTS_PER_ROOT) {
    const current = queue.shift()!;
    const children = await discoverDirectChildSessionIds(profileRoot, current);
    for (const child of children) {
      if (seen.has(child)) continue;
      seen.add(child);
      descendants.push(child);
      if (descendants.length >= MAX_DESCENDANTS_PER_ROOT) break;
      queue.push(child);
    }
  }
  return descendants;
}

async function listDiskSessionIds(profileRoot: string): Promise<ReadonlySet<string>> {
  const ids = new Set<string>();
  const conversationsDir = await antigravityManagedPath(
    profileRoot,
    ["antigravity-acp", "conversations"],
    "directory",
  );
  if (conversationsDir !== undefined) {
    for (const name of await NodeFSP.readdir(conversationsDir.path).catch(() => [])) {
      for (const suffix of SESSION_DB_SUFFIXES) {
        if (!name.endsWith(suffix)) continue;
        const candidate = name.slice(0, -suffix.length);
        if (isNativeSessionId(candidate)) ids.add(candidate);
        break;
      }
    }
  }
  const brainDir = await antigravityManagedPath(
    profileRoot,
    ["antigravity-acp", "brain"],
    "directory",
  );
  if (brainDir !== undefined) {
    for (const name of await NodeFSP.readdir(brainDir.path).catch(() => [])) {
      if (isNativeSessionId(name)) ids.add(name);
    }
  }
  const annotationsDir = await antigravityManagedPath(
    profileRoot,
    ["antigravity-acp", "annotations"],
    "directory",
  );
  if (annotationsDir !== undefined) {
    for (const name of await NodeFSP.readdir(annotationsDir.path).catch(() => [])) {
      if (!name.endsWith(".pbtxt")) continue;
      const candidate = name.slice(0, -".pbtxt".length);
      if (isNativeSessionId(candidate)) ids.add(candidate);
    }
  }
  return ids;
}

async function measureTreeBytes(targetPath: string, maxEntries = 20_000): Promise<number> {
  let bytes = 0;
  let seen = 0;
  const stack = [targetPath];
  while (stack.length > 0 && seen < maxEntries) {
    const current = stack.pop()!;
    const info = await NodeFSP.lstat(current).catch(() => undefined);
    if (info === undefined || info.isSymbolicLink()) continue;
    seen += 1;
    if (info.isFile()) {
      bytes += info.size;
    } else if (info.isDirectory()) {
      const entries = await NodeFSP.readdir(current).catch(() => []);
      for (const name of entries) stack.push(NodePath.join(current, name));
    }
  }
  return bytes;
}

async function sessionNewestMtimeMs(
  profileRoot: string,
  sessionId: string,
): Promise<number | null> {
  let newest: number | null = null;
  const note = (mtimeMs: number) => {
    newest = newest === null ? mtimeMs : Math.max(newest, mtimeMs);
  };
  for (const suffix of SESSION_DB_SUFFIXES) {
    const entry = await antigravityManagedPath(
      profileRoot,
      ["antigravity-acp", "conversations", `${sessionId}${suffix}`],
      "file",
    );
    if (entry !== undefined) note(entry.info.mtimeMs);
  }
  const annotation = await antigravityManagedPath(
    profileRoot,
    ["antigravity-acp", "annotations", `${sessionId}.pbtxt`],
    "file",
  );
  if (annotation !== undefined) note(annotation.info.mtimeMs);
  const brain = await antigravityManagedPath(
    profileRoot,
    ["antigravity-acp", "brain", sessionId],
    "directory",
  );
  if (brain !== undefined) {
    note(brain.info.mtimeMs);
    for (const subdir of PRESERVED_BRAIN_PRUNE_SUBDIRS) {
      const entry = await antigravityManagedPath(
        profileRoot,
        ["antigravity-acp", "brain", sessionId, subdir],
        "directory",
      );
      if (entry !== undefined) note(entry.info.mtimeMs);
    }
    const logs = await antigravityManagedPath(
      profileRoot,
      ["antigravity-acp", "brain", sessionId, ".system_generated", "logs"],
      "directory",
    );
    if (logs !== undefined) note(logs.info.mtimeMs);
  }
  return newest;
}

async function existingSessionTargets(
  profileRoot: string,
  sessionId: string,
  action: SessionAction,
): Promise<{
  readonly dbPath: string | undefined;
  readonly openCheckPaths: ReadonlyArray<string>;
  readonly filePaths: ReadonlyArray<string>;
  readonly dirPaths: ReadonlyArray<string>;
  readonly brainDirPath: string | undefined;
}> {
  let dbPath: string | undefined;
  const openCheckPaths: string[] = [];
  const filePaths: string[] = [];
  const dirPaths: string[] = [];

  for (const suffix of SESSION_DB_SUFFIXES) {
    const entry = await antigravityManagedPath(
      profileRoot,
      ["antigravity-acp", "conversations", `${sessionId}${suffix}`],
      "file",
    );
    if (entry === undefined) continue;
    filePaths.push(entry.path);
    if (suffix === ".db") dbPath = entry.path;
    if (suffix === ".db" || suffix === ".db-wal" || suffix === ".db-shm") {
      openCheckPaths.push(entry.path);
    }
  }

  const annotation = await antigravityManagedPath(
    profileRoot,
    ["antigravity-acp", "annotations", `${sessionId}.pbtxt`],
    "file",
  );
  if (annotation !== undefined) {
    filePaths.push(annotation.path);
  }

  const brain = await antigravityManagedPath(
    profileRoot,
    ["antigravity-acp", "brain", sessionId],
    "directory",
  );
  if (brain !== undefined) {
    if (action.kind === "full") {
      dirPaths.push(brain.path);
    } else {
      for (const subdir of PRESERVED_BRAIN_PRUNE_SUBDIRS) {
        const entry = await antigravityManagedPath(
          profileRoot,
          ["antigravity-acp", "brain", sessionId, subdir],
          "directory",
        );
        if (entry !== undefined) dirPaths.push(entry.path);
      }
    }
  }

  return { dbPath, openCheckPaths, filePaths, dirPaths, brainDirPath: brain?.path };
}

interface PlannedSessionOp {
  readonly profileRoot: string;
  readonly sessionId: string;
  readonly action: SessionAction;
  readonly dbPath: string | undefined;
  readonly openCheckPaths: ReadonlyArray<string>;
  readonly filePaths: ReadonlyArray<string>;
  readonly dirPaths: ReadonlyArray<string>;
  readonly brainDirPath: string | undefined;
}

const makeForStateDir = Effect.fn("AntigravitySessionRetention.make")(function* (stateDir: string) {
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const defaultLiveProbe = yield* LiveSessionProbe;
  const usageArchiver = yield* UsageArchiver;
  const openFileProbe = yield* OpenFileProbe;

  const readThreadRetentionState = Effect.fnUntraced(function* (onlyThreadId?: ThreadId) {
    const links = yield* (
      onlyThreadId === undefined
        ? sql<{ readonly thread_id: string | null; readonly native_session_id: string }>`
            SELECT DISTINCT thread_id, native_session_id FROM (
              SELECT thread_id, json_extract(payload_json, '$.nativeThreadRef.nativeId') AS native_session_id
              FROM orchestration_v2_projection_provider_threads
              WHERE provider = 'antigravity'
                AND json_extract(payload_json, '$.nativeThreadRef.nativeId') IS NOT NULL
              UNION
              SELECT thread_id, json_extract(payload_json, '$.nativeThreadId') AS native_session_id
              FROM orchestration_v2_projection_run_attempts
              WHERE provider = 'antigravity'
                AND json_extract(payload_json, '$.nativeThreadId') IS NOT NULL
              UNION
              SELECT thread_id, json_extract(payload_json, '$.childSessionId') AS native_session_id
              FROM orchestration_v2_projection_subagents
              WHERE json_extract(payload_json, '$.childSessionId') IS NOT NULL
            )
          `
        : sql<{ readonly thread_id: string | null; readonly native_session_id: string }>`
            WITH target_sessions(native_session_id) AS (
              SELECT json_extract(payload_json, '$.nativeThreadRef.nativeId')
              FROM orchestration_v2_projection_provider_threads
              WHERE provider = 'antigravity' AND thread_id = ${onlyThreadId}
                AND json_extract(payload_json, '$.nativeThreadRef.nativeId') IS NOT NULL
              UNION
              SELECT json_extract(payload_json, '$.nativeThreadId')
              FROM orchestration_v2_projection_run_attempts
              WHERE provider = 'antigravity' AND thread_id = ${onlyThreadId}
                AND json_extract(payload_json, '$.nativeThreadId') IS NOT NULL
              UNION
              SELECT json_extract(payload_json, '$.childSessionId')
              FROM orchestration_v2_projection_subagents
              WHERE thread_id = ${onlyThreadId}
                AND json_extract(payload_json, '$.childSessionId') IS NOT NULL
            )
            SELECT DISTINCT all_links.thread_id, all_links.native_session_id
            FROM (
              SELECT thread_id, json_extract(payload_json, '$.nativeThreadRef.nativeId') AS native_session_id
              FROM orchestration_v2_projection_provider_threads
              WHERE provider = 'antigravity'
                AND json_extract(payload_json, '$.nativeThreadRef.nativeId') IS NOT NULL
              UNION
              SELECT thread_id, json_extract(payload_json, '$.nativeThreadId') AS native_session_id
              FROM orchestration_v2_projection_run_attempts
              WHERE provider = 'antigravity'
                AND json_extract(payload_json, '$.nativeThreadId') IS NOT NULL
              UNION
              SELECT thread_id, json_extract(payload_json, '$.childSessionId') AS native_session_id
              FROM orchestration_v2_projection_subagents
              WHERE json_extract(payload_json, '$.childSessionId') IS NOT NULL
            ) AS all_links
            WHERE all_links.native_session_id IN (SELECT native_session_id FROM target_sessions)
          `
    ).pipe(NodeSqliteClient.readOnly);

    const sessionToThreads = new Map<string, Set<string | null>>();
    const threadIds = new Set<string>();
    for (const link of links) {
      if (!isNativeSessionId(link.native_session_id)) continue;
      let owners = sessionToThreads.get(link.native_session_id);
      if (owners === undefined) {
        owners = new Set();
        sessionToThreads.set(link.native_session_id, owners);
      }
      owners.add(link.thread_id);
      if (link.thread_id !== null) threadIds.add(link.thread_id);
    }

    const threadMap = new Map<string, ThreadRetentionRow>();
    const threadProviderSessions = new Map<string, Array<ProviderSessionId>>();
    const allThreadIds = [...threadIds];

    for (let start = 0; start < allThreadIds.length; start += 200) {
      const batch = allThreadIds.slice(start, start + 200);
      const rows = yield* sql<ThreadRetentionRow>`
        WITH RECURSIVE shown(thread_id) AS (
          SELECT thread_id FROM orchestration_v2_projection_threads WHERE deleted_at IS NULL
          UNION
          SELECT transfer.source_thread_id
          FROM orchestration_v2_projection_context_transfers AS transfer
          JOIN orchestration_v2_projection_threads AS target
            ON target.thread_id = transfer.target_thread_id
          WHERE transfer.type = 'merge_back' AND transfer.status = 'pending'
            AND target.deleted_at IS NULL
          UNION
          SELECT json_extract(fork.payload_json, '$.forkedFrom.threadId')
          FROM shown
          JOIN orchestration_v2_projection_threads AS fork ON fork.thread_id = shown.thread_id
          WHERE json_extract(fork.payload_json, '$.forkedFrom.type') = 'run'
        )
        SELECT
          thread.thread_id,
          thread.deleted_at,
          thread.updated_at,
          json_extract(thread.payload_json, '$.settledAt') AS settled_at,
          json_extract(thread.payload_json, '$.lineage.relationshipToParent') AS relationship_to_parent,
          thread.thread_id IN (SELECT thread_id FROM shown WHERE thread_id IS NOT NULL) AS is_shown,
          EXISTS (
            SELECT 1 FROM orchestration_v2_projection_runs AS run
            WHERE run.thread_id = thread.thread_id
              AND run.status IN ('preparing', 'starting', 'running', 'waiting')
          ) AS has_active_run,
          EXISTS (
            SELECT 1 FROM orchestration_v2_projection_runtime_requests AS req
            WHERE req.thread_id = thread.thread_id
              AND req.status = 'pending'
          ) AS has_pending_request,
          EXISTS (
            SELECT 1 FROM orchestration_v2_projection_provider_threads AS pt
            WHERE pt.thread_id = thread.thread_id
              AND pt.provider = 'antigravity'
              AND pt.status = 'active'
          ) AS has_active_provider_thread
        FROM orchestration_v2_projection_threads AS thread
        WHERE thread.thread_id IN ${sql.in(batch)}
      `.pipe(NodeSqliteClient.readOnly);
      for (const row of rows) threadMap.set(row.thread_id, row);

      const sessionRows = yield* sql<{
        readonly thread_id: string;
        readonly provider_session_id: ProviderSessionId;
      }>`
        SELECT DISTINCT thread_id, provider_session_id FROM (
          SELECT thread_id, provider_session_id
          FROM orchestration_v2_projection_provider_sessions
          WHERE provider = 'antigravity' AND thread_id IN ${sql.in(batch)}
          UNION
          SELECT thread_id, provider_session_id
          FROM orchestration_v2_projection_provider_threads
          WHERE provider = 'antigravity'
            AND provider_session_id IS NOT NULL
            AND thread_id IN ${sql.in(batch)}
        )
      `.pipe(NodeSqliteClient.readOnly);
      for (const row of sessionRows) {
        const list = threadProviderSessions.get(row.thread_id) ?? [];
        list.push(row.provider_session_id);
        threadProviderSessions.set(row.thread_id, list);
      }
    }

    return { sessionToThreads, threadMap, threadProviderSessions };
  });

  const planPass = Effect.fnUntraced(function* (options: {
    readonly onlyThreadId?: ThreadId;
    readonly isSessionLive: LiveSessionCheck;
    readonly betweenPages: Effect.Effect<void>;
  }) {
    const profileRoots = yield* Effect.promise(() => listProfileRoots(stateDir));
    if (profileRoots.length === 0) return [] as ReadonlyArray<PlannedSessionOp>;

    const nowMs = yield* Clock.currentTimeMillis;
    const automatedRetentionMs = Duration.toMillis(ANTIGRAVITY_SETTLED_AUTOMATED_RETENTION);
    const interactiveRetentionMs = Duration.toMillis(ANTIGRAVITY_SETTLED_INTERACTIVE_RETENTION);
    const orphanGraceMs = Duration.toMillis(ANTIGRAVITY_ORPHAN_RETENTION_GRACE);

    const { sessionToThreads, threadMap, threadProviderSessions } = yield* readThreadRetentionState(
      options.onlyThreadId,
    );

    const threadLiveCache = new Map<string, boolean>();
    const isThreadLive = Effect.fnUntraced(function* (threadId: string) {
      const cached = threadLiveCache.get(threadId);
      if (cached !== undefined) return cached;
      const sessions = threadProviderSessions.get(threadId) ?? [];
      for (const sessionId of sessions) {
        if (yield* options.isSessionLive(sessionId)) {
          threadLiveCache.set(threadId, true);
          return true;
        }
      }
      threadLiveCache.set(threadId, false);
      return false;
    });

    type ThreadDisposition = "protected" | "deleted" | "settled-expired";
    const classifyThread = Effect.fnUntraced(function* (
      threadId: string | null,
    ): Effect.fn.Return<ThreadDisposition> {
      if (threadId === null) return "protected";
      const row = threadMap.get(threadId);
      if (row === undefined) return "protected";
      if (yield* isThreadLive(threadId)) return "protected";
      if (
        row.has_active_run === 1 ||
        row.has_pending_request === 1 ||
        row.has_active_provider_thread === 1
      ) {
        return "protected";
      }
      if (row.deleted_at !== null) {
        return row.is_shown === 1 ? "protected" : "deleted";
      }
      if (options.onlyThreadId !== undefined) {
        // Immediate thread.deleted purge only touches deleted threads.
        return "protected";
      }
      if (row.settled_at === null) return "protected";
      const settledMs = Date.parse(row.settled_at);
      const updatedMs = Date.parse(row.updated_at);
      if (!Number.isFinite(settledMs) || !Number.isFinite(updatedMs)) return "protected";
      const anchorMs = Math.max(settledMs, updatedMs);
      const retentionMs = isAutomatedAntigravityThread(row.thread_id, row.relationship_to_parent)
        ? automatedRetentionMs
        : interactiveRetentionMs;
      return nowMs - anchorMs >= retentionMs ? "settled-expired" : "protected";
    });

    const protectedRoots = new Set<string>();
    const deletedRoots = new Set<string>();
    const settledRoots = new Set<string>();

    for (const [sessionId, owners] of sessionToThreads) {
      let hasProtected = false;
      let hasSettled = false;
      for (const owner of owners) {
        const disposition = yield* classifyThread(owner);
        if (disposition === "protected") {
          hasProtected = true;
          break;
        }
        if (disposition === "settled-expired") {
          hasSettled = true;
        }
      }
      if (hasProtected) {
        protectedRoots.add(sessionId);
      } else if (hasSettled) {
        settledRoots.add(sessionId);
      } else {
        deletedRoots.add(sessionId);
      }
    }

    const operations: PlannedSessionOp[] = [];
    for (const profileRoot of profileRoots) {
      const diskIds = yield* Effect.promise(() => listDiskSessionIds(profileRoot));
      if (diskIds.size === 0) continue;

      // Protect all descendant subagent sessions of every protected parent session.
      const protectedAll = new Set<string>(protectedRoots);
      if (options.onlyThreadId === undefined) {
        for (const rootId of protectedRoots) {
          if (!diskIds.has(rootId)) continue;
          const descendants = yield* Effect.promise(() =>
            discoverDescendantSessionIds(profileRoot, rootId),
          );
          for (const childId of descendants) protectedAll.add(childId);
          yield* options.betweenPages;
        }
      }

      const plannedBySession = new Map<string, SessionAction>();
      const scheduleAction = (sessionId: string, action: SessionAction) => {
        if (protectedAll.has(sessionId) || !diskIds.has(sessionId)) return;
        const existing = plannedBySession.get(sessionId);
        // Full removal supersedes partial settled pruning if a session is both.
        if (
          existing === undefined ||
          (existing.kind === "settled-parent" && action.kind === "full")
        ) {
          plannedBySession.set(sessionId, action);
        }
      };

      // Deleted roots + cascaded children (full delete).
      for (const rootId of deletedRoots) {
        if (!diskIds.has(rootId)) continue;
        const descendants = yield* Effect.promise(() =>
          discoverDescendantSessionIds(profileRoot, rootId),
        );
        for (const childId of descendants) {
          scheduleAction(childId, { kind: "full", category: "subagent" });
        }
        scheduleAction(rootId, { kind: "full", category: "deleted" });
        yield* options.betweenPages;
      }

      // Settled expired roots (partial parent prune) + cascaded children (full delete).
      for (const rootId of settledRoots) {
        if (!diskIds.has(rootId)) continue;
        const descendants = yield* Effect.promise(() =>
          discoverDescendantSessionIds(profileRoot, rootId),
        );
        for (const childId of descendants) {
          scheduleAction(childId, { kind: "full", category: "subagent" });
        }
        scheduleAction(rootId, { kind: "settled-parent" });
        yield* options.betweenPages;
      }

      // Orphan sweep (only during full maintenance pass, never during single-thread deletion).
      if (options.onlyThreadId === undefined) {
        for (const sessionId of diskIds) {
          if (
            sessionToThreads.has(sessionId) ||
            protectedAll.has(sessionId) ||
            plannedBySession.has(sessionId)
          ) {
            continue;
          }
          const newestMtimeMs = yield* Effect.promise(() =>
            sessionNewestMtimeMs(profileRoot, sessionId),
          );
          if (newestMtimeMs !== null && nowMs - newestMtimeMs >= orphanGraceMs) {
            scheduleAction(sessionId, { kind: "full", category: "orphan" });
          }
          yield* options.betweenPages;
        }
      }

      // Resolve actual managed targets on disk; children run before parents in order.
      const ordered = [...plannedBySession.entries()].sort(([, left], [, right]) => {
        const rank = (action: SessionAction) =>
          action.kind === "full" && action.category === "subagent" ? 0 : 1;
        return rank(left) - rank(right);
      });

      for (const [sessionId, action] of ordered) {
        const targets = yield* Effect.promise(() =>
          existingSessionTargets(profileRoot, sessionId, action),
        );
        if (targets.filePaths.length === 0 && targets.dirPaths.length === 0) continue;
        operations.push({
          profileRoot,
          sessionId,
          action,
          ...targets,
        });
      }
    }

    return operations;
  });

  const executePlan = Effect.fnUntraced(function* (
    operations: ReadonlyArray<PlannedSessionOp>,
    betweenPages: Effect.Effect<void>,
  ) {
    if (operations.length === 0) return EMPTY_RETENTION_RESULT;

    // 1. OS-level open-file guard across all candidate DB/WAL/SHM paths.
    const allOpenCheckPaths = operations.flatMap((op) => op.openCheckPaths);
    const openPaths = yield* openFileProbe(allOpenCheckPaths);

    const closedOps: PlannedSessionOp[] = [];
    let skippedOpenSessions = 0;
    for (const op of operations) {
      const isOpen = op.openCheckPaths.some((filePath) => openPaths.has(filePath));
      if (isOpen) {
        skippedOpenSessions += 1;
        continue;
      }
      closedOps.push(op);
    }
    if (closedOps.length === 0) {
      return { ...EMPTY_RETENTION_RESULT, skippedOpenSessions };
    }

    // 2. Archive usage records for every candidate `.db` before deletion.
    const failedUsageDbs = new Set<string>();
    const dbOps = closedOps.filter(
      (op): op is PlannedSessionOp & { readonly dbPath: string } => op.dbPath !== undefined,
    );
    for (let start = 0; start < dbOps.length; start += USAGE_ARCHIVE_BATCH_SIZE) {
      const batch = dbOps.slice(start, start + USAGE_ARCHIVE_BATCH_SIZE);
      const batchPaths = batch.map((op) => op.dbPath);
      const readResult = yield* readAntigravityUsageFiles(batchPaths).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      );
      for (const errPath of readResult.errors) {
        failedUsageDbs.add(errPath);
        const canonical = yield* fs.realPath(errPath).pipe(Effect.orElseSucceed(() => errPath));
        failedUsageDbs.add(canonical);
      }
      if (readResult.files.length > 0) {
        const persisted = yield* usageArchiver(stateDir, readResult.files).pipe(
          Effect.catchCause(() => Effect.succeed(false)),
        );
        if (!persisted) {
          for (const op of batch) failedUsageDbs.add(op.dbPath);
        }
      }
      yield* betweenPages;
    }

    // 3. Delete verified sessions, yielding between items.
    let deletedSessions = 0;
    let prunedSettledSessions = 0;
    let removedSubagentSessions = 0;
    let removedOrphanSessions = 0;
    let skippedUsageErrorSessions = 0;
    let reclaimedBytes = 0;

    for (const op of closedOps) {
      if (op.dbPath !== undefined && failedUsageDbs.has(op.dbPath)) {
        skippedUsageErrorSessions += 1;
        continue;
      }
      let removedAny = false;
      for (const filePath of op.filePaths) {
        const size = yield* Effect.promise(() =>
          NodeFSP.lstat(filePath)
            .then((info) => (info.isFile() ? info.size : 0))
            .catch(() => 0),
        );
        const ok = yield* fs.remove(filePath, { force: true }).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        );
        if (ok) {
          reclaimedBytes += size;
          removedAny = true;
        }
      }
      for (const dirPath of op.dirPaths) {
        const size = yield* Effect.promise(() => measureTreeBytes(dirPath));
        const ok = yield* fs.remove(dirPath, { recursive: true, force: true }).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        );
        if (ok) {
          reclaimedBytes += size;
          removedAny = true;
        }
      }
      // Remove an empty brain/<id>/ folder after settled partial pruning if no user artifacts remain.
      if (op.action.kind === "settled-parent" && op.brainDirPath !== undefined) {
        yield* Effect.promise(() => NodeFSP.rmdir(op.brainDirPath!).catch(() => undefined));
      }
      if (removedAny) {
        if (op.action.kind === "settled-parent") {
          prunedSettledSessions += 1;
        } else if (op.action.category === "deleted") {
          deletedSessions += 1;
        } else if (op.action.category === "subagent") {
          removedSubagentSessions += 1;
        } else {
          removedOrphanSessions += 1;
        }
      }
      yield* Effect.yieldNow;
      yield* betweenPages;
    }

    return {
      deletedSessions,
      prunedSettledSessions,
      removedSubagentSessions,
      removedOrphanSessions,
      skippedOpenSessions,
      skippedUsageErrorSessions,
      reclaimedBytes,
    };
  });

  const pruneSessions = Effect.fn("AntigravitySessionRetention.pruneSessions")(
    function* (betweenPages: Effect.Effect<void> = Effect.void) {
      const operations = yield* planPass({
        isSessionLive: defaultLiveProbe,
        betweenPages,
      });
      return yield* executePlan(operations, betweenPages);
    },
    Effect.mapError(
      (cause) => new AntigravitySessionRetentionError({ operation: "prune sessions", cause }),
    ),
  );

  const purgeDeletedThread = Effect.fn("AntigravitySessionRetention.purgeDeletedThread")(
    function* (threadId: ThreadId, options?: { readonly isSessionLive?: LiveSessionCheck }) {
      const operations = yield* planPass({
        onlyThreadId: threadId,
        isSessionLive: options?.isSessionLive ?? defaultLiveProbe,
        betweenPages: Effect.void,
      });
      return yield* executePlan(operations, Effect.void);
    },
    Effect.mapError(
      (cause) => new AntigravitySessionRetentionError({ operation: "purge deleted thread", cause }),
    ),
  );

  const inspect = Effect.fn("AntigravitySessionRetention.inspect")(
    function* () {
      const operations = yield* planPass({
        isSessionLive: defaultLiveProbe,
        betweenPages: Effect.void,
      });
      if (operations.length === 0) return EMPTY_INSPECTION;
      const openPaths = yield* openFileProbe(operations.flatMap((op) => op.openCheckPaths));
      let deletedSessions = 0;
      let settledSessions = 0;
      let subagentSessions = 0;
      let orphanSessions = 0;
      let reclaimableBytes = 0;
      for (const op of operations) {
        if (op.openCheckPaths.some((filePath) => openPaths.has(filePath))) continue;
        for (const filePath of op.filePaths) {
          reclaimableBytes += yield* Effect.promise(() =>
            NodeFSP.lstat(filePath)
              .then((info) => (info.isFile() ? info.size : 0))
              .catch(() => 0),
          );
        }
        for (const dirPath of op.dirPaths) {
          reclaimableBytes += yield* Effect.promise(() => measureTreeBytes(dirPath));
        }
        if (op.action.kind === "settled-parent") settledSessions += 1;
        else if (op.action.category === "deleted") deletedSessions += 1;
        else if (op.action.category === "subagent") subagentSessions += 1;
        else orphanSessions += 1;
      }
      return {
        prunableSessions: deletedSessions + settledSessions + subagentSessions + orphanSessions,
        deletedSessions,
        settledSessions,
        subagentSessions,
        orphanSessions,
        reclaimableBytes,
      };
    },
    Effect.mapError(
      (cause) => new AntigravitySessionRetentionError({ operation: "inspect sessions", cause }),
    ),
  );

  return { pruneSessions, purgeDeletedThread, inspect } satisfies AntigravitySessionRetentionShape;
});

export const layer = Layer.effect(
  AntigravitySessionRetention,
  Effect.flatMap(ServerConfig.ServerConfig, (config) => makeForStateDir(config.stateDir)),
);

/** Live-server archiver backed by the singleton `UsageService`. */
export const layerLiveUsageArchiver = Layer.effect(
  UsageArchiver,
  Effect.gen(function* () {
    const usage = yield* UsageService.UsageService;
    return (_stateDir, files) => usage.archiveScannedFiles("antigravity", files);
  }),
);

/** Offline archiver for CLI maintenance (`t3 doctor`) when no server is running. */
export const layerOfflineUsageArchiver = Layer.effect(
  UsageArchiver,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return (stateDir, files) =>
      UsageService.archiveScannedFilesOffline({
        stateDir,
        provider: "antigravity",
        files,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      );
  }),
);

const withOfflineRetention = Effect.fn("AntigravitySessionRetention.withOfflineRetention")(
  function* <A>(
    databasePath: string,
    _operation: string,
    run: (
      service: AntigravitySessionRetentionShape,
    ) => Effect.Effect<A, AntigravitySessionRetentionError>,
  ) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const stateDir = path.dirname(databasePath);
    if (!(yield* fs.exists(databasePath))) return undefined;
    if (!(yield* fs.exists(path.join(stateDir, "providers", "antigravity")))) return undefined;
    const offlineLayer = Layer.effect(AntigravitySessionRetention, makeForStateDir(stateDir)).pipe(
      Layer.provide(layerOfflineUsageArchiver),
      Layer.provide(NodeSqliteClient.layer({ filename: databasePath, readonly: true })),
    );
    return yield* AntigravitySessionRetention.pipe(
      Effect.flatMap(run),
      Effect.provide(offlineLayer),
    );
  },
  (effect, _databasePath, operation) =>
    effect.pipe(
      Effect.mapError((cause) =>
        cause._tag === "AntigravitySessionRetentionError"
          ? cause
          : new AntigravitySessionRetentionError({ operation, cause }),
      ),
    ),
);

/** Read-only inspection for `t3 doctor`. Returns empty counts when no Antigravity data exists. */
export const inspectAntigravitySessionsOffline = Effect.fn(
  "AntigravitySessionRetention.inspectAntigravitySessionsOffline",
)(function* (databasePath: string) {
  const result = yield* withOfflineRetention(databasePath, "inspect offline", (service) =>
    service.inspect(),
  ).pipe(Effect.catchCause(() => Effect.undefined));
  return result ?? EMPTY_INSPECTION;
});

/** Offline pruning pass for `t3 doctor` (must be called while the server is stopped and locked). */
export const pruneAntigravitySessionsOffline = Effect.fn(
  "AntigravitySessionRetention.pruneAntigravitySessionsOffline",
)(function* (databasePath: string) {
  const result = yield* withOfflineRetention(databasePath, "prune offline", (service) =>
    service.pruneSessions(),
  );
  return result ?? EMPTY_RETENTION_RESULT;
});
