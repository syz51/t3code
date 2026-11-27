// @effect-diagnostics nodeBuiltinImport:off -- Effect's File.Info has no ctime, and worker threads keep SQLite off the event loop.
import * as NodeFSP from "node:fs/promises";
import * as NodeWorkerThreads from "node:worker_threads";
import { pipe } from "effect/Function";

import type { UsageRecord } from "@t3tools/provider-core/server/usage";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

type FieldValue = number | bigint | Uint8Array;
type Fields = Map<number, FieldValue[]>;

function fields(bytes: Uint8Array): Fields {
  let offset = 0;
  const result: Fields = new Map();
  const varint = () => {
    let value = 0n;
    for (let shift = 0n; shift < 70n; shift += 7n) {
      const byte = bytes[offset++];
      if (byte === undefined || (shift === 63n && byte > 1)) {
        throw new Error("Invalid Antigravity protobuf varint");
      }
      value |= BigInt(byte & 127) << shift;
      if (byte < 128) {
        return value > BigInt(Number.MAX_SAFE_INTEGER) ? value : Number(value);
      }
    }
    throw new Error("Invalid Antigravity protobuf varint");
  };
  while (offset < bytes.length) {
    const tag = varint();
    if (typeof tag !== "number") throw new Error("Invalid protobuf field");
    const number = Math.floor(tag / 8);
    const wire = tag % 8;
    if (number === 0) throw new Error("Invalid protobuf field");
    let value: FieldValue;
    if (wire === 0) {
      value = varint();
    } else if (wire === 1 || wire === 5 || wire === 2) {
      const length = wire === 2 ? varint() : wire === 1 ? 8 : 4;
      if (typeof length !== "number") throw new Error("Invalid protobuf field length");
      if (length > bytes.length - offset) throw new Error("Truncated protobuf field");
      value = bytes.subarray(offset, offset + length);
      offset += length;
      if (wire !== 2) continue;
    } else {
      throw new Error("Unsupported protobuf wire type");
    }
    const entries = result.get(number) ?? [];
    entries.push(value);
    result.set(number, entries);
  }
  return result;
}

const numberAt = (value: Fields, key: number) => {
  const entry = value.get(key)?.[0];
  return typeof entry === "number" ? entry : 0;
};
const bytesAt = (value: Fields, key: number) => {
  const entry = value.get(key)?.[0];
  return entry instanceof Uint8Array ? entry : undefined;
};
const nested = (value: Fields, key: number) => {
  const bytes = bytesAt(value, key);
  return bytes === undefined ? new Map<number, FieldValue[]>() : fields(bytes);
};
const textAt = (value: Fields, key: number) => {
  const bytes = bytesAt(value, key);
  return bytes === undefined ? "" : new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
};
const timestamp = (value: Fields) => {
  const seconds = numberAt(value, 1);
  return seconds > 0 ? seconds * 1000 + Math.floor(numberAt(value, 2) / 1_000_000) : null;
};

