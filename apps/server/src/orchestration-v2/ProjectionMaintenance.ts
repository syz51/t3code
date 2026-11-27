import type { ThreadId } from "@t3tools/contracts";
import { MCP_APP_OUTPUT_KEY } from "@t3tools/shared/mcpApp";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { compactDynamicToolOutput, compactT3McpToolOutput } from "@t3tools/shared/toolOutput";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";

import {
  EVENT_LOG_PRUNE_MARK,
  EVENT_LOG_PRUNED_THROUGH,
} from "../persistence/OrchestrationEventStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

export class ProjectionMaintenanceError extends Schema.TaggedError<ProjectionMaintenanceError>()(
  "ProjectionMaintenanceError",
  {
    operation: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export interface ProjectionMaintenanceV2Shape {
  /**
   * Deletes events the projections already cover once they are older than the retained history,
   * then purges any deleted thread that still holds conversation content.
   */
  readonly pruneEventStore: (betweenPages?: Effect.Effect<void>) => Effect.Effect<
    {
      readonly deletedEventCount: number;
      readonly deletedReceiptCount: number;
      readonly compactedTurnItemCount: number;
      readonly purgedRowCount: number;
      readonly reclaimableBytes: number;
    },
    ProjectionMaintenanceError
  >;
  /**
   * Removes a deleted thread's conversation, and that of deleted run-fork sources it alone kept.
   * Returns the number of rows removed.
   */
  readonly purgeDeletedThread: (
    threadId: ThreadId,
  ) => Effect.Effect<number, ProjectionMaintenanceError>;
}

export class ProjectionMaintenanceV2 extends Context.Service<
  ProjectionMaintenanceV2,
  ProjectionMaintenanceV2Shape
>()("t3/orchestration-v2/ProjectionMaintenance/ProjectionMaintenanceV2") {}

// Reconnect replay and command-id retries read this tail; older cursors resync from a snapshot.
const RETAINED_EVENT_HISTORY = Duration.days(1);
// Small pages bound work on the reader worker and synchronous fallback.
const PAGE_SIZE = 50;
const REFERENCE_SCAN_WINDOW = 1000;
// Bounds how long one purge statement holds the writer: on a real database a 500-row batch of
// turn items took about 400 ms, index and count-trigger work included.
const PURGE_BATCH_SIZE = 50;
// Titles default to the first message, so a tombstone cannot keep the real one.
export const DELETED_THREAD_TITLE = "Deleted thread";

// Every thread_id table that holds conversation text. The thread row stays as the tombstone, and
// the metadata that storage cleanup and usage history still read (checkpoints, provider sessions,
// provider turns, run attempts, context transfers) stays with it.
export const DELETED_THREAD_CONTENT_TABLES = [
  "orchestration_v2_turn_item_positions",
  "orchestration_v2_projection_turn_items",
  "orchestration_v2_projection_messages",
  "orchestration_v2_projection_nodes",
  "orchestration_v2_projection_runs",
  "orchestration_v2_projection_subagents",
  "orchestration_v2_projection_context_handoffs",
  "orchestration_v2_projection_runtime_requests",
  "orchestration_v2_projection_plans",
  "mcp_app_model_context",
  // A legacy thread's transcript source; deleting it means the importer has nothing to restore.
  "projection_thread_messages",
] as const;

// Fork retention (docs/operations/fork.md#state-retention): whole-snapshot updates a newer one
// replaces. Each entity keeps its first update, where client reducers place it, and its newest.
const SUPERSEDABLE_EVENT_TYPES = ["turn-item.updated", "node.updated"] as const;
const SUPERSEDED_MARK = "event-log-superseded-mark";
const SUPERSEDED_THROUGH = "event-log-superseded-through";
// Command-id retries replay their own events; keep recent updates for them.
const SUPERSEDED_GRACE = Duration.hours(1);
const SETTLED_THREAD_AGE = Duration.days(7);
// Versioned so upgrading from text-only compaction backfills older settled threads once.
const TURN_ITEMS_COMPACTED_BEFORE = "turn-items-compacted-before-v2";
const KEPT_OUTPUT_CHARS = 8192;
const COMPACTED_OUTPUT_MIN_CHARS = 2 * KEPT_OUTPUT_CHARS + 1024;
const STRUCTURED_KEPT_CHARS = 4096;
const STRUCTURED_STRING_MIN_CHARS = 2 * STRUCTURED_KEPT_CHARS + 1024;
const DATA_URL_MIN_CHARS = 1024;
const MAX_STRUCTURED_DEPTH = 32;
// Each rewritten row is parsed several times; bound one statement's work by bytes.
const UPDATE_PAGE_BYTES = 4 * 1024 * 1024;
const SETTLED_ITEM_STATUSES = ["completed", "failed", "interrupted", "cancelled"] as const;
const DATA_URL_BASE64_PATTERN = /^data:([^;,]{1,128})(?:;[^,]{0,128})?;base64,/i;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Predicate.isObject(value) && !Array.isArray(value);
}

function trimTextEnds(text: string, keptChars: number, minChars: number): string {
  if (text.length <= minChars) return text;
  if (keptChars <= 0) {
    return `[T3 Code removed ${text.length} characters of this output once the thread had been settled for 7 days.]`;
  }
  let headEnd = keptChars;
  const headLast = text.charCodeAt(headEnd - 1);
  if (headLast >= 0xd800 && headLast <= 0xdbff) headEnd -= 1;
  let tailStart = text.length - keptChars;
  const tailFirst = text.charCodeAt(tailStart);
  if (tailFirst >= 0xdc00 && tailFirst <= 0xdfff) tailStart += 1;
  const removed = tailStart - headEnd;
  if (removed <= 0) return text;
  return (
    text.slice(0, headEnd) +
    `\n\n[T3 Code removed ${removed} characters of this output once the thread had been settled for 7 days.]\n\n` +
    text.slice(tailStart)
  );
}

function compactDataUrl(text: string): string | null {
  if (text.length <= DATA_URL_MIN_CHARS) return null;
  const match = DATA_URL_BASE64_PATTERN.exec(text);
  if (match === null) return null;
  return `[T3 Code removed a ${match[1]} data URL (${text.length} characters) once the thread had been settled for 7 days.]`;
}

// Replaces embedded base64 blocks with text notices rather than empty image blocks:
// clients treat image blocks without `data` as server assets and request them via AssetAccess.
function compactBinaryBlock(value: Record<string, unknown>): { type: "text"; text: string } | null {
  if (value.type === "image") {
    const source = isPlainRecord(value.source) ? value.source : undefined;
    const data = source === undefined ? value.data : source.data;
    if (typeof data !== "string" || data.length === 0) return null;
    const mimeType = source === undefined ? value.mimeType : source.media_type;
    const label =
      typeof mimeType === "string" && mimeType.trim() !== "" ? `${mimeType.trim()}, ` : "";
    return {
      type: "text",
      text: `[T3 Code removed an image (${label}${data.length} base64 characters) once the thread had been settled for 7 days.]`,
    };
  }
  if (
    value.type === "document" &&
    isPlainRecord(value.source) &&
    value.source.type === "base64" &&
    typeof value.source.data === "string" &&
    value.source.data.length > 0
  ) {
    const mimeType = value.source.media_type;
    const label =
      typeof mimeType === "string" && mimeType.trim() !== "" ? `${mimeType.trim()}, ` : "";
    return {
      type: "text",
      text: `[T3 Code removed a document (${label}${value.source.data.length} base64 characters) once the thread had been settled for 7 days.]`,
    };
  }
  if (
    value.type === "resource" &&
    isPlainRecord(value.resource) &&
    typeof value.resource.blob === "string" &&
    value.resource.blob.length > 0
  ) {
    const details = [
      typeof value.resource.uri === "string" && value.resource.uri.trim() !== ""
        ? value.resource.uri.trim()
        : undefined,
      typeof value.resource.mimeType === "string" && value.resource.mimeType.trim() !== ""
        ? value.resource.mimeType.trim()
        : undefined,
      `${value.resource.blob.length} base64 characters`,
    ].filter((part): part is string => part !== undefined);
    return {
      type: "text",
      text: `[T3 Code removed a binary resource (${details.join(", ")}) once the thread had been settled for 7 days.]`,
    };
  }
  return null;
}

function compactStructuredValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    return (
      compactDataUrl(value) ??
      trimTextEnds(value, STRUCTURED_KEPT_CHARS, STRUCTURED_STRING_MIN_CHARS)
    );
  }
  if (depth >= MAX_STRUCTURED_DEPTH) return value;
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((entry) => {
      const compacted = compactStructuredValue(entry, depth + 1);
      if (compacted !== entry) changed = true;
      return compacted;
    });
    return changed ? next : value;
  }
  if (!isPlainRecord(value)) return value;
  const binaryNotice = compactBinaryBlock(value);
  if (binaryNotice !== null) return binaryNotice;
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const compacted = compactStructuredValue(entry, depth + 1);
    if (compacted !== entry) changed = true;
    next[key] = compacted;
  }
  return changed ? next : value;
}

