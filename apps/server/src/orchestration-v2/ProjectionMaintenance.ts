import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

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
  /** Deletes events the projections already cover once they are older than the retained history. */
  readonly pruneEventStore: (betweenPages?: Effect.Effect<void>) => Effect.Effect<
    {
      readonly deletedEventCount: number;
      readonly deletedReceiptCount: number;
      readonly compactedTurnItemCount: number;
      readonly reclaimableBytes: number;
    },
    ProjectionMaintenanceError
  >;
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

// Fork retention (docs/operations/fork.md#state-retention): whole-snapshot updates a newer one
// replaces. Each entity keeps its first update, where client reducers place it, and its newest.
const SUPERSEDABLE_EVENT_TYPES = ["turn-item.updated", "node.updated"] as const;
const SUPERSEDED_MARK = "event-log-superseded-mark";
const SUPERSEDED_THROUGH = "event-log-superseded-through";
// Command-id retries replay their own events; keep recent updates for them.
const SUPERSEDED_GRACE = Duration.hours(1);
const SETTLED_THREAD_AGE = Duration.days(7);
const TURN_ITEMS_COMPACTED_BEFORE = "turn-items-compacted-before";
const KEPT_OUTPUT_CHARS = 8192;
const COMPACTED_OUTPUT_MIN_CHARS = 2 * KEPT_OUTPUT_CHARS + 1024;
// Each rewritten row is parsed several times; bound one statement's work by bytes.
const UPDATE_PAGE_BYTES = 4 * 1024 * 1024;
const SETTLED_ITEM_STATUSES = ["completed", "failed", "interrupted", "cancelled"] as const;

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
    // text tool output keeps only its ends and reasoning text is cleared. Clients render both.
    const compactSettledTurnItems = Effect.fn("ProjectionMaintenance.compactSettledTurnItems")(
      function* (now: DateTime.Utc, betweenPages: Effect.Effect<void>) {
        const cutoff = DateTime.subtractDuration(now, SETTLED_THREAD_AGE);
        const cutoffIso = DateTime.formatIso(cutoff);
        const previous = yield* sql<MetadataRow>`
          SELECT projection_name, last_sequence, updated_at
          FROM orchestration_v2_projection_metadata
          WHERE projection_name = ${TURN_ITEMS_COMPACTED_BEFORE}
        `.pipe(NodeSqliteClient.readOnly);
        // Settling bumps updated_at, so a thread settled later enters a later window.
        const threads = yield* sql<{ readonly thread_id: string }>`
          SELECT thread_id FROM orchestration_v2_projection_threads
          WHERE updated_at < ${cutoffIso} AND updated_at >= ${previous[0]?.updated_at ?? ""}
            AND json_extract(payload_json, '$.settledAt') IS NOT NULL
        `.pipe(NodeSqliteClient.readOnly);
        const output = sql`json_extract(payload_json, '$.output')`;
        const compactable = sql`
          status IN ${sql.in(SETTLED_ITEM_STATUSES)}
          AND (
            (type IN ('command_execution', 'dynamic_tool')
              AND length(payload_json) > ${COMPACTED_OUTPUT_MIN_CHARS}
              AND json_type(payload_json, '$.output') = 'text')
            OR (type = 'reasoning' AND json_extract(payload_json, '$.text') <> '')
          )
        `;
        let compacted = 0;
        for (const { thread_id: threadId } of threads) {
          const items: Array<{ readonly turn_item_id: string; readonly size: number }> = [];
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
              const page = yield* sql<{ readonly turn_item_id: string; readonly size: number }>`
                SELECT turn_item_id, length(payload_json) AS size
                FROM orchestration_v2_projection_turn_items
                WHERE turn_item_id IN ${sql.in(rows.map((row) => row.turn_item_id))} AND ${compactable}
              `.pipe(NodeSqliteClient.readOnly);
              items.push(...page);
              cursor = { ordinal: last.ordinal, id: last.turn_item_id };
            }
            yield* betweenPages;
            if (rows.length < PAGE_SIZE) break;
          }
          const pages: Array<Array<string>> = [];
          let pageBytes = 0;
          for (const item of items) {
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
          for (const ids of pages) {
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
                AND ${compactable}
                AND (type = 'reasoning' OR length(${output}) > ${COMPACTED_OUTPUT_MIN_CHARS})
                AND EXISTS (
                  SELECT 1 FROM orchestration_v2_projection_threads AS thread
                  WHERE thread.thread_id = ${threadId} AND thread.updated_at < ${cutoffIso}
                    AND json_extract(thread.payload_json, '$.settledAt') IS NOT NULL
                )
              RETURNING turn_item_id
            `;
            compacted += updated.length;
            yield* Effect.yieldNow;
            yield* betweenPages;
          }
        }
        yield* writeMetadata(TURN_ITEMS_COMPACTED_BEFORE, 0, cutoff);
        return compacted;
      },
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
          reclaimableBytes,
        };
      },
      Effect.mapError(
        (cause) => new ProjectionMaintenanceError({ operation: "prune event store", cause }),
      ),
    );

    return ProjectionMaintenanceV2.of({ pruneEventStore });
  }),
);