// Offline fallback for records without names. New names are learned from the scanned metadata.
// Cross-checked against ccusage's Antigravity parser and mrexodia/agent-cost-dashboard.
const MODEL_IDS: Record<number, string> = {
  246: "gemini-2.5-pro",
  312: "gemini-2.5-flash",
  313: "gemini-2.5-flash-thinking",
  329: "gemini-2.5-flash-thinking",
  330: "gemini-2.5-flash-lite",
  281: "claude-sonnet-4",
  282: "claude-sonnet-4",
  290: "claude-opus-4",
  291: "claude-opus-4",
  333: "claude-sonnet-4-5",
  334: "claude-sonnet-4-5",
  340: "claude-haiku-4-5",
  341: "claude-haiku-4-5",
  342: "gpt-oss-120b-medium",
  1026: "claude-opus-4-6",
  1035: "claude-sonnet-4-6",
  1016: "gemini-3.1-pro",
  1036: "gemini-3.1-pro",
  1037: "gemini-3.1-pro",
  1018: "gemini-3-flash-preview",
  1084: "gemini-3-flash-preview",
  1047: "gemini-3-flash-preview",
  1020: "gemini-3.5-flash-medium",
  1021: "gemini-3.1-flash-image",
  1050: "gemini-3.1-flash-lite",
  1071: "gemini-3.6-flash-high",
  1072: "gemini-3.6-flash-medium",
  1073: "gemini-3.6-flash-low",
  1132: "gemini-3.5-flash-high",
  1133: "gemini-3.5-flash-high",
  1187: "gemini-3.5-flash-extra-low",
  1196: "gemini-3.6-flash",
  1266: "gemini-3.6-flash",
  1298: "gemini-3.7-flash-high",
  1299: "gemini-3.7-flash-medium",
  1300: "gemini-3.7-flash-low",
  1301: "gemini-3.7-flash-tiered",
  1318: "gemini-3.8-flash-high",
  1319: "gemini-3.8-flash-medium",
  1320: "gemini-3.8-flash-low",
  1322: "gemini-3.8-flash-tiered",
  1402: "claude-opus-5-5",
  1417: "gemini-4-argon",
  1418: "gemini-4-argon",
  1419: "gemini-4-argon",
  1427: "gemini-4-carbon",
  1437: "gemini-4-carbon",
  1525: "gemini-4-hydrogen",
  1526: "gemini-4-hydrogen",
  1527: "gemini-4-hydrogen",
  1532: "gemini-4-neon",
  1533: "gemini-4-neon",
  1534: "gemini-4-neon",
  1535: "gemini-4-neon",
  1536: "gemini-4-neon",
  1537: "gemini-pro-orchestrator-neon",
  1667: "gemini-pro-orchestrator",
  1669: "gemini-4-hydrogen-orchestrator",
};

// Effort and routing variants share the base model's price.
export const antigravityRateModel = (model: string) => {
  const base = model.replace(
    /(?:-(?:extra-low|low|medium|high|xhigh|tiered|control|thinking|agent|orchestrator|trial|n|r))+$/,
    "",
  );
  return /^gemini-3-flash-(?:agent(?:-[ab])?|[ab])$/.test(model) ||
    /^gemini-3-flash-(?:agent-)?[ab]$/.test(base)
    ? "gemini-3.5-flash"
    : base === "gemini-3.7-flash-safety-le"
      ? "gemini-3.7-flash"
      : base === "gemini-pro-orchestrator-neon"
        ? "gemini-4-neon"
        : base === "gemini-pro-orchestrator-g1-pro" || base === "gemini-pro-orchestrator-argon"
          ? "gemini-4-argon"
          : model === "gemini-pro-orchestrator"
            ? "gemini-4-carbon"
            : base === "gemini-3-flash"
              ? "gemini-3-flash-preview"
              : base;
};

function withRateModel(record: UsageRecord): UsageRecord {
  const rateModel = antigravityRateModel(record.model);
  return rateModel === record.model ? record : { ...record, rateModel };
}

function modelName(name: string): string {
  if (name) {
    const normalized = name
      .toLowerCase()
      .replace(/\s*\(([^)]*)\)\s*$/, "-$1")
      .replace(/\s+/g, "-");
    if (normalized.startsWith("claude-")) {
      return normalized
        .replace(/^claude-(\d+(?:\.\d+)?)-(sonnet|opus|haiku)/, "claude-$2-$1")
        .replaceAll(".", "-");
    }
    return normalized;
  }
  return "";
}

function isConcreteModel(model: string): boolean {
  return (
    /^(?:gemini-\d|claude-(?:sonnet|opus|haiku)-\d|gpt-)/.test(model) &&
    !/^gemini-3-flash-(?:agent(?:-[ab])?|[ab])$/.test(model)
  );
}

interface LearnedModel {
  readonly model: string;
  readonly fromSlug: boolean;
}

function rememberModel(
  models: Map<number, LearnedModel | null>,
  id: number,
  entry: LearnedModel | null,
) {
  const previous = models.get(id);
  if (previous === undefined) {
    models.set(id, entry);
    return;
  }
  if (previous === null || entry === null) {
    models.set(id, null);
    return;
  }
  if (previous.model === entry.model) {
    if (!previous.fromSlug && entry.fromSlug) {
      models.set(id, { model: previous.model, fromSlug: true });
    }
    return;
  }
  // Generations for one numeric ID can omit the slug and fall back to a display name with effort.
  const base = antigravityRateModel(previous.model);
  models.set(
    id,
    base === antigravityRateModel(entry.model)
      ? { model: base, fromSlug: previous.fromSlug || entry.fromSlug }
      : null,
  );
}