function wrapWithPreservedMetadata(
  sourceText: string,
  preserved: Record<string, unknown> | undefined,
): unknown {
  if (preserved === undefined) {
    return trimTextEnds(sourceText, KEPT_OUTPUT_CHARS, COMPACTED_OUTPUT_MIN_CHARS);
  }
  const hasNonErrorMetadata = Object.keys(preserved).some((key) => key !== "isError");
  const isError = preserved.isError === true;
  const build = (content: string) =>
    hasNonErrorMetadata
      ? { ...(isError ? { isError: true } : {}), content, structuredContent: preserved }
      : { ...(isError ? { isError: true } : {}), content };
  for (let kept = STRUCTURED_KEPT_CHARS; ; kept = Math.floor(kept / 2)) {
    const wrapped = build(trimTextEnds(sourceText, kept, kept === 0 ? 0 : 2 * kept + 1024));
    const serialized = JSON.stringify(wrapped);
    if (serialized !== undefined && serialized.length <= COMPACTED_OUTPUT_MIN_CHARS) {
      return wrapped;
    }
    if (kept === 0) return wrapped;
  }
}

function hasNonEmptyContent(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  return Array.isArray(value) && value.length > 0;
}

function plainTextFromBlocks(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const parts: Array<string> = [];
    for (const entry of value) {
      if (!isPlainRecord(entry) || entry.type !== "text" || typeof entry.text !== "string") {
        return null;
      }
      parts.push(entry.text);
    }
    return parts.join("\n");
  }
  if (isPlainRecord(value) && "content" in value) {
    return plainTextFromBlocks(value.content);
  }
  return null;
}

function compactStructuredToolOutput(
  output: unknown,
  toolName: string | null,
): { readonly changed: boolean; readonly value: unknown } {
  if (output === null || typeof output !== "object") return { changed: false, value: output };
  const originalSerialized = JSON.stringify(output);
  if (originalSerialized === undefined || originalSerialized.length <= COMPACTED_OUTPUT_MIN_CHARS) {
    return { changed: false, value: output };
  }
  // Keep MCP app references intact so clients and attachment retention keep resolving them.
  if (isPlainRecord(output) && MCP_APP_OUTPUT_KEY in output && "result" in output) {
    const result = output.result;
    const compactedResult =
      typeof result === "string"
        ? trimTextEnds(result, KEPT_OUTPUT_CHARS, COMPACTED_OUTPUT_MIN_CHARS)
        : compactStructuredToolOutput(result, toolName).value;
    if (compactedResult === result) return { changed: false, value: output };
    return { changed: true, value: { ...output, result: compactedResult } };
  }
  const preservedRaw = compactT3McpToolOutput(toolName, output) ?? compactDynamicToolOutput(output);
  const preserved =
    preservedRaw === undefined ? undefined : ({ ...preservedRaw } as Record<string, unknown>);

  let compacted = compactStructuredValue(output);
  let compactedJson = JSON.stringify(compacted);
  if (compactedJson === undefined) return { changed: false, value: output };

  // MCP tools often duplicate the same payload in `content` and `structuredContent`.
  if (
    compactedJson.length > COMPACTED_OUTPUT_MIN_CHARS &&
    isPlainRecord(compacted) &&
    "content" in compacted &&
    "structuredContent" in compacted &&
    hasNonEmptyContent(compacted.content)
  ) {
    const hasNonErrorMetadata =
      preserved !== undefined && Object.keys(preserved).some((key) => key !== "isError");
    const isError =
      preserved?.isError === true || compacted.isError === true || compacted.is_error === true;
    const slimmed = hasNonErrorMetadata
      ? {
          ...(isError ? { isError: true } : {}),
          content: compacted.content,
          structuredContent: preserved,
        }
      : isError
        ? { isError: true, content: compacted.content }
        : { content: compacted.content };
    const slimmedJson = JSON.stringify(slimmed);
    if (slimmedJson !== undefined) {
      compacted = slimmed;
      compactedJson = slimmedJson;
    }
  }

  if (compactedJson.length > COMPACTED_OUTPUT_MIN_CHARS) {
    const sourceText = plainTextFromBlocks(compacted) ?? compactedJson;
    compacted = wrapWithPreservedMetadata(sourceText, preserved);
    compactedJson = JSON.stringify(compacted) ?? compactedJson;
  }

  return compactedJson === originalSerialized
    ? { changed: false, value: output }
    : { changed: true, value: compacted };
}