const MODEL_QUALITY = {
  none: 0,
  nonConcrete: 1,
  borrowedDisplay: 2,
  borrowedSlug: 3,
  fallbackId: 4,
  ownDisplay: 5,
  learned: 6,
  ownSlug: 7,
} as const;

interface Metadata {
  model: string;
  modelFromSlug: boolean;
  modelId: number;
  timestampMs: number | null;
  usages: Fields[];
}

function metadata(bytes: Uint8Array, step: boolean): Metadata {
  const root = fields(bytes);
  if (!step && bytesAt(root, 1) === undefined) {
    throw new Error("Missing Antigravity generation metadata");
  }
  const data = step ? root : nested(root, 1);
  const model = step ? nested(data, 24) : data;
  const usage = bytesAt(data, step ? 9 : 4);
  // Copy the usage bytes: subarrays kept in usages would hold each row's whole blob alive.
  const primaryUsage = usage === undefined ? undefined : fields(usage.slice());
  const usages = primaryUsage === undefined ? [] : [primaryUsage];
  for (const retry of data.get(step ? 28 : 17) ?? []) {
    if (!(retry instanceof Uint8Array)) throw new Error("Invalid retry metadata");
    const retryUsage = bytesAt(fields(retry), 2);
    if (retryUsage !== undefined) usages.push(fields(retryUsage.slice()));
  }
  const slug = modelName(textAt(model, step ? 12 : 19));
  const display = modelName(textAt(model, step ? 8 : 21));
  const modelFromSlug = isConcreteModel(slug);
  return {
    model: modelFromSlug
      ? slug
      : isConcreteModel(display)
        ? display
        : ([slug, display].find((name) => name && !/^model[_-]/.test(name)) ?? ""),
    modelFromSlug,
    modelId:
      numberAt(model, step ? 1 : 3) || (primaryUsage === undefined ? 0 : numberAt(primaryUsage, 1)),
    timestampMs: step
      ? (timestamp(nested(data, 8)) ?? timestamp(nested(data, 1)))
      : timestamp(nested(nested(data, 9), 4)),
    usages,
  };
}

function blob(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new Error("Invalid Antigravity metadata blob");
  return value;
}

interface UsageCandidate {
  record: UsageRecord;
  modelId: number;
  modelQuality: number;
  keys: readonly string[];
  timestampQuality: number;
}

class AntigravityDatabaseDecodeError extends Schema.TaggedError<AntigravityDatabaseDecodeError>()(
  "AntigravityDatabaseDecodeError",
  { path: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return `Antigravity usage could not be decoded from ${this.path}.`;
  }
}

/** Generation rows can hold megabytes of context; read one at a time to bound peak transfer size. */
const GENERATION_PAGE_ROWS = 1;
const STEP_PAGE_ROWS = 64;

// Inline worker source runs from bundles and SEA builds without module files.
const sqliteReaderWorkerSource = `
const { parentPort } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
let db;
const closeDb = () => {
  if (db === undefined) return;
  const current = db;
  db = undefined;
  try { current.exec("COMMIT"); } catch {}
  try { current.close(); } catch {}
};
parentPort.on("message", (request) => {
  if (request.type === "shutdown") {
    closeDb();
    parentPort.close();
    return;
  }
  const { id } = request;
  try {
    if (request.type === "open") {
      closeDb();
      const next = new DatabaseSync(request.filename, { readOnly: true, allowExtension: false });
      try {
        next.exec("PRAGMA busy_timeout = 100");
        next.exec("BEGIN");
      } catch (error) {
        try { next.close(); } catch {}
        throw error;
      }
      db = next;
      parentPort.postMessage({ id, rows: [] });
      return;
    }
    if (request.type === "close") {
      closeDb();
      parentPort.postMessage({ id, rows: [] });
      return;
    }
    if (request.type === "all") {
      if (db === undefined) throw new Error("SQLite reader has no open database");
      const rows = db.prepare(request.sql).all(...(request.params ?? []));
      parentPort.postMessage({ id, rows });
      return;
    }
    throw new Error("Unsupported SQLite reader request");
  } catch (error) {
    parentPort.postMessage({ id, error: String(error && error.message ? error.message : error) });
  }
});
`;

interface SqliteReaderWorker {
  readonly open: (filename: string) => Effect.Effect<void, AntigravityDatabaseDecodeError>;
  readonly all: <Row>(
    filename: string,
    sql: string,
    params?: ReadonlyArray<unknown>,
  ) => Effect.Effect<ReadonlyArray<Row>, AntigravityDatabaseDecodeError>;
  readonly close: (filename: string) => Effect.Effect<void>;
}

interface ActiveWorker {
  readonly worker: NodeWorkerThreads.Worker;
  readonly pending: Map<
    number,
    {
      readonly resolve: (rows: ReadonlyArray<unknown>) => void;
      readonly reject: (error: Error) => void;
    }
  >;
}

const makeSqliteReaderWorker = Effect.gen(function* () {
  let current: ActiveWorker | undefined;
  let nextId = 0;

  const ensureWorker = (): ActiveWorker => {
    if (current !== undefined) return current;
    const worker = new NodeWorkerThreads.Worker(sqliteReaderWorkerSource, { eval: true });
    const entry: ActiveWorker = { worker, pending: new Map() };
    const fail = (message: string) => {
      if (current === entry) current = undefined;
      for (const request of entry.pending.values()) request.reject(new Error(message));
      entry.pending.clear();
    };
    worker.unref();
    worker.on(
      "message",
      (reply: {
        readonly id: number;
        readonly rows?: ReadonlyArray<unknown>;
        readonly error?: string;
      }) => {
        const request = entry.pending.get(reply.id);
        if (request === undefined) return;
        entry.pending.delete(reply.id);
        if (entry.pending.size === 0) worker.unref();
        if (reply.error !== undefined) request.reject(new Error(reply.error));
        else request.resolve(reply.rows ?? []);
      },
    );
    worker.on("error", (cause) => {
      fail(`Antigravity SQLite reader failed: ${cause.message}`);
      void worker.terminate();
    });
    worker.on("exit", (code) => {
      fail(`Antigravity SQLite reader exited with code ${code}`);
    });
    current = entry;
    return entry;
  };

  yield* Effect.addFinalizer(() =>
    Effect.promise(async () => {
      const active = current;
      current = undefined;
      if (active === undefined) return;
      try {
        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node workers do not accept a target origin.
        active.worker.postMessage({ type: "shutdown" });
      } catch {}
      await active.worker.terminate();
    }),
  );

  const send = (filename: string, payload: Record<string, unknown>) =>
    Effect.tryPromise({
      try: () =>
        new Promise<ReadonlyArray<unknown>>((resolve, reject) => {
          const active = ensureWorker();
          const id = ++nextId;
          active.pending.set(id, { resolve, reject });
          if (active.pending.size === 1) active.worker.ref();
          // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node workers do not accept a target origin.
          active.worker.postMessage({ id, ...payload });
        }),
      catch: (cause) => new AntigravityDatabaseDecodeError({ path: filename, cause }),
    });

  return {
    open: (filename) => send(filename, { type: "open", filename }).pipe(Effect.asVoid),
    all: <Row>(filename: string, sql: string, params: ReadonlyArray<unknown> = []) =>
      send(filename, { type: "all", sql, params }) as Effect.Effect<
        ReadonlyArray<Row>,
        AntigravityDatabaseDecodeError
      >,
    close: (filename) =>
      Effect.suspend(() =>
        current === undefined
          ? Effect.void
          : send(filename, { type: "close" }).pipe(Effect.asVoid, Effect.ignore),
      ),
  } satisfies SqliteReaderWorker;
});