function compactStructuredOutputJson(
  outputJson: string,
  toolName: string | null,
): { readonly isText: boolean; readonly serialized: string } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(outputJson);
  } catch {
    return null;
  }
  const result = compactStructuredToolOutput(parsed, toolName);
  if (!result.changed) return null;
  if (typeof result.value === "string") {
    return { isText: true, serialized: result.value };
  }
  const serialized = JSON.stringify(result.value);
  return serialized === undefined ? null : { isText: false, serialized };
}

type MetadataRow = {
  readonly projection_name: string;
  readonly last_sequence: number;
  readonly updated_at: string;
};

export const layer: Layer.Layer<ProjectionMaintenanceV2, never, SqlClient.SqlClient> = Layer.effect(
  ProjectionMaintenanceV2,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const writeMetadata = (name: string, sequence: number, at: DateTime.Utc) => sql`
      INSERT INTO orchestration_v2_projection_metadata (
        projection_name, schema_version, last_sequence, updated_at
      )
      VALUES (
        ${name},
        ${ProjectionStore.ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION},
        ${sequence},
        ${DateTime.formatIso(at)}
      )
      ON CONFLICT(projection_name) DO UPDATE SET
        last_sequence = excluded.last_sequence,
        updated_at = excluded.updated_at
    `;

    // Collects anchors whose prompt later rows borrow through promptSequence.
    const readPromptReferences = Effect.fnUntraced(function* (
      afterSequence: number,
      throughSequence: number,
      betweenPages: Effect.Effect<void>,
    ) {
      const referenced = new Set<number>();
      for (let cursor = afterSequence; cursor < throughSequence;) {
        const windowEnd = Math.min(cursor + REFERENCE_SCAN_WINDOW, throughSequence);
        const rows = yield* sql<{ readonly prompt_sequence: number }>`
          SELECT json_extract(payload_json, '$.promptSequence') AS prompt_sequence
          FROM orchestration_events
          WHERE sequence > ${cursor}
            AND sequence <= ${windowEnd}
            AND event_type IN ('subagent.updated', 'turn-item.updated')
            AND json_type(payload_json, '$.promptSequence') = 'integer'
        `.pipe(NodeSqliteClient.readOnly);
        for (const row of rows) referenced.add(row.prompt_sequence);
        cursor = windowEnd;
        yield* betweenPages;
      }
      return referenced;
    });

    const pruneEvents = Effect.fnUntraced(function* (
      throughSequence: number,
      head: number,
      betweenPages: Effect.Effect<void>,
    ) {
      const referenced = yield* readPromptReferences(throughSequence, head, betweenPages);
      // Stream heads at or below the boundary are kept, so the anchors they borrow must stay too.
      const keptHeadReferences = yield* sql<{ readonly prompt_sequence: number }>`
        SELECT json_extract(event.payload_json, '$.promptSequence') AS prompt_sequence
        FROM (
          SELECT MAX(sequence) AS sequence FROM orchestration_events
          GROUP BY aggregate_kind, stream_id
        ) AS heads
        JOIN orchestration_events AS event ON event.sequence = heads.sequence
        WHERE heads.sequence <= ${throughSequence}
          AND event.event_type IN ('subagent.updated', 'turn-item.updated')
          AND json_type(event.payload_json, '$.promptSequence') = 'integer'
      `.pipe(NodeSqliteClient.readOnly);
      for (const row of keptHeadReferences) referenced.add(row.prompt_sequence);
      yield* betweenPages;
      let referencesThrough = head;
      let deleted = 0;
      let cursor = 0;
      while (cursor < throughSequence) {
        const rows = yield* sql<{ readonly sequence: number; readonly prunable: number }>`
          SELECT
            event.sequence,
            CASE
              WHEN event.application_event_version = 1 THEN 0
              -- The legacy importer treats a thread without thread.created as not yet imported.
              WHEN event.event_type = 'thread.created' THEN 0
              -- Codex usage history reads the selection a run attempt started with.
              WHEN event.event_type = 'run.updated'
                AND json_extract(event.payload_json, '$.status') = 'running' THEN 0
              -- The newest row keeps each stream's high water, stream_version, and snapshot sequence.
              WHEN event.sequence = (
                SELECT MAX(newer.sequence) FROM orchestration_events AS newer
                WHERE newer.aggregate_kind = event.aggregate_kind
                  AND newer.stream_id = event.stream_id
              ) THEN 0
              ELSE 1
            END AS prunable
          FROM orchestration_events AS event
          WHERE event.sequence > ${cursor}
            AND event.sequence <= ${throughSequence}
          ORDER BY event.sequence ASC
          LIMIT ${PAGE_SIZE}
        `.pipe(NodeSqliteClient.readOnly);
        const candidates = rows.filter((row) => row.prunable === 1).map((row) => row.sequence);
        // Never hold a transaction or the reader lock across a yield or a rest.
        yield* Effect.yieldNow;
        if (candidates.length > 0) {
          deleted += yield* sql.withTransaction(
            Effect.gen(function* () {
              // Rows appended since the reference scan may borrow a prompt from a candidate.
              const appended = yield* sql<{
                readonly sequence: number;
                readonly prompt_sequence: number | null;
              }>`
                SELECT
                  sequence,
                  CASE
                    WHEN event_type IN ('subagent.updated', 'turn-item.updated')
                      AND json_type(payload_json, '$.promptSequence') = 'integer'
                    THEN json_extract(payload_json, '$.promptSequence')
                  END AS prompt_sequence
                FROM orchestration_events
                WHERE sequence > ${referencesThrough}
              `;
              for (const row of appended) {
                if (row.prompt_sequence !== null) referenced.add(row.prompt_sequence);
                referencesThrough = Math.max(referencesThrough, row.sequence);
              }
              const obsolete = candidates.filter((sequence) => !referenced.has(sequence));
              if (obsolete.length === 0) return 0;
              yield* sql`DELETE FROM orchestration_events WHERE sequence IN ${sql.in(obsolete)}`;
              return obsolete.length;
            }),
          );
          yield* Effect.yieldNow;
        }
        // Rest after every page, including the last, so the next loop starts a fresh slice.
        yield* betweenPages;
        if (rows.length < PAGE_SIZE) break;
        cursor = rows.at(-1)?.sequence ?? throughSequence;
      }
      return deleted;
    });

    // Imported legacy threads are served from v2 rows; their v1 events and receipts have no reader.
    const pruneImportedLegacyHistory = Effect.fnUntraced(function* (
      throughSequence: number,
      throughReceiptRowId: number,
      betweenPages: Effect.Effect<void>,
    ) {
      let deletedEventCount = 0;
      let deletedReceiptCount = 0;
      for (let cursor = 0; ;) {
        const rows = yield* sql<{ readonly sequence: number; readonly imported: number }>`
          SELECT
            event.sequence,
            event.aggregate_kind = 'thread' AND EXISTS (
              SELECT 1 FROM orchestration_v2_legacy_imports AS legacy_import
              WHERE legacy_import.thread_id = event.stream_id
                AND legacy_import.transcript_imported_at IS NOT NULL
            ) AS imported
          FROM orchestration_events AS event
            INDEXED BY idx_orchestration_events_application_sequence
          WHERE event.application_event_version = 1
            AND event.sequence > ${cursor}
            AND event.sequence <= ${throughSequence}
          ORDER BY event.sequence ASC
          LIMIT ${PAGE_SIZE}
        `.pipe(NodeSqliteClient.readOnly);
        const obsolete = rows.filter((row) => row.imported === 1).map((row) => row.sequence);
        yield* Effect.yieldNow;
        if (obsolete.length > 0) {
          yield* sql`DELETE FROM orchestration_events WHERE sequence IN ${sql.in(obsolete)}`;
          deletedEventCount += obsolete.length;
          yield* Effect.yieldNow;
        }
        yield* betweenPages;
        if (rows.length < PAGE_SIZE) break;
        cursor = rows.at(-1)?.sequence ?? cursor;
      }
      for (let cursor = 0; ;) {
        const rows = yield* sql<{
          readonly row_id: number;
          readonly command_id: string;
          readonly imported: number;
        }>`
          SELECT
            receipt.rowid AS row_id,
            receipt.command_id,
            receipt.command_type = 'legacy' AND receipt.aggregate_kind = 'thread' AND EXISTS (
              SELECT 1 FROM orchestration_v2_legacy_imports AS legacy_import
              WHERE legacy_import.thread_id = receipt.aggregate_id
                AND legacy_import.transcript_imported_at IS NOT NULL
            ) AS imported
          FROM orchestration_command_receipts AS receipt
          WHERE receipt.rowid > ${cursor} AND receipt.rowid <= ${throughReceiptRowId}
          ORDER BY receipt.rowid ASC
          LIMIT ${PAGE_SIZE}
        `.pipe(NodeSqliteClient.readOnly);
        const obsolete = rows.filter((row) => row.imported === 1).map((row) => row.command_id);
        yield* Effect.yieldNow;
        if (obsolete.length > 0) {
          yield* sql`DELETE FROM orchestration_command_receipts WHERE command_id IN ${sql.in(obsolete)}`;
          deletedReceiptCount += obsolete.length;
          yield* Effect.yieldNow;
        }
        yield* betweenPages;
        if (rows.length < PAGE_SIZE) break;
        cursor = rows.at(-1)?.row_id ?? cursor;
      }
      return { deletedEventCount, deletedReceiptCount };
    });

    // Drops updates between an entity's first and newest one, through the previous pass's mark.
    const pruneSupersededUpdates = Effect.fn("ProjectionMaintenance.pruneSupersededUpdates")(
      function* (now: DateTime.Utc, head: number, betweenPages: Effect.Effect<void>) {
        const metadata = yield* sql<MetadataRow>`
          SELECT projection_name, last_sequence, updated_at
          FROM orchestration_v2_projection_metadata
          WHERE projection_name IN (
            ${SUPERSEDED_MARK}, ${SUPERSEDED_THROUGH}, ${EVENT_LOG_PRUNED_THROUGH}
          )
        `.pipe(NodeSqliteClient.readOnly);
        const read = (name: string) => metadata.find((row) => row.projection_name === name);
        const mark = read(SUPERSEDED_MARK);
        if (
          mark !== undefined &&
          DateTime.toEpochMillis(now) - Date.parse(mark.updated_at) <
            Duration.toMillis(SUPERSEDED_GRACE)
        ) {
          return 0;
        }
        const after = Math.max(
          read(SUPERSEDED_THROUGH)?.last_sequence ?? 0,
          read(EVENT_LOG_PRUNED_THROUGH)?.last_sequence ?? 0,
        );
        const through = mark?.last_sequence ?? 0;
        const streams = new Set<string>();
        for (let cursor = after; cursor < through;) {
          const windowEnd = Math.min(cursor + REFERENCE_SCAN_WINDOW, through);
          const rows = yield* sql<{ readonly stream_id: string }>`
            SELECT DISTINCT stream_id FROM orchestration_events
            WHERE sequence > ${cursor} AND sequence <= ${windowEnd}
              AND aggregate_kind = 'thread'
              AND event_type IN ${sql.in(SUPERSEDABLE_EVENT_TYPES)}
          `.pipe(NodeSqliteClient.readOnly);
          for (const row of rows) streams.add(row.stream_id);
          cursor = windowEnd;
          yield* betweenPages;
        }
        let deleted = 0;
        if (streams.size > 0) {
          const referenced = yield* readPromptReferences(after, head, betweenPages);
          let referencesThrough = head;
          for (const streamId of streams) {
            // Per entity: its newest update so far, and whether an older one precedes it.
            const newest = new Map<string, { sequence: number; deletable: boolean }>();
            const candidates: Array<number> = [];
            for (let cursor = after; ;) {
              const rows = yield* sql<{
                readonly sequence: number;
                readonly entity: string;
                readonly uncommanded: number;
              }>`
                SELECT
                  sequence,
                  event_type || ':' || json_extract(payload_json, '$.id') AS entity,
                  command_id IS NULL AS uncommanded
                FROM orchestration_events
                WHERE stream_id = ${streamId}
                  AND application_event_version = 2 AND aggregate_kind = 'thread'
                  AND sequence > ${cursor} AND sequence <= ${head}
                  AND event_type IN ${sql.in(SUPERSEDABLE_EVENT_TYPES)}
                ORDER BY sequence ASC
                LIMIT ${PAGE_SIZE}
              `.pipe(NodeSqliteClient.readOnly);
              for (const row of rows) {
                const previous = newest.get(row.entity);
                if (previous?.deletable === true) candidates.push(previous.sequence);
                newest.set(row.entity, {
                  sequence: row.sequence,
                  deletable:
                    previous !== undefined && row.uncommanded === 1 && row.sequence <= through,
                });
              }
              yield* betweenPages;
              if (rows.length < PAGE_SIZE) break;
              cursor = rows.at(-1)?.sequence ?? head;
            }
            for (let start = 0; start < candidates.length; start += PAGE_SIZE) {
              const page = candidates.slice(start, start + PAGE_SIZE);
              deleted += yield* sql.withTransaction(
                Effect.gen(function* () {
                  // Rows appended since the reference scan may borrow a prompt from a candidate.
                  const appended = yield* sql<{
                    readonly sequence: number;
                    readonly prompt_sequence: number | null;
                  }>`
                    SELECT
                      sequence,
                      CASE
                        WHEN event_type IN ('subagent.updated', 'turn-item.updated')
                          AND json_type(payload_json, '$.promptSequence') = 'integer'
                        THEN json_extract(payload_json, '$.promptSequence')
                      END AS prompt_sequence
                    FROM orchestration_events WHERE sequence > ${referencesThrough}
                  `;
                  for (const row of appended) {
                    if (row.prompt_sequence !== null) referenced.add(row.prompt_sequence);
                    referencesThrough = Math.max(referencesThrough, row.sequence);
                  }
                  const obsolete = page.filter((sequence) => !referenced.has(sequence));
                  if (obsolete.length === 0) return 0;
                  yield* sql`DELETE FROM orchestration_events WHERE sequence IN ${sql.in(obsolete)}`;
                  return obsolete.length;
                }),
              );
              yield* Effect.yieldNow;
              yield* betweenPages;
            }
          }
        }
        if (through > after) yield* writeMetadata(SUPERSEDED_THROUGH, through, now);
        yield* writeMetadata(SUPERSEDED_MARK, head, now);
        return deleted;
      },
    );

    // Threads settled and untouched for SETTLED_THREAD_AGE keep their transcript, but each long
    // tool output (text or structured object/array) is compacted and reasoning text is cleared.
    const compactSettledTurnItems = Effect.fn("ProjectionMaintenance.compactSettledTurnItems")(
      function* (now: DateTime.Utc, betweenPages: Effect.Effect<void>) {
        const cutoff = DateTime.subtractDuration(now, SETTLED_THREAD_AGE);
        const cutoffIso = DateTime.formatIso(cutoff);
        const previous = yield* sql<MetadataRow>`
          SELECT projection_name, last_sequence, updated_at
          FROM orchestration_v2_projection_metadata
          WHERE projection_name = ${TURN_ITEMS_COMPACTED_BEFORE}
        `.pipe(NodeSqliteClient.readOnly);
        const previousIso = previous[0]?.updated_at ?? "";
        // Settling bumps updated_at, so a thread settled later enters a later window.
        const threads = yield* sql<{ readonly thread_id: string }>`
          SELECT thread_id FROM orchestration_v2_projection_threads
          WHERE updated_at < ${cutoffIso} AND updated_at >= ${previousIso}
            AND json_extract(payload_json, '$.settledAt') IS NOT NULL
        `.pipe(NodeSqliteClient.readOnly);
        const output = sql`json_extract(payload_json, '$.output')`;
        const compactableTextOrReasoning = sql`
          status IN ${sql.in(SETTLED_ITEM_STATUSES)}
          AND (
            (type IN ('command_execution', 'dynamic_tool')
              AND length(payload_json) > ${COMPACTED_OUTPUT_MIN_CHARS}
              AND json_type(payload_json, '$.output') = 'text')
            OR (type = 'reasoning' AND json_extract(payload_json, '$.text') <> '')
          )
        `;
        const compactableStructured = sql`
          status IN ${sql.in(SETTLED_ITEM_STATUSES)}
          AND type = 'dynamic_tool'
          AND length(payload_json) > ${COMPACTED_OUTPUT_MIN_CHARS}
          AND json_type(payload_json, '$.output') IN ('object', 'array')
          AND length(${output}) > ${COMPACTED_OUTPUT_MIN_CHARS}
        `;
        const batchByBytes = (
          entries: ReadonlyArray<{ readonly turn_item_id: string; readonly size: number }>,
        ) => {
          const pages: Array<Array<string>> = [];
          let pageBytes = 0;
          for (const item of entries) {
            const page = pages.at(-1);
            if (
              page === undefined ||
              page.length >= PAGE_SIZE ||
              pageBytes + item.size > UPDATE_PAGE_BYTES
            ) {
              pages.push([item.turn_item_id]);
              pageBytes = item.size;
            } else {
              page.push(item.turn_item_id);
              pageBytes += item.size;
            }
          }
          return pages;
        };
        let compacted = 0;
        for (const { thread_id: threadId } of threads) {
          const textItems: Array<{ readonly turn_item_id: string; readonly size: number }> = [];
          const structuredItems: Array<{ readonly turn_item_id: string; readonly size: number }> =
            [];
          let cursor: { readonly ordinal: number; readonly id: string } | undefined;
          for (;;) {
            const rows = yield* sql<{
              readonly turn_item_id: string;
              readonly ordinal: number;
              readonly size: number;
            }>`
              SELECT turn_item_id, ordinal, length(payload_json) AS size
              FROM orchestration_v2_projection_turn_items
              WHERE thread_id = ${threadId} AND ${
                cursor === undefined
                  ? sql`1`
                  : sql`(ordinal, turn_item_id) > (${cursor.ordinal}, ${cursor.id})`
              }
              ORDER BY ordinal, turn_item_id
              LIMIT ${PAGE_SIZE}
            `.pipe(NodeSqliteClient.readOnly);
            const last = rows.at(-1);
            if (last !== undefined) {
              const page = yield* sql<{
                readonly turn_item_id: string;
                readonly size: number;
                readonly structured: number;
              }>`
                SELECT
                  turn_item_id,
                  length(payload_json) AS size,
                  CASE
                    WHEN type = 'dynamic_tool'
                      AND json_type(payload_json, '$.output') IN ('object', 'array')
                    THEN 1
                    ELSE 0
                  END AS structured
                FROM orchestration_v2_projection_turn_items
                WHERE turn_item_id IN ${sql.in(rows.map((row) => row.turn_item_id))}
                  AND ((${compactableTextOrReasoning}) OR (${compactableStructured}))
              `.pipe(NodeSqliteClient.readOnly);
              for (const item of page) {
                if (item.structured === 1) structuredItems.push(item);
                else textItems.push(item);
              }
              cursor = { ordinal: last.ordinal, id: last.turn_item_id };
            }
            yield* betweenPages;
            if (rows.length < PAGE_SIZE) break;
          }
          const threadStillSettled = sql`
            EXISTS (
              SELECT 1 FROM orchestration_v2_projection_threads AS thread
              WHERE thread.thread_id = ${threadId} AND thread.updated_at < ${cutoffIso}
                AND json_extract(thread.payload_json, '$.settledAt') IS NOT NULL
            )
          `;
          for (const ids of batchByBytes(textItems)) {
            // Rechecks the thread so one that resumed during the pass keeps its items.
            const updated = yield* sql<{ readonly turn_item_id: string }>`
              UPDATE orchestration_v2_projection_turn_items
              SET payload_json = CASE type
                WHEN 'reasoning' THEN json_set(payload_json, '$.text', '')
                ELSE json_set(
                  payload_json,
                  '$.output',
                  substr(${output}, 1, ${KEPT_OUTPUT_CHARS})
                    || ${"\n\n[T3 Code removed "}
                    || CAST(length(${output}) - ${2 * KEPT_OUTPUT_CHARS} AS INTEGER)
                    || ${" characters of this output once the thread had been settled for 7 days.]\n\n"}
                    || substr(${output}, ${-KEPT_OUTPUT_CHARS})
                )
              END
              WHERE turn_item_id IN ${sql.in(ids)}
                AND ${compactableTextOrReasoning}
                AND (type = 'reasoning' OR length(${output}) > ${COMPACTED_OUTPUT_MIN_CHARS})
                AND ${threadStillSettled}
              RETURNING turn_item_id
            `;
            compacted += updated.length;
            yield* Effect.yieldNow;
            yield* betweenPages;
          }
          for (const ids of batchByBytes(structuredItems)) {
            const rows = yield* sql<{
              readonly turn_item_id: string;
              readonly updated_at: string;
              readonly tool_name: string | null;
              readonly output_json: string | null;
            }>`
              SELECT
                turn_item_id,
                updated_at,
                json_extract(payload_json, '$.toolName') AS tool_name,
                ${output} AS output_json
              FROM orchestration_v2_projection_turn_items
              WHERE turn_item_id IN ${sql.in(ids)} AND ${compactableStructured}
            `.pipe(NodeSqliteClient.readOnly);
            yield* Effect.yieldNow;
            const updates: Array<{
              readonly turnItemId: string;
              readonly updatedAt: string;
              readonly isText: boolean;
              readonly serialized: string;
            }> = [];
            for (const row of rows) {
              if (row.output_json === null) continue;
              const next = compactStructuredOutputJson(row.output_json, row.tool_name);
              if (next !== null) {
                updates.push({
                  turnItemId: row.turn_item_id,
                  updatedAt: row.updated_at,
                  ...next,
                });
              }
            }
            if (updates.length > 0) {
              compacted += yield* sql.withTransaction(
                Effect.gen(function* () {
                  let count = 0;
                  for (const update of updates) {
                    const nextValue = update.isText
                      ? sql`${update.serialized}`
                      : sql`json(${update.serialized})`;
                    const updated = yield* sql<{ readonly turn_item_id: string }>`
                      UPDATE orchestration_v2_projection_turn_items
                      SET payload_json = json_set(payload_json, '$.output', ${nextValue})
                      WHERE turn_item_id = ${update.turnItemId}
                        AND updated_at = ${update.updatedAt}
                        AND ${compactableStructured}
                        AND ${threadStillSettled}
                      RETURNING turn_item_id
                    `;
                    count += updated.length;
                  }
                  return count;
                }),
              );
              yield* Effect.yieldNow;
            }
            yield* betweenPages;
          }
        }
        if (previousIso === "" || cutoffIso > previousIso) {
          yield* writeMetadata(TURN_ITEMS_COMPACTED_BEFORE, 0, cutoff);
        }
        return compacted;
      },
    );

    // A run fork shows its source's history without copying it, through any chain of forks, and a
    // pending merge-back still reads its source. Such a deleted thread keeps its content until
    // every live thread that shows it is deleted too.
    const purgeableThreads = (deletedThreadId: ThreadId | undefined) =>
      sql<{
        readonly thread_id: string;
      }>`
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
      ),
      candidate(thread_id) AS (${
        deletedThreadId === undefined
          ? sql`SELECT thread_id FROM orchestration_v2_projection_threads WHERE deleted_at IS NOT NULL`
          : // Deleting a fork can release the deleted sources it was the last to show.
            sql`
              SELECT ${deletedThreadId}
              UNION
              SELECT json_extract(fork.payload_json, '$.forkedFrom.threadId')
              FROM candidate
              JOIN orchestration_v2_projection_threads AS fork
                ON fork.thread_id = candidate.thread_id
              WHERE json_extract(fork.payload_json, '$.forkedFrom.type') = 'run'
            `
      })
      SELECT thread.thread_id
      FROM candidate
      JOIN orchestration_v2_projection_threads AS thread ON thread.thread_id = candidate.thread_id
      WHERE thread.deleted_at IS NOT NULL
        AND thread.thread_id NOT IN (SELECT thread_id FROM shown WHERE thread_id IS NOT NULL)
        -- Earlier effects still read the thread; a later purge or sweep takes it.
        AND NOT EXISTS (
          SELECT 1 FROM orchestration_v2_effect_outbox AS effect
          WHERE effect.thread_id = thread.thread_id
            AND effect.status IN ('pending', 'running')
            -- Title generation has its own lane and needs nothing the purge removes.
            AND effect.effect_type NOT IN ('thread-content.purge', 'thread-title.generate')
        )
        -- A live parent settles its delegated task from this child's runs.
        AND NOT EXISTS (
          SELECT 1 FROM orchestration_v2_projection_subagents AS task
          JOIN orchestration_v2_projection_threads AS parent ON parent.thread_id = task.thread_id
          WHERE task.child_thread_id = thread.thread_id
            AND task.status IN ('idle', 'pending', 'running', 'waiting')
            AND parent.deleted_at IS NULL
        )
        -- The delete's own purge always runs; the sweep only takes threads with something left.
        AND ${
          deletedThreadId !== undefined
            ? sql`1 = 1`
            : sql.or([
                sql`thread.title <> ${DELETED_THREAD_TITLE}`,
                // A thread renamed to the placeholder still has its first title in thread.created.
                sql`EXISTS (
            SELECT 1 FROM orchestration_events
              INDEXED BY idx_orchestration_events_agent_stream_sequence
            WHERE application_event_version = 2
              AND aggregate_kind = 'thread'
              AND stream_id = thread.thread_id
              AND event_type IN ('thread.created', 'thread.deleted')
              AND json_extract(payload_json, '$.title') IS NOT ${DELETED_THREAD_TITLE}
          )`,
                sql`json_type(thread.payload_json, '$.guestShare') IS NOT NULL`,
                // An interrupted pass leaves events the purge does not keep.
                sql`EXISTS (
                  SELECT 1 FROM orchestration_events
                    INDEXED BY idx_orchestration_events_agent_stream_sequence
                  WHERE application_event_version = 2
                    AND aggregate_kind = 'thread'
                    AND stream_id = thread.thread_id
                    AND event_type NOT IN ('thread.created', 'thread.deleted')
                    AND NOT (
                      event_type = 'run.updated'
                      AND json_extract(payload_json, '$.status') = 'running'
                    )
                )`,
                // The purge deletes settled requests and clears a failed one's error.
                sql`EXISTS (
                  SELECT 1 FROM orchestration_v2_effect_outbox AS effect
                  WHERE effect.thread_id = thread.thread_id
                    AND effect.effect_type <> 'thread-content.purge'
                    AND (
                      effect.status IN ('succeeded', 'cancelled')
                      OR (effect.status = 'failed' AND effect.last_error IS NOT NULL)
                    )
                )`,
                ...DELETED_THREAD_CONTENT_TABLES.map(
                  (table) =>
                    sql`EXISTS (SELECT 1 FROM ${sql(table)} WHERE thread_id = thread.thread_id)`,
                ),
              ])
        }
    `.pipe(NodeSqliteClient.readOnly);

    const purgeThreads = Effect.fnUntraced(function* (
      deletedThreadId: ThreadId | undefined,
      betweenPages: Effect.Effect<void>,
    ) {
      const threads = yield* purgeableThreads(deletedThreadId);
      const now = DateTime.formatIso(yield* DateTime.now);
      let purged = 0;
      // Each statement commits on its own, so a huge thread never holds the writer for long.
      const drain = Effect.fnUntraced(function* (
        deleteBatch: Effect.Effect<ReadonlyArray<unknown>, SqlError.SqlError>,
      ) {
        for (;;) {
          const rows = yield* deleteBatch;
          purged += rows.length;
          yield* Effect.yieldNow;
          yield* betweenPages;
          if (rows.length < PURGE_BATCH_SIZE) return;
        }
      });
      for (const { thread_id: threadId } of threads) {
        const tombstone = sql`(
          SELECT json_remove(json_set(payload_json, '$.title', ${DELETED_THREAD_TITLE}), '$.guestShare')
          FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}
        )`;
        yield* sql`
          UPDATE orchestration_events
          SET payload_json = json_remove(
            json_set(payload_json, '$.title', ${DELETED_THREAD_TITLE}),
            '$.guestShare'
          )
          WHERE application_event_version = 2
            AND aggregate_kind = 'thread'
            AND stream_id = ${threadId}
            AND event_type IN ('thread.created', 'thread.deleted')
        `;
        // The head row only holds the stream's position, so any other head becomes the tombstone.
        // First, so the head never borrows a prompt from an anchor already deleted below.
        yield* sql`
          UPDATE orchestration_events
          SET event_type = 'thread.deleted', payload_json = ${tombstone}, metadata_json = '{}'
          WHERE sequence = (
              SELECT MAX(sequence) FROM orchestration_events
              WHERE application_event_version = 2
                AND aggregate_kind = 'thread'
                AND stream_id = ${threadId}
            )
            AND event_type NOT IN ('thread.created', 'thread.deleted')
            AND NOT (
              event_type = 'run.updated' AND json_extract(payload_json, '$.status') = 'running'
            )
        `;
        for (const table of DELETED_THREAD_CONTENT_TABLES) {
          yield* drain(sql`
            DELETE FROM ${sql(table)}
            WHERE rowid IN (
              SELECT rowid FROM ${sql(table)} WHERE thread_id = ${threadId} LIMIT ${PURGE_BATCH_SIZE}
            )
            RETURNING 1 AS purged
          `);
        }
        // Keep only what the pruner keeps for any stream: replay still delivers the deletion.
        yield* drain(sql`
          DELETE FROM orchestration_events
          WHERE sequence IN (
            SELECT sequence FROM orchestration_events
              INDEXED BY idx_orchestration_events_agent_stream_sequence
            WHERE application_event_version = 2
              AND aggregate_kind = 'thread'
              AND stream_id = ${threadId}
              AND event_type NOT IN ('thread.created', 'thread.deleted')
              AND NOT (
                event_type = 'run.updated' AND json_extract(payload_json, '$.status') = 'running'
              )
              AND sequence < (
                SELECT MAX(sequence) FROM orchestration_events
                WHERE application_event_version = 2
                  AND aggregate_kind = 'thread'
                  AND stream_id = ${threadId}
              )
            -- Newest first: a row borrowing its prompt goes before the anchor it borrows from.
            ORDER BY sequence DESC
            LIMIT ${PURGE_BATCH_SIZE}
          )
          RETURNING 1 AS purged
        `);
        // Settled requests can hold answers, feedback, and titles. A failed one stays as the
        // marker that keeps a deleted thread's worktree, so only its text goes.
        yield* sql`
          DELETE FROM orchestration_v2_effect_outbox
          WHERE thread_id = ${threadId} AND status IN ('succeeded', 'cancelled')
        `;
        yield* sql`
          UPDATE orchestration_v2_effect_outbox
          SET payload_json = CASE
            WHEN json_type(payload_json, '$.title') = 'text'
              THEN json_set(payload_json, '$.title', ${DELETED_THREAD_TITLE})
            ELSE json_remove(payload_json, '$.feedback', '$.answers')
          END,
            last_error = NULL
          WHERE thread_id = ${threadId} AND status = 'failed'
        `;
        // Its v1 events then go with the imported-history prune, and no import refills it.
        yield* sql`
          UPDATE orchestration_v2_legacy_imports
          SET transcript_imported_at = ${now}
          WHERE thread_id = ${threadId} AND transcript_imported_at IS NULL
        `;
        // Last, because the new title is what marks the purge as done.
        yield* sql`
          UPDATE projection_threads SET title = ${DELETED_THREAD_TITLE} WHERE thread_id = ${threadId}
        `;
        yield* sql`
          UPDATE orchestration_v2_projection_threads
          SET title = ${DELETED_THREAD_TITLE}, payload_json = ${tombstone}
          WHERE thread_id = ${threadId}
        `;
      }
      return purged;
    });

    const purgeDeletedThread: ProjectionMaintenanceV2Shape["purgeDeletedThread"] = (threadId) =>
      purgeThreads(threadId, Effect.void).pipe(
        Effect.withSpan("ProjectionMaintenance.purgeDeletedThread"),
        Effect.mapError(
          (cause) => new ProjectionMaintenanceError({ operation: "purge deleted thread", cause }),
        ),
      );

    // A pass prunes through the mark the previous pass left once that mark is a day old, so
    // at least RETAINED_EVENT_HISTORY of events always remains. Receipts stay for idempotency.
    const pruneEventStore = Effect.fn("ProjectionMaintenance.pruneEventStore")(
      function* (betweenPages: Effect.Effect<void> = Effect.void) {
        const now = yield* DateTime.now;
        const metadata = yield* sql<MetadataRow>`
          SELECT projection_name, last_sequence, updated_at
          FROM orchestration_v2_projection_metadata
          WHERE projection_name IN (
            'thread-projections', ${EVENT_LOG_PRUNE_MARK}, ${EVENT_LOG_PRUNED_THROUGH}
          )
        `.pipe(NodeSqliteClient.readOnly);
        const read = (name: string) => metadata.find((row) => row.projection_name === name);
        const projected = read("thread-projections")?.last_sequence ?? 0;
        const mark = read(EVENT_LOG_PRUNE_MARK);
        const prunedThrough = read(EVENT_LOG_PRUNED_THROUGH)?.last_sequence ?? 0;
        // Fixed bounds: foreground commits during the pass wait for the next one.
        const bounds = yield* sql<{ readonly sequence: number; readonly receipt_row_id: number }>`
          SELECT
            COALESCE((SELECT MAX(sequence) FROM orchestration_events), 0) AS sequence,
            COALESCE((SELECT MAX(rowid) FROM orchestration_command_receipts), 0) AS receipt_row_id
        `.pipe(NodeSqliteClient.readOnly);
        const head = bounds[0]?.sequence ?? 0;

        let deletedEventCount = 0;
        const markIsDue =
          mark !== undefined &&
          DateTime.toEpochMillis(now) - Date.parse(mark.updated_at) >=
            Duration.toMillis(RETAINED_EVENT_HISTORY);
        if (mark !== undefined && markIsDue) {
          const throughSequence = Math.max(Math.min(mark.last_sequence, projected), prunedThrough);
          if (throughSequence > prunedThrough) {
            // Publish the boundary first so resuming clients take a snapshot, never a partial replay.
            yield* writeMetadata(EVENT_LOG_PRUNED_THROUGH, throughSequence, now);
          }
          deletedEventCount += yield* pruneEvents(throughSequence, head, betweenPages);
        }
        if (mark === undefined || markIsDue) yield* writeMetadata(EVENT_LOG_PRUNE_MARK, head, now);

        // Catches threads deleted before purging existed, and any purge a crash interrupted.
        // It runs first so the legacy prune below takes the v1 events of threads it marks.
        const purgedRowCount = yield* purgeThreads(undefined, betweenPages);

        const legacy = yield* pruneImportedLegacyHistory(
          head,
          bounds[0]?.receipt_row_id ?? 0,
          betweenPages,
        );
        deletedEventCount += legacy.deletedEventCount;
        deletedEventCount += yield* pruneSupersededUpdates(now, head, betweenPages);
        const compactedTurnItemCount = yield* compactSettledTurnItems(now, betweenPages);

        const freelistRows = yield* sql<{ readonly freelist_count: number }>`PRAGMA freelist_count`;
        const pageSizeRows = yield* sql<{ readonly page_size: number }>`PRAGMA page_size`;
        const reclaimableBytes =
          (freelistRows[0]?.freelist_count ?? 0) * (pageSizeRows[0]?.page_size ?? 0);

        return {
          deletedEventCount,
          deletedReceiptCount: legacy.deletedReceiptCount,
          compactedTurnItemCount,
          purgedRowCount,
          reclaimableBytes,
        };
      },
      Effect.mapError(
        (cause) => new ProjectionMaintenanceError({ operation: "prune event store", cause }),
      ),
    );

    return ProjectionMaintenanceV2.of({ pruneEventStore, purgeDeletedThread });
  }),
);