const readDatabase = Effect.fn("readDatabase")(function* (
  reader: SqliteReaderWorker,
  path: string,
  sessionId: string,
  fallbackTimestamp: number,
) {
  const decode = <A>(evaluate: () => A) =>
    Effect.try({
      try: evaluate,
      catch: (cause) => new AntigravityDatabaseDecodeError({ path, cause }),
    });
  yield* reader.open(path);
  return yield* Effect.gen(function* () {
    const tables = new Set(
      (yield* reader.all<{ readonly name: unknown }>(
        path,
        "SELECT name FROM sqlite_master WHERE type = 'table'",
      )).map((row) => row.name),
    );
    // Not a conversation store, e.g. agy's conversation_summaries.db index.
    if (!tables.has("gen_metadata") && !tables.has("steps")) return null;
    // Seek by rowid regardless of indexes; idx normally aliases rowid, but sort for layouts where it does not.
    const readMetadata = Effect.fnUntraced(function* (
      query: string,
      pageRows: number,
      step: boolean,
    ) {
      const entries: Array<{ idx: number; entry: Metadata }> = [];
      let after = -Infinity;
      while (true) {
        const rows = yield* reader.all<{
          readonly row_id: number;
          readonly idx: unknown;
          readonly data: unknown;
        }>(path, query, [after, pageRows]);
        for (const row of rows) {
          // Filter outside SQL to bound scans to one page, including rows without metadata.
          if (step && row.data === null) continue;
          const idx = row.idx;
          if (typeof idx !== "number") {
            return yield* new AntigravityDatabaseDecodeError({ path });
          }
          entries.push({ idx, entry: yield* decode(() => metadata(blob(row.data), step)) });
        }
        if (rows.length < pageRows) break;
        after = rows[rows.length - 1]!.row_id;
        yield* Effect.yieldNow;
      }
      return entries.sort((a, b) => a.idx - b.idx);
    });
    const generations = tables.has("gen_metadata")
      ? yield* readMetadata(
          "SELECT rowid AS row_id, idx, data FROM gen_metadata WHERE rowid > ? ORDER BY rowid LIMIT ?",
          GENERATION_PAGE_ROWS,
          false,
        )
      : [];
    let trajectoryTimestamp: number | null = null;
    if (tables.has("trajectory_metadata_blob")) {
      for (const row of yield* reader.all<{ readonly data: unknown }>(
        path,
        "SELECT data FROM trajectory_metadata_blob",
      )) {
        trajectoryTimestamp ??= yield* decode(() =>
          pipe(blob(row.data), fields, (message) => nested(message, 2), timestamp),
        );
      }
    }
    const steps = tables.has("steps")
      ? yield* readMetadata(
          "SELECT rowid AS row_id, idx, metadata AS data FROM steps WHERE rowid > ? ORDER BY rowid LIMIT ?",
          STEP_PAGE_ROWS,
          true,
        )
      : [];
    return yield* decode(() => {
      const models = new Map<number, LearnedModel | null>();
      for (const { entry } of [...generations, ...steps]) {
        if (entry.modelId > 0 && isConcreteModel(entry.model))
          rememberModel(models, entry.modelId, {
            model: entry.model,
            fromSlug: entry.modelFromSlug,
          });
      }
      return {
        candidates: usageCandidates(
          sessionId,
          generations,
          steps,
          trajectoryTimestamp,
          fallbackTimestamp,
        ),
        models,
      };
    });
  }).pipe(Effect.ensuring(reader.close(path)));
});

function usageCandidates(
  sessionId: string,
  generations: ReadonlyArray<{ idx: number; entry: Metadata }>,
  steps: ReadonlyArray<{ idx: number; entry: Metadata }>,
  trajectoryTimestamp: number | null,
  fallbackTimestamp: number,
): UsageCandidate[] {
  const records: UsageCandidate[] = [];
  const generationModels = new Map(generations.map(({ idx, entry }) => [idx, entry]));
  for (const [source, entries] of [
    ["step", steps],
    ["generation", generations],
  ] as const) {
    for (const [index, { idx, entry }] of entries.entries()) {
      for (const [usageIndex, usage] of entry.usages.entries()) {
        const modelId = numberAt(usage, 1) || entry.modelId;
        const generation = source === "step" ? generationModels.get(idx) : undefined;
        // A retry can use a different model than its enclosing generation or step.
        const matches = (metadata: Metadata) => modelId === 0 || metadata.modelId === modelId;
        const ownMatch = matches(entry) && entry.model ? entry : undefined;
        const borrowedMatch =
          ownMatch === undefined && generation && matches(generation) && generation.model
            ? generation
            : undefined;
        const matched = ownMatch ?? borrowedMatch;
        const model = matched?.model ?? "";
        const modelQuality =
          matched === undefined
            ? MODEL_QUALITY.none
            : !isConcreteModel(model)
              ? MODEL_QUALITY.nonConcrete
              : ownMatch !== undefined
                ? matched.modelFromSlug
                  ? MODEL_QUALITY.ownSlug
                  : MODEL_QUALITY.ownDisplay
                : matched.modelFromSlug
                  ? MODEL_QUALITY.borrowedSlug
                  : MODEL_QUALITY.borrowedDisplay;
        const outputTokens = Math.max(numberAt(usage, 3), numberAt(usage, 9) + numberAt(usage, 10));
        const totals = {
          uncachedInputTokens: numberAt(usage, 2),
          cachedInputTokens: numberAt(usage, 5),
          cacheCreationTokens: numberAt(usage, 4),
          outputTokens,
          reasoningTokens: Math.min(outputTokens, numberAt(usage, 9)),
        };
        if (
          totals.uncachedInputTokens +
            totals.cachedInputTokens +
            totals.cacheCreationTokens +
            outputTokens ===
          0
        )
          continue;
        const keys = ([11, 12, 7] as const).flatMap((key) => {
          const id = textAt(usage, key);
          return id ? [`antigravity:${key}:${id}`] : [];
        });
        const record: UsageRecord = {
          provider: "antigravity",
          sessionId,
          timestampMs: entry.timestampMs ?? trajectoryTimestamp ?? fallbackTimestamp,
          model,
          totals,
          reportedCostUsd: null,
          speed: "standard",
          dedupeKey: keys[0] ?? `antigravity:${sessionId}:${source}:${index}:${usageIndex}`,
        };
        records.push({
          record,
          modelId,
          modelQuality,
          keys,
          timestampQuality: entry.timestampMs !== null ? 2 : trajectoryTimestamp !== null ? 1 : 0,
        });
      }
    }
  }
  return records;
}

interface CachedDatabase {
  readonly fingerprint: string;
  readonly data: Effect.Success<ReturnType<typeof readDatabase>>;
}

/** Fingerprint canonical DB/WAL paths by size, mtime and ctime; WAL holds new rows, and ctime catches restored mtimes. */
export const makeAntigravityUsageCache = () => new Map<string, CachedDatabase>();

const resolveAntigravityUsageCandidates = Effect.fnUntraced(function* <
  Entry extends { records: UsageRecord[] },
>(
  files: ReadonlyArray<Entry>,
  pending: ReadonlyArray<{ data: NonNullable<CachedDatabase["data"]>; fileIndex: number }>,
  models: ReadonlyMap<number, LearnedModel | null>,
  sinceMs: number,
) {
  const identities = new Map<string, number>();
  const groups: Array<
    UsageCandidate & { parent: number; size: number; owner: number; fileIndex: number }
  > = [];
  const find = (index: number): number => {
    let root = index;
    while (groups[root]!.parent !== root) root = groups[root]!.parent;
    while (index !== root) {
      const parent = groups[index]!.parent;
      groups[index]!.parent = root;
      index = parent;
    }
    return root;
  };
  const merge = (left: number, right: number): number => {
    let a = find(left);
    let b = find(right);
    if (a === b) return a;
    if (groups[a]!.size < groups[b]!.size) [a, b] = [b, a];
    const target = groups[a]!;
    const source = groups[b]!;
    const first = target.owner < source.owner ? target : source;
    const bestModel =
      source.modelQuality === target.modelQuality
        ? first
        : source.modelQuality > target.modelQuality
          ? source
          : target;
    const bestTime =
      source.timestampQuality > target.timestampQuality ||
      (source.timestampQuality === target.timestampQuality &&
        source.record.timestampMs < target.record.timestampMs)
        ? source
        : target;
    const x = target.record.totals;
    const y = source.record.totals;
    target.record = {
      ...first.record,
      model: bestModel.record.model,
      timestampMs: bestTime.record.timestampMs,
      totals: {
        uncachedInputTokens: Math.max(x.uncachedInputTokens, y.uncachedInputTokens),
        cachedInputTokens: Math.max(x.cachedInputTokens, y.cachedInputTokens),
        cacheCreationTokens: Math.max(x.cacheCreationTokens, y.cacheCreationTokens),
        outputTokens: Math.max(x.outputTokens, y.outputTokens),
        reasoningTokens: Math.max(x.reasoningTokens, y.reasoningTokens),
      },
    };
    target.timestampQuality = bestTime.timestampQuality;
    target.modelQuality = bestModel.modelQuality;
    target.owner = first.owner;
    target.fileIndex = first.fileIndex;
    target.size += source.size;
    source.parent = a;
    return a;
  };
  const append = (candidate: UsageCandidate, fileIndex: number) => {
    const index = groups.length;
    groups.push({ ...candidate, parent: index, size: 1, owner: index, fileIndex });
    for (const key of candidate.keys) {
      const existing = identities.get(key);
      if (existing !== undefined) merge(index, existing);
      identities.set(key, index);
    }
  };
  for (const { data, fileIndex } of pending) {
    for (const [index, candidate] of data.candidates.entries()) {
      const learned = models.get(candidate.modelId);
      const fallback = learned === null ? undefined : MODEL_IDS[candidate.modelId];
      // Prefer the base MODEL_IDS slug when learned metadata only saw an effort display name.
      const canonicalLearned =
        learned && !learned.fromSlug && fallback && antigravityRateModel(learned.model) === fallback
          ? fallback
          : learned?.model;
      const [model, modelQuality] =
        candidate.modelQuality === MODEL_QUALITY.ownSlug
          ? [candidate.record.model, candidate.modelQuality]
          : canonicalLearned
            ? [canonicalLearned, MODEL_QUALITY.learned]
            : candidate.modelQuality === MODEL_QUALITY.ownDisplay
              ? [candidate.record.model, candidate.modelQuality]
              : fallback
                ? [fallback, MODEL_QUALITY.fallbackId]
                : candidate.modelQuality >= MODEL_QUALITY.borrowedDisplay
                  ? [candidate.record.model, candidate.modelQuality]
                  : candidate.record.model
                    ? [candidate.record.model, candidate.modelQuality]
                    : [
                        candidate.modelId > 0
                          ? `antigravity-model-${candidate.modelId}`
                          : "antigravity-unknown",
                        MODEL_QUALITY.none,
                      ];
      append(
        {
          ...candidate,
          record: { ...candidate.record, model },
          modelQuality,
        },
        fileIndex,
      );
      if (index % 256 === 255) yield* Effect.yieldNow;
    }
  }
  for (const [index, group] of groups.entries()) {
    if (group.parent === index && group.record.timestampMs >= sinceMs) {
      files[group.fileIndex]!.records.push(withRateModel(group.record));
    }
  }
});

export interface AntigravityUsageFileEntry {
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
  readonly records: readonly UsageRecord[];
}

/** Reads usage records for an explicit list of Antigravity `.db` files off the event loop. */
export const readAntigravityUsageFiles = Effect.fn("readAntigravityUsageFiles")(function* (
  dbPaths: readonly string[],
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const files: Array<{ path: string; size: number; mtimeMs: number; records: UsageRecord[] }> = [];
  const errors: string[] = [];
  const models = new Map<number, LearnedModel | null>();
  const pending: Array<{ data: NonNullable<CachedDatabase["data"]>; fileIndex: number }> = [];
  const visited = new Set<string>();
  const reader = yield* makeSqliteReaderWorker;

  for (const dbPath of dbPaths) {
    const canonical = yield* fileSystem.realPath(dbPath).pipe(
      Effect.catchTags({
        PlatformError: (cause) => {
          if (cause.reason._tag !== "NotFound") errors.push(dbPath);
          return Effect.succeed(null);
        },
      }),
    );
    if (canonical === null || visited.has(canonical)) continue;
    visited.add(canonical);
    const stat = yield* Effect.tryPromise({
      try: () => NodeFSP.stat(canonical),
      catch: (cause) => new AntigravityDatabaseDecodeError({ path: canonical, cause }),
    }).pipe(
      Effect.catch(() => {
        errors.push(canonical);
        return Effect.succeed(null);
      }),
    );
    if (stat === null) continue;
    const walStat = yield* Effect.tryPromise({
      try: () => NodeFSP.stat(`${canonical}-wal`),
      catch: () => undefined,
    }).pipe(Effect.orElseSucceed(() => undefined));
    const mtimeMs = Math.max(stat.mtimeMs, walStat?.mtimeMs ?? 0);
    const data = yield* readDatabase(
      reader,
      canonical,
      pathService.basename(canonical, ".db"),
      mtimeMs,
    ).pipe(
      Effect.catch(() => {
        errors.push(canonical);
        return Effect.succeed("failed" as const);
      }),
    );
    if (data === "failed") continue;
    const fileIndex = files.length;
    files.push({ path: canonical, size: stat.size, mtimeMs, records: [] });
    if (data !== null) {
      for (const [id, model] of data.models) {
        rememberModel(models, id, model);
      }
      pending.push({ data, fileIndex });
    }
  }

  yield* resolveAntigravityUsageCandidates(files, pending, models, 0);
  const finalized: ReadonlyArray<AntigravityUsageFileEntry> = files.map((file) => {
    const latestRecordMs = file.records.reduce(
      (max, record) => Math.max(max, record.timestampMs),
      0,
    );
    return {
      ...file,
      mtimeMs: Math.max(file.mtimeMs, latestRecordMs),
    };
  });
  return { files: finalized, errors };
}, Effect.scoped);

export const readAntigravityUsage = Effect.fn("readAntigravityUsage")(function* (
  conversationsDirectories: string | readonly string[],
  sinceMs: number,
  cache?: Map<string, CachedDatabase>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const roots =
    typeof conversationsDirectories === "string"
      ? [conversationsDirectories]
      : conversationsDirectories;
  const files: Array<{ root: string; path: string; records: UsageRecord[] }> = [];
  const errors: string[] = [];
  const models = new Map<number, LearnedModel | null>();
  const pending: Array<{ data: NonNullable<CachedDatabase["data"]>; fileIndex: number }> = [];
  const visited = new Set<string>();
  const reader = yield* makeSqliteReaderWorker;
  const readFile = Effect.fn("readAntigravityUsage.readFile")(function* (path: string) {
    const canonical = yield* fileSystem.realPath(path);
    if (visited.has(canonical)) return null;
    visited.add(canonical);
    const fingerprintOf = (file: string) =>
      Effect.tryPromise({
        try: () => NodeFSP.stat(file),
        catch: (cause) => new AntigravityDatabaseDecodeError({ path: file, cause }),
      }).pipe(
        Effect.map((stat) => ({ stat, part: `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}` })),
      );
    const { stat, part } = yield* fingerprintOf(path);
    const wal = yield* fingerprintOf(`${path}-wal`).pipe(Effect.option);
    const fingerprint = `${part}/${wal._tag === "Some" ? wal.value.part : "-"}`;
    const cached = cache?.get(canonical);
    if (cached?.fingerprint === fingerprint) return cached.data;
    const data = yield* readDatabase(reader, path, pathService.basename(path, ".db"), stat.mtimeMs);
    cache?.set(canonical, { fingerprint, data });
    return data;
  });
  const walk = Effect.fn("antigravityUsageReader.walk")(function* (
    directory: string,
    root: string,
  ): Effect.fn.Return<void> {
    const names = yield* fileSystem.readDirectory(directory).pipe(
      Effect.catchTags({
        PlatformError: (cause) => {
          if (cause.reason._tag !== "NotFound") errors.push(directory);
          return Effect.succeed(null);
        },
      }),
    );
    if (names === null) return;
    names.sort((a, b) => a.localeCompare(b));
    for (const name of names) {
      const path = pathService.join(directory, name);
      // Like a directory listing's entry types: symlinks are neither files nor directories.
      const isLink = Exit.isSuccess(yield* Effect.exit(fileSystem.readLink(path)));
      const type = isLink
        ? "SymbolicLink"
        : yield* fileSystem.stat(path).pipe(
            Effect.map((info) => info.type),
            Effect.orElseSucceed(() => null),
          );
      if (type === "Directory") {
        yield* walk(path, root);
      } else if ((type === "File" || type === null) && name.endsWith(".db")) {
        const data = yield* readFile(path).pipe(
          Effect.catch(() => {
            errors.push(path);
            return Effect.succeed(null);
          }),
        );
        if (data === null) continue;
        for (const [id, model] of data.models) {
          rememberModel(models, id, model);
        }
        const fileIndex = files.length;
        files.push({ root, path, records: [] });
        pending.push({ data, fileIndex });
      }
    }
  });
  for (const root of roots) yield* walk(root, root);
  if (cache !== undefined) {
    for (const key of cache.keys()) if (!visited.has(key)) cache.delete(key);
  }
  yield* resolveAntigravityUsageCandidates(files, pending, models, sinceMs);
  return { files, errors };
}, Effect.scoped);
