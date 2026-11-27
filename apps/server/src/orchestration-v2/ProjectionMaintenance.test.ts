import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  NodeId,
  PlanId,
  CommandId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2TurnItem,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import { MCP_APP_OUTPUT_KEY } from "@t3tools/shared/mcpApp";
import {
  compactDynamicToolOutput,
  htmlRenderFromToolItem,
  mcpAppFromToolItem,
  toolOutputImages,
} from "@t3tools/shared/toolOutput";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionMaintenance from "./ProjectionMaintenance.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as WireProjection from "./WireProjection.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";

const database = SqlitePersistence.layerMemory;
const eventStoreProvided = EventStore.layer.pipe(Layer.provideMerge(database));
const projectionStoreProvided = ProjectionStore.layer.pipe(Layer.provideMerge(database));
const stores = Layer.mergeAll(database, eventStoreProvided, projectionStoreProvided);
const layerTest = Layer.mergeAll(
  stores,
  OrchestrationEventStore.layer.pipe(Layer.provide(database)),
  EventSink.layer.pipe(Layer.provide(stores)),
  ProjectionMaintenance.layer.pipe(Layer.provide(stores)),
);

const providerInstanceId = ProviderInstanceId.make("codex");
const providerDriver = ProviderDriverKind.make("codex");
const modelSelection = { instanceId: providerInstanceId, model: "gpt-5.4" };

function makeThread(threadId: ThreadId, now: DateTime.Utc): OrchestrationV2AppThread {
  return {
    id: threadId,
    projectId: ProjectId.make(`project:${threadId}`),
    title: "Turn item compaction",
    providerInstanceId,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}

function threadCreated(thread: OrchestrationV2AppThread, now: DateTime.Utc) {
  return {
    id: EventId.make("event:turn-item-compaction:thread"),
    type: "thread.created",
    threadId: thread.id,
    providerInstanceId,
    occurredAt: now,
    payload: thread,
  } satisfies OrchestrationV2DomainEvent;
}

const itemSpecs = [
  { key: "command", type: "command_execution", ordinal: 10 },
  { key: "reasoning", type: "reasoning", ordinal: 20 },
  { key: "todo", type: "todo_list", ordinal: 30 },
  { key: "commanded", type: "command_execution", ordinal: 40 },
] as const;

function itemEvent(
  threadId: ThreadId,
  now: DateTime.Utc,
  spec: (typeof itemSpecs)[number],
  revision: number,
  eventId = `event:turn-item-compaction:${spec.key}:${revision}`,
): OrchestrationV2DomainEvent {
  const id = TurnItemId.make(`turn-item:compaction:${spec.key}`);
  const growing = `${spec.key}:${revision}:` + "x".repeat((revision + 1) * 192);
  const completed = revision === 69;
  const base = {
    id,
    threadId,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: spec.ordinal,
    status: completed ? ("completed" as const) : ("running" as const),
    title: spec.key,
    startedAt: now,
    completedAt: completed ? now : null,
    updatedAt: now,
  };
  let payload: OrchestrationV2TurnItem;
  switch (spec.type) {
    case "command_execution":
      payload = {
        ...base,
        type: "command_execution",
        input: `run ${spec.key}`,
        output: growing,
      };
      break;
    case "reasoning":
      payload = { ...base, type: "reasoning", text: growing, streaming: !completed };
      break;
    case "todo_list":
      payload = {
        ...base,
        type: "todo_list",
        planId: PlanId.make("plan:turn-item-compaction"),
        steps: [{ id: "step", text: growing, status: completed ? "completed" : "running" }],
        explanation: growing,
      };
      break;
  }
  return {
    id: EventId.make(eventId),
    type: "turn-item.updated",
    threadId,
    occurredAt: now,
    payload,
  };
}

function subagentEvents(
  threadId: ThreadId,
  now: DateTime.Utc,
  revision: number,
  eventSuffix = String(revision),
): ReadonlyArray<OrchestrationV2DomainEvent> {
  const id = NodeId.make("subagent:turn-item-compaction");
  const prompt = revision === 0 ? "Review prompt A. ".repeat(40) : "Review prompt B. ".repeat(40);
  const progress = `Review progress ${revision}`;
  return [
    {
      id: EventId.make(`event:turn-item-compaction:subagent:${eventSuffix}`),
      type: "subagent.updated",
      threadId,
      occurredAt: now,
      payload: {
        id,
        threadId,
        runId: null,
        parentNodeId: NodeId.make("node:turn-item-compaction-parent"),
        origin: "provider_native",
        createdBy: "agent",
        driver: providerDriver,
        providerInstanceId,
        providerThreadId: null,
        childThreadId: null,
        nativeTaskRef: {
          driver: providerDriver,
          nativeId: "compaction-review",
          strength: "strong",
        },
        prompt,
        progress,
        title: "Review",
        model: null,
        status: "running",
        result: null,
        startedAt: now,
        completedAt: null,
        updatedAt: now,
      },
    },
    {
      id: EventId.make(`event:turn-item-compaction:subagent-item:${eventSuffix}`),
      type: "turn-item.updated",
      threadId,
      occurredAt: now,
      payload: {
        id: TurnItemId.make("turn-item:compaction:subagent"),
        threadId,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 50,
        status: "running",
        title: "Review",
        startedAt: now,
        completedAt: null,
        updatedAt: now,
        type: "subagent",
        subagentId: id,
        origin: "provider_native",
        driver: providerDriver,
        providerInstanceId,
        childThreadId: null,
        prompt,
        progress,
        result: null,
      },
    },
  ] satisfies ReadonlyArray<OrchestrationV2DomainEvent>;
}

const insertRunningRunUpdate = (threadId: ThreadId) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql<{ readonly sequence: number }>`
      INSERT INTO orchestration_events (
        event_id, aggregate_kind, stream_id, stream_version, event_type,
        occurred_at, actor_kind, payload_json, metadata_json, application_event_version
      ) VALUES (
        'event:prune:run-running', 'thread', ${threadId},
        (SELECT MAX(stream_version) + 1 FROM orchestration_events WHERE stream_id = ${threadId}),
        'run.updated', '2026-11-01T00:00:00.000Z', 'server', '{"status":"running"}', '{}', 2
      ) RETURNING sequence
    `,
  );

const remainingEventIds = (threadId: ThreadId) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql<{ readonly event_id: string }>`
      SELECT event_id FROM orchestration_events WHERE stream_id = ${threadId} ORDER BY sequence
    `,
  ).pipe(Effect.map((rows) => rows.map((row) => row.event_id)));

it.effect("prunes events the projections cover once the retained day has passed", () =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const eventStore = yield* EventStore.EventStoreV2;
    const events = yield* OrchestrationEventStore.OrchestrationEventStore;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
    const now = yield* DateTime.now;
    const threadId = ThreadId.make("thread:prune");
    yield* sink.write({ events: [threadCreated(makeThread(threadId, now), now)] });
    for (const revision of [0, 1, 2]) {
      yield* sink.write({ events: [itemEvent(threadId, now, itemSpecs[0], revision)] });
    }
    yield* sink.write({ events: subagentEvents(threadId, now, 0) });
    yield* insertRunningRunUpdate(threadId);
    yield* sink.write({ events: [itemEvent(threadId, now, itemSpecs[1], 0)] });

    // The first pass only marks the head; nothing is a day old yet.
    assert.equal((yield* maintenance.pruneEventStore()).deletedEventCount, 0);
    const markedThrough = yield* eventStore.latestSequence();

    // Repeating prompt A borrows it from the anchors written before the mark.
    yield* sink.write({ events: subagentEvents(threadId, now, 0, "repeat") });
    yield* sink.write({ events: [itemEvent(threadId, now, itemSpecs[0], 3)] });
    const highWater = yield* eventStore.latestSequence();
    const projection = yield* projections.getThreadProjection(threadId);

    // Before the day passes, only the command's middle updates go; its first and newest stay.
    yield* TestClock.adjust("23 hours");
    assert.equal((yield* maintenance.pruneEventStore()).deletedEventCount, 2);
    assert.notInclude(yield* remainingEventIds(threadId), "event:turn-item-compaction:command:1");
    assert.include(yield* remainingEventIds(threadId), "event:turn-item-compaction:command:0");
    yield* TestClock.adjust("1 hour");
    assert.equal((yield* maintenance.pruneEventStore()).deletedEventCount, 2);

    assert.deepEqual(yield* remainingEventIds(threadId), [
      "event:turn-item-compaction:thread",
      "event:turn-item-compaction:subagent:0",
      "event:turn-item-compaction:subagent-item:0",
      "event:prune:run-running",
      "event:turn-item-compaction:subagent:repeat",
      "event:turn-item-compaction:subagent-item:repeat",
      "event:turn-item-compaction:command:3",
    ]);
    assert.equal(yield* events.prunedThroughSequence, markedThrough);
    assert.equal(yield* eventStore.latestSequence(), highWater);
    assert.equal(yield* eventStore.latestSequence({ threadId }), highWater);
    assert.deepEqual(yield* projections.getThreadProjection(threadId), projection);
    const repeated = yield* eventStore
      .read({ threadId, eventType: "subagent.updated", afterSequence: markedThrough })
      .pipe(Stream.runCollect);
    assert.deepEqual(
      Array.from(repeated, (stored) =>
        stored.event.type === "subagent.updated" ? stored.event.payload.prompt : null,
      ),
      ["Review prompt A. ".repeat(40)],
    );
  }).pipe(Effect.provide(layerTest)),
);

function nodeEvent(
  threadId: ThreadId,
  now: DateTime.Utc,
  revision: number,
): OrchestrationV2DomainEvent {
  const nodeId = NodeId.make("node:superseded");
  const runId = RunId.make("run:superseded");
  return {
    id: EventId.make(`event:superseded:node:${revision}`),
    type: "node.updated",
    threadId,
    runId,
    nodeId,
    driver: providerDriver,
    occurredAt: now,
    payload: {
      id: nodeId,
      threadId,
      runId,
      rootNodeId: nodeId,
      parentNodeId: null,
      kind: "subagent",
      status: revision === 2 ? "completed" : "running",
      countsForRun: false,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      runtimeRequestId: null,
      checkpointScopeId: null,
      startedAt: now,
      completedAt: revision === 2 ? now : null,
    },
  };
}

it.effect("drops superseded updates an hour after the pass that marked them", () =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
    const now = yield* DateTime.now;
    const threadId = ThreadId.make("thread:superseded");
    yield* sink.write({ events: [threadCreated(makeThread(threadId, now), now)] });
    for (const revision of [0, 1, 2, 3]) {
      yield* sink.write({ events: [itemEvent(threadId, now, itemSpecs[0], revision)] });
    }
    for (const revision of [0, 1, 2]) {
      yield* sink.write({
        events: [itemEvent(threadId, now, itemSpecs[3], revision)],
        commandId: CommandId.make(`command:superseded:${revision}`),
      });
      yield* sink.write({ events: [nodeEvent(threadId, now, revision)] });
    }
    // b2 and b3 borrow prompt B from b1, so b1 stays although a newer update replaces it.
    for (const [revision, suffix] of [
      [0, "a0"],
      [1, "b1"],
      [1, "b2"],
      [1, "b3"],
    ] as const) {
      yield* sink.write({ events: subagentEvents(threadId, now, revision, suffix) });
    }

    assert.equal((yield* maintenance.pruneEventStore()).deletedEventCount, 0);
    assert.equal((yield* maintenance.pruneEventStore()).deletedEventCount, 0);
    yield* TestClock.adjust("1 hour");
    assert.equal((yield* maintenance.pruneEventStore()).deletedEventCount, 4);

    const remaining = yield* remainingEventIds(threadId);
    for (const dropped of [
      "event:turn-item-compaction:command:1",
      "event:turn-item-compaction:command:2",
      "event:superseded:node:1",
      "event:turn-item-compaction:subagent-item:b2",
    ]) {
      assert.notInclude(remaining, dropped);
    }
    for (const kept of [
      "event:turn-item-compaction:command:0",
      "event:turn-item-compaction:command:3",
      "event:turn-item-compaction:commanded:1",
      "event:superseded:node:0",
      "event:superseded:node:2",
      "event:turn-item-compaction:subagent-item:b1",
      "event:turn-item-compaction:subagent-item:b3",
    ]) {
      assert.include(remaining, kept);
    }
  }).pipe(Effect.provide(layerTest)),
);

function commandEvent(
  threadId: ThreadId,
  now: DateTime.Utc,
  key: string,
  status: "running" | "completed",
  output: unknown,
  toolName = "view_image",
): OrchestrationV2DomainEvent {
  const tool =
    typeof output === "string"
      ? { type: "command_execution" as const, input: `run ${key}`, output }
      : { type: "dynamic_tool" as const, toolName, input: {}, output };
  return {
    id: EventId.make(`event:settled:${threadId}:${key}`),
    type: "turn-item.updated",
    threadId,
    occurredAt: now,
    payload: {
      id: TurnItemId.make(`turn-item:settled:${threadId}:${key}`),
      threadId,
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 100,
      status,
      title: key,
      startedAt: now,
      completedAt: status === "completed" ? now : null,
      updatedAt: now,
      ...tool,
    },
  };
}

it.effect("trims tool output and clears reasoning of threads settled for seven days", () =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
    const output = "head:" + "x".repeat(40_000) + ":tail";
    const settledId = ThreadId.make("thread:settled");
    const createdAt = yield* DateTime.now;
    const settled = {
      ...makeThread(settledId, createdAt),
      settledOverride: "settled" as const,
      settledAt: createdAt,
    };
    yield* sink.write({
      events: [
        { ...threadCreated(settled, createdAt), id: EventId.make("e:s") },
        commandEvent(settledId, createdAt, "done", "completed", output),
        commandEvent(settledId, createdAt, "stuck", "running", output),
        itemEvent(settledId, createdAt, itemSpecs[1], 69),
        commandEvent(settledId, createdAt, "structured", "completed", [
          { type: "text", text: output },
        ]),
        commandEvent(settledId, createdAt, "structured-small", "completed", [
          { type: "text", text: "short" },
        ]),
      ],
    });
    const smallStructuredBefore = (yield* projections.getThreadProjection(
      settledId,
    )).turnItems.find((item) => item.id.endsWith(":structured-small"));
    const activeId = ThreadId.make("thread:active");
    yield* sink.write({
      events: [
        { ...threadCreated(makeThread(activeId, createdAt), createdAt), id: EventId.make("e:a") },
        commandEvent(activeId, createdAt, "done", "completed", output),
      ],
    });
    const active = yield* projections.getThreadProjection(activeId);
    yield* TestClock.adjust("6 days");
    const recentId = ThreadId.make("thread:recent");
    const recentAt = yield* DateTime.now;
    yield* sink.write({
      events: [
        {
          ...threadCreated(
            { ...makeThread(recentId, recentAt), settledOverride: "settled", settledAt: recentAt },
            recentAt,
          ),
          id: EventId.make("e:r"),
        },
        commandEvent(recentId, recentAt, "done", "completed", output),
      ],
    });
    const recent = yield* projections.getThreadProjection(recentId);
    yield* TestClock.adjust("25 hours");

    assert.equal((yield* maintenance.pruneEventStore()).compactedTurnItemCount, 3);
    const items = (yield* projections.getThreadProjection(settledId)).turnItems;
    const outputOf = (key: string) => {
      const item = items.find((entry) => entry.id.endsWith(`:${key}`));
      return item?.type === "command_execution" ? item.output : undefined;
    };
    const trimmed = outputOf("done") ?? "";
    assert.isTrue(trimmed.startsWith("head:" + "x".repeat(8187)));
    assert.isTrue(trimmed.endsWith("x".repeat(8187) + ":tail"));
    assert.include(trimmed, "removed 23626 characters");
    assert.equal(outputOf("stuck"), output);
    const reasoning = items.find((item) => item.type === "reasoning");
    assert.equal(reasoning?.type === "reasoning" ? reasoning.text : null, "");
    const structuredAfter = items.find((item) => item.id.endsWith(":structured"));
    assert.equal(structuredAfter?.type, "dynamic_tool");
    const structuredBlock =
      structuredAfter?.type === "dynamic_tool" && Array.isArray(structuredAfter.output)
        ? (structuredAfter.output[0] as { type: string; text: string })
        : undefined;
    assert.equal(structuredBlock?.type, "text");
    assert.isTrue(structuredBlock?.text.startsWith("head:" + "x".repeat(4091)));
    assert.isTrue(structuredBlock?.text.endsWith("x".repeat(4091) + ":tail"));
    assert.include(structuredBlock?.text ?? "", "removed 31818 characters");
    assert.deepEqual(
      items.find((item) => item.id.endsWith(":structured-small")),
      smallStructuredBefore,
    );
    assert.deepEqual(yield* projections.getThreadProjection(recentId), recent);
    assert.deepEqual(yield* projections.getThreadProjection(activeId), active);

    assert.equal((yield* maintenance.pruneEventStore()).compactedTurnItemCount, 0);
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "compacts structured dynamic_tool object and array outputs while preserving UI metadata",
  () =>
    Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
      const threadId = ThreadId.make("thread:structured");
      const createdAt = yield* DateTime.now;
      const settled = {
        ...makeThread(threadId, createdAt),
        settledOverride: "settled" as const,
        settledAt: createdAt,
      };
      const fileContent = "start:" + "f".repeat(30_000) + ":end";
      const imageBase64 = "A".repeat(40_000);
      const wideMessages = Array.from({ length: 120 }, (_, index) => ({
        id: `msg-${index}`,
        role: "assistant",
        text: `message ${index}: ` + "m".repeat(250),
      }));
      const threadReadStructured = {
        thread: { threadId: "thread:referenced" },
        messages: wideMessages,
      };
      const mcpAppRef = {
        attachmentId: "att-app-1",
        server: "demo",
        tool: "chart",
        resourceUri: "ui://demo/chart",
      };
      const htmlRenderRef = {
        attachmentId: "att-html-1",
        title: "Report",
        height: 400,
      };

      yield* sink.write({
        events: [
          { ...threadCreated(settled, createdAt), id: EventId.make("e:structured:thread") },
          commandEvent(
            threadId,
            createdAt,
            "read-file",
            "completed",
            {
              type: "text",
              file: { filePath: "/repo/index.ts", content: fileContent, numLines: 900 },
            },
            "Read",
          ),
          commandEvent(
            threadId,
            createdAt,
            "images",
            "completed",
            [
              {
                type: "image",
                source: { type: "base64", media_type: "image/png", data: imageBase64 },
              },
              { type: "image", mimeType: "image/jpeg", data: imageBase64 },
              { type: "text", text: "captured screenshot" },
            ],
            "cua_repl.js",
          ),
          commandEvent(
            threadId,
            createdAt,
            "mcp-duplicate",
            "completed",
            {
              content: JSON.stringify(threadReadStructured),
              structuredContent: threadReadStructured,
            },
            "mcp__t3-code__t3_thread_read",
          ),
          commandEvent(
            threadId,
            createdAt,
            "wide-object",
            "completed",
            { pull_request: { number: 42 }, comments: wideMessages },
            "codex_apps.github.fetch_pr",
          ),
          commandEvent(
            threadId,
            createdAt,
            "wide-error",
            "completed",
            { isError: true, comments: wideMessages },
            "codex_apps.github.fetch_pr",
          ),
          commandEvent(
            threadId,
            createdAt,
            "mcp-app",
            "completed",
            {
              [MCP_APP_OUTPUT_KEY]: mcpAppRef,
              result: [{ type: "image", mimeType: "image/png", data: imageBase64 }],
            },
            "demo.chart",
          ),
          commandEvent(
            threadId,
            createdAt,
            "multi-text-blocks",
            "completed",
            [
              { type: "text", text: "block-1\n" + "b".repeat(8000) },
              { type: "text", text: "block-2\n" + "c".repeat(8000) },
              { type: "text", text: "block-3\n" + "d".repeat(8000) },
            ],
            "cua_repl.js",
          ),
          commandEvent(
            threadId,
            createdAt,
            "html-render",
            "completed",
            { htmlRender: htmlRenderRef, logs: "z".repeat(30_000) },
            "t3-code.html_render",
          ),
        ],
      });

      yield* TestClock.adjust("8 days");
      assert.equal((yield* maintenance.pruneEventStore()).compactedTurnItemCount, 8);

      const items = (yield* projections.getThreadProjection(threadId)).turnItems;
      const itemOf = (key: string) => {
        const found = items.find((entry) => entry.id.endsWith(`:${key}`));
        assert.equal(found?.type, "dynamic_tool");
        if (found?.type !== "dynamic_tool") throw new Error(`Missing dynamic_tool ${key}`);
        return found;
      };

      // Read-style nested object keeps metadata and trims file.content.
      const readItem = itemOf("read-file");
      const readOut = readItem.output as {
        type: string;
        file: { filePath: string; content: string; numLines: number };
      };
      assert.equal(readOut.file.filePath, "/repo/index.ts");
      assert.equal(readOut.file.numLines, 900);
      assert.isTrue(readOut.file.content.startsWith("start:" + "f".repeat(4090)));
      assert.isTrue(readOut.file.content.endsWith("f".repeat(4090) + ":end"));
      assert.include(readOut.file.content, "removed 21818 characters");

      // Embedded base64 images become text notices so clients do not request missing assets.
      const imageItem = itemOf("images");
      assert.deepEqual(toolOutputImages(imageItem.output), []);
      assert.isTrue(Array.isArray(imageItem.output));
      const imageBlocks = imageItem.output as Array<{ type: string; text: string }>;
      assert.equal(imageBlocks.length, 3);
      assert.include(imageBlocks[0]?.text ?? "", "removed an image (image/png, 40000 base64");
      assert.include(imageBlocks[1]?.text ?? "", "removed an image (image/jpeg, 40000 base64");
      assert.equal(imageBlocks[2]?.text, "captured screenshot");

      // MCP content + structuredContent drops the huge duplicate and preserves thread metadata.
      const mcpDupItem = itemOf("mcp-duplicate");
      assert.isAtMost(JSON.stringify(mcpDupItem.output).length, 17_408);
      assert.deepEqual(compactDynamicToolOutput(mcpDupItem.output), {
        thread: { threadId: "thread:referenced" },
      });

      // Wide object with no single huge string still compacts under the limit.
      const wideItem = itemOf("wide-object");
      assert.equal(typeof wideItem.output, "string");
      assert.isAtMost((wideItem.output as string).length, 17_408);
      assert.include(wideItem.output as string, "T3 Code removed");

      // Error flag is preserved across wide-object compaction.
      const wideErrorItem = itemOf("wide-error");
      assert.isAtMost(JSON.stringify(wideErrorItem.output).length, 17_408);
      assert.equal(compactDynamicToolOutput(wideErrorItem.output)?.isError, true);

      // MCP app reference stays intact while its bulky result is compacted.
      const mcpAppItem = itemOf("mcp-app");
      assert.deepEqual(mcpAppFromToolItem(mcpAppItem), mcpAppRef);
      assert.isAtMost(JSON.stringify(mcpAppItem.output).length, 17_408);

      // Multi-block text arrays flatten to readable text instead of escaped JSON.
      const multiBlockItem = itemOf("multi-text-blocks");
      assert.equal(typeof multiBlockItem.output, "string");
      assert.isTrue((multiBlockItem.output as string).startsWith("block-1\n"));
      assert.isAtMost((multiBlockItem.output as string).length, 17_408);
      assert.include(multiBlockItem.output as string, "T3 Code removed");

      // HTML render reference stays intact for timeline rendering and attachment retention.
      const htmlRenderItem = itemOf("html-render");
      assert.deepEqual(htmlRenderFromToolItem(htmlRenderItem), htmlRenderRef);
      assert.isAtMost(JSON.stringify(htmlRenderItem.output).length, 17_408);

      // Every compacted item projects cleanly for both wire snapshots and on-demand detail fetches.
      for (const item of items) {
        const wire = WireProjection.projectTurnItemForWire(item);
        const detail = WireProjection.projectTurnItemForDetail(item);
        assert.equal(wire.id, item.id);
        assert.equal(detail.id, item.id);
      }

      // Idempotent on a second pass.
      assert.equal((yield* maintenance.pruneEventStore()).compactedTurnItemCount, 0);
    }).pipe(Effect.provide(layerTest)),
);

it.effect("backfills already-settled threads past the v1 watermark without rescanning", () =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
    const sql = yield* SqlClient.SqlClient;
    const createdAt = yield* DateTime.now;
    const oldThreadId = ThreadId.make("thread:backfill-old");
    const oldSettled = {
      ...makeThread(oldThreadId, createdAt),
      settledOverride: "settled" as const,
      settledAt: createdAt,
    };
    yield* sink.write({
      events: [
        { ...threadCreated(oldSettled, createdAt), id: EventId.make("e:bf:old") },
        commandEvent(
          oldThreadId,
          createdAt,
          "img",
          "completed",
          [{ type: "image", mimeType: "image/jpeg", data: "B".repeat(50_000) }],
          "cua_repl.js",
        ),
      ],
    });

    // Simulate a database already compacted past oldThreadId under the v1 text-only watermark.
    yield* TestClock.adjust("1 day");
    const v1WatermarkAt = yield* DateTime.now;
    yield* sql`
      INSERT INTO orchestration_v2_projection_metadata (
        projection_name, schema_version, last_sequence, updated_at
      )
      VALUES (
        'turn-items-compacted-before',
        ${ProjectionStore.ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION},
        0,
        ${DateTime.formatIso(v1WatermarkAt)}
      )
    `;

    const newerThreadId = ThreadId.make("thread:backfill-new");
    const newerSettled = {
      ...makeThread(newerThreadId, v1WatermarkAt),
      settledOverride: "settled" as const,
      settledAt: v1WatermarkAt,
    };
    yield* sink.write({
      events: [
        { ...threadCreated(newerSettled, v1WatermarkAt), id: EventId.make("e:bf:new") },
        commandEvent(
          newerThreadId,
          v1WatermarkAt,
          "img",
          "completed",
          [{ type: "image", mimeType: "image/png", data: "C".repeat(50_000) }],
          "cua_repl.js",
        ),
      ],
    });

    // At +7.5 days, oldThreadId is >=7d old (behind v1 watermark) while newerThreadId is 6.5d old.
    yield* TestClock.adjust("156 hours");
    assert.equal((yield* maintenance.pruneEventStore()).compactedTurnItemCount, 1);

    const oldItem = (yield* projections.getThreadProjection(oldThreadId)).turnItems[0];
    assert.equal(oldItem?.type, "dynamic_tool");
    assert.deepEqual(
      oldItem?.type === "dynamic_tool" ? toolOutputImages(oldItem.output) : null,
      [],
    );
    const v2Watermark = yield* sql<{ readonly updated_at: string }>`
      SELECT updated_at FROM orchestration_v2_projection_metadata
      WHERE projection_name = 'turn-items-compacted-before-v2'
    `;
    assert.equal(v2Watermark.length, 1);

    // A second immediate pass does not rescan turn items of already-backfilled threads.
    let turnItemScans = 0;
    const countTurnItemScans: Statement.Transformer = (statement) => {
      const [query] = statement.compile();
      if (query.includes("FROM orchestration_v2_projection_turn_items")) {
        turnItemScans += 1;
      }
      return Effect.succeed(statement);
    };
    const secondPass = yield* maintenance
      .pruneEventStore()
      .pipe(Effect.provideService(Statement.CurrentTransformer, countTurnItemScans));
    assert.equal(secondPass.compactedTurnItemCount, 0);
    assert.equal(turnItemScans, 0);

    // Once newerThreadId ages past 7 days, only it is compacted.
    yield* TestClock.adjust("1 day");
    assert.equal((yield* maintenance.pruneEventStore()).compactedTurnItemCount, 1);
    const newerItem = (yield* projections.getThreadProjection(newerThreadId)).turnItems[0];
    assert.equal(newerItem?.type, "dynamic_tool");
    assert.deepEqual(
      newerItem?.type === "dynamic_tool" ? toolOutputImages(newerItem.output) : null,
      [],
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("keeps the anchor a retained stream head borrows from", () =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const eventStore = yield* EventStore.EventStoreV2;
    const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
    const now = yield* DateTime.now;
    const threadId = ThreadId.make("thread:prune-head");
    yield* sink.write({ events: [threadCreated(makeThread(threadId, now), now)] });
    yield* sink.write({ events: subagentEvents(threadId, now, 0) });
    // The stream's newest row borrows prompt A, so it is kept below the boundary.
    yield* sink.write({ events: subagentEvents(threadId, now, 0, "repeat") });
    yield* maintenance.pruneEventStore();
    yield* TestClock.adjust("1 day");
    assert.isAbove((yield* maintenance.pruneEventStore()).deletedEventCount, 0);

    assert.include(
      yield* remainingEventIds(threadId),
      "event:turn-item-compaction:subagent-item:0",
    );
    const stored = yield* eventStore.read({ threadId }).pipe(Stream.runCollect);
    const head = Array.from(stored).at(-1)?.event;
    assert.deepEqual(
      head?.type === "turn-item.updated" && head.payload.type === "subagent"
        ? head.payload.prompt
        : null,
      "Review prompt A. ".repeat(40),
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("keeps an anchor that a row appended during the pass borrows from", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const eventStore = yield* EventStore.EventStoreV2;
      const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:prune-race");
      yield* sink.write({ events: [threadCreated(makeThread(threadId, now), now)] });
      yield* sink.write({ events: subagentEvents(threadId, now, 0) });
      yield* maintenance.pruneEventStore();
      yield* sink.write({ events: [itemEvent(threadId, now, itemSpecs[0], 0)] });
      yield* TestClock.adjust("1 day");

      const scanStarted = yield* Deferred.make<void>();
      const releaseScan = yield* Deferred.make<void>();
      let blocked = false;
      const blockFirstScanPage: Statement.Transformer = (statement) => {
        const [query] = statement.compile();
        if (!blocked && query.includes("END AS prunable")) {
          blocked = true;
          return Deferred.succeed(scanStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseScan)),
            Effect.as(statement),
          );
        }
        return Effect.succeed(statement);
      };
      const pass = yield* maintenance
        .pruneEventStore()
        .pipe(
          Effect.provideService(Statement.CurrentTransformer, blockFirstScanPage),
          Effect.forkScoped,
        );
      yield* Deferred.await(scanStarted);
      yield* sink.write({ events: subagentEvents(threadId, now, 0, "late") });
      yield* Deferred.succeed(releaseScan, undefined);
      assert.equal((yield* Fiber.join(pass)).deletedEventCount, 0);

      const late = yield* eventStore
        .read({ threadId, eventType: "subagent.updated" })
        .pipe(Stream.runCollect);
      assert.deepEqual(
        Array.from(late, (stored) =>
          stored.event.type === "subagent.updated" ? stored.event.payload.prompt : null,
        ),
        ["Review prompt A. ".repeat(40), "Review prompt A. ".repeat(40)],
      );
    }),
  ).pipe(Effect.provide(layerTest)),
);

function messageUpdated(threadId: ThreadId, now: DateTime.Utc, text: string) {
  return {
    id: EventId.make(`event:purge:${threadId}:message`),
    type: "message.updated",
    threadId,
    occurredAt: now,
    payload: {
      createdBy: "user",
      creationSource: "web",
      id: MessageId.make(`message:${threadId}`),
      threadId,
      runId: null,
      nodeId: null,
      role: "user",
      text,
      attachments: [],
      streaming: false,
      createdAt: now,
      updatedAt: now,
    },
  } satisfies OrchestrationV2DomainEvent;
}

const writeThread = (thread: OrchestrationV2AppThread, now: DateTime.Utc) =>
  Effect.flatMap(EventSink.EventSinkV2, (sink) =>
    Effect.gen(function* () {
      yield* sink.write({
        events: [{ ...threadCreated(thread, now), id: EventId.make(`event:purge:${thread.id}`) }],
      });
      yield* sink.write({ events: [messageUpdated(thread.id, now, `secret in ${thread.id}`)] });
      yield* sink.write({
        events: [itemEvent(thread.id, now, itemSpecs[0], 0, `event:purge:${thread.id}:item`)],
      });
    }),
  );

const deleteThread = (thread: OrchestrationV2AppThread, now: DateTime.Utc) =>
  Effect.flatMap(EventSink.EventSinkV2, (sink) =>
    sink.write({
      events: [
        {
          id: EventId.make(`event:purge:${thread.id}:deleted`),
          type: "thread.deleted",
          threadId: thread.id,
          providerInstanceId,
          occurredAt: now,
          payload: { ...thread, deletedAt: now, updatedAt: now },
        },
      ],
    }),
  );

const contentRowCount = (threadId: ThreadId) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    Effect.forEach(ProjectionMaintenance.DELETED_THREAD_CONTENT_TABLES, (table) =>
      sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count FROM ${sql(table)} WHERE thread_id = ${threadId}
        `.pipe(Effect.map((rows) => rows[0]?.count ?? 0)),
    ),
  ).pipe(Effect.map((counts) => counts.reduce((sum, count) => sum + count, 0)));

const searchMatches = (text: string) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM orchestration_v2_message_search
      WHERE orchestration_v2_message_search MATCH ${`"${text}"`}
    `,
  ).pipe(Effect.map((rows) => rows[0]?.count ?? 0));

it.effect("a deleted thread keeps only its tombstone", () =>
  Effect.gen(function* () {
    const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const now = yield* DateTime.now;
    const deleted = makeThread(ThreadId.make("thread:purge-deleted"), now);
    const live = makeThread(ThreadId.make("thread:purge-live"), now);
    yield* writeThread(deleted, now);
    yield* writeThread(live, now);
    const liveProjection = yield* projections.getThreadProjection(live.id);
    assert.equal(yield* searchMatches("secret in thread:purge-deleted"), 1);

    yield* deleteThread(deleted, now);
    assert.isAbove(yield* maintenance.purgeDeletedThread(deleted.id), 0);

    assert.equal(yield* contentRowCount(deleted.id), 0);
    assert.equal(yield* searchMatches("secret in thread:purge-deleted"), 0);
    assert.deepEqual(yield* remainingEventIds(deleted.id), [
      "event:purge:thread:purge-deleted",
      "event:purge:thread:purge-deleted:deleted",
    ]);
    const tombstone = yield* Effect.flatMap(
      SqlClient.SqlClient,
      (sql) => sql<{ readonly deleted_at: string | null; readonly title: string }>`
        SELECT deleted_at, title FROM orchestration_v2_projection_threads
        WHERE thread_id = ${deleted.id}
      `,
    );
    assert.isNotNull(tombstone[0]?.deleted_at ?? null);
    assert.equal(tombstone[0]?.title, ProjectionMaintenance.DELETED_THREAD_TITLE);
    const leaked = yield* Effect.flatMap(
      SqlClient.SqlClient,
      (sql) => sql<{ readonly count: number }>`
        SELECT
          (SELECT COUNT(*) FROM orchestration_events
            WHERE stream_id = ${deleted.id} AND payload_json LIKE ${`%${deleted.title}%`})
          + (SELECT COUNT(*) FROM orchestration_v2_projection_threads
            WHERE thread_id = ${deleted.id} AND payload_json LIKE ${`%${deleted.title}%`})
          AS count
      `,
    );
    assert.equal(leaked[0]?.count, 0);
    assert.deepEqual(yield* projections.getThreadProjection(live.id), liveProjection);
    assert.equal(yield* maintenance.purgeDeletedThread(deleted.id), 0);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a deleted run-fork source stays until its last live fork is deleted", () =>
  Effect.gen(function* () {
    const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
    const now = yield* DateTime.now;
    const source = makeThread(ThreadId.make("thread:purge-source"), now);
    const fork: OrchestrationV2AppThread = {
      ...makeThread(ThreadId.make("thread:purge-fork"), now),
      forkedFrom: { type: "run", threadId: source.id, runId: RunId.make("run:purge-source") },
    };
    yield* writeThread(source, now);
    yield* writeThread(fork, now);

    yield* deleteThread(source, now);
    assert.equal(yield* maintenance.purgeDeletedThread(source.id), 0);
    assert.isAbove(yield* contentRowCount(source.id), 0);

    yield* deleteThread(fork, now);
    yield* maintenance.purgeDeletedThread(fork.id);
    assert.equal(yield* contentRowCount(source.id), 0);
    assert.equal(yield* contentRowCount(fork.id), 0);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("the maintenance pass purges threads deleted before purging existed", () =>
  Effect.gen(function* () {
    const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
    const now = yield* DateTime.now;
    const deleted = makeThread(ThreadId.make("thread:purge-backfill"), now);
    // Renamed to the placeholder before deletion; its first title is still on record.
    const renamed = makeThread(ThreadId.make("thread:purge-renamed"), now);
    yield* Effect.flatMap(EventSink.EventSinkV2, (sink) =>
      sink.write({
        events: [{ ...threadCreated(renamed, now), id: EventId.make("event:purge:renamed") }],
      }),
    );
    yield* deleteThread({ ...renamed, title: ProjectionMaintenance.DELETED_THREAD_TITLE }, now);
    yield* writeThread(deleted, now);
    yield* deleteThread(deleted, now);
    // A late transcript import leaves a content event as the stream head.
    const sink = yield* EventSink.EventSinkV2;
    yield* sink.write({
      events: [itemEvent(deleted.id, now, itemSpecs[1], 0, "event:purge:late-item")],
    });
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO orchestration_v2_effect_outbox (
        effect_id, command_id, thread_id, effect_type, payload_json, status,
        available_at, created_at, updated_at
      ) VALUES (
        'effect:purge-backfill', 'command:purge-backfill', ${deleted.id}, 'terminal.cleanup',
        '{"type":"terminal.cleanup"}', 'pending', '2026-11-01T00:00:00.000Z',
        '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z'
      )
    `;

    // An earlier effect still reads the thread, so the pass waits for it.
    yield* maintenance.pruneEventStore();
    assert.isAbove(yield* contentRowCount(deleted.id), 0);
    yield* sql`UPDATE orchestration_v2_effect_outbox SET status = 'succeeded'`;

    assert.isAbove((yield* maintenance.pruneEventStore()).purgedRowCount, 0);
    assert.equal(yield* contentRowCount(deleted.id), 0);
    assert.deepEqual(yield* sql`SELECT effect_id FROM orchestration_v2_effect_outbox`, []);
    const stream = yield* EventStore.EventStoreV2.pipe(
      Effect.flatMap((store) => store.read({ threadId: deleted.id }).pipe(Stream.runCollect)),
    );
    assert.deepEqual(
      Array.from(stream, (stored) => stored.event.type),
      ["thread.created", "thread.deleted", "thread.deleted"],
    );
    const leaked = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM orchestration_events
      WHERE stream_id = ${deleted.id}
        AND (payload_json LIKE '%reasoning:0%' OR payload_json LIKE ${`%${deleted.title}%`})
    `;
    assert.equal(leaked[0]?.count, 0);
    const renamedLeaks = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM orchestration_events
      WHERE stream_id = ${renamed.id} AND payload_json LIKE ${`%${renamed.title}%`}
    `;
    assert.equal(renamedLeaks[0]?.count, 0);
    assert.equal((yield* maintenance.pruneEventStore()).purgedRowCount, 0);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a deleted thread's leftover settled request is purged", () =>
  Effect.gen(function* () {
    const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
    const sql = yield* SqlClient.SqlClient;
    const now = yield* DateTime.now;
    const thread = {
      ...makeThread(ThreadId.make("thread:purge-placeholder"), now),
      title: ProjectionMaintenance.DELETED_THREAD_TITLE,
    };
    yield* Effect.flatMap(EventSink.EventSinkV2, (sink) =>
      sink.write({
        events: [{ ...threadCreated(thread, now), id: EventId.make("event:purge:placeholder") }],
      }),
    );
    // A rename in between left its private title in a settled request.
    yield* sql`
      INSERT INTO orchestration_v2_effect_outbox (
        effect_id, command_id, thread_id, effect_type, payload_json, status,
        available_at, created_at, updated_at
      ) VALUES (
        'effect:purge-placeholder', 'command:purge-placeholder', ${thread.id},
        'provider-session.apply-thread-title',
        '{"type":"provider-session.apply-thread-title","title":"private rename"}', 'succeeded',
        '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z'
      )
    `;
    yield* deleteThread(thread, now);

    // The sweep alone finds the leftover request too.
    yield* maintenance.pruneEventStore();
    assert.deepEqual(yield* sql`SELECT effect_id FROM orchestration_v2_effect_outbox`, []);

    // A pass interrupted after the content rows went still leaves a content event.
    yield* Effect.flatMap(EventSink.EventSinkV2, (sink) =>
      sink.write({ events: [itemEvent(thread.id, now, itemSpecs[0], 0, "event:purge:stray")] }),
    );
    yield* sql`DELETE FROM orchestration_v2_projection_turn_items WHERE thread_id = ${thread.id}`;
    yield* sql`DELETE FROM orchestration_v2_turn_item_positions WHERE thread_id = ${thread.id}`;
    yield* maintenance.pruneEventStore();
    // It is the stream head, so its row stays as the tombstone.
    assert.deepEqual(
      yield* sql`SELECT event_type FROM orchestration_events WHERE event_id = 'event:purge:stray'`,
      [{ event_type: "thread.deleted" }],
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("an interrupted purge leaves a stream that still decodes", () =>
  Effect.gen(function* () {
    const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
    const eventStore = yield* EventStore.EventStoreV2;
    const sink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const thread = makeThread(ThreadId.make("thread:purge-interrupted"), now);
    yield* sink.write({ events: [{ ...threadCreated(thread, now), id: EventId.make("event:i") }] });
    yield* sink.write({ events: subagentEvents(thread.id, now, 0, "anchor") });
    yield* deleteThread(thread, now);
    // A late update borrows the anchor's prompt and becomes the stream head.
    yield* sink.write({ events: subagentEvents(thread.id, now, 0, "borrower") });

    const failAfterEvents: Statement.Transformer = (statement) =>
      statement.compile()[0].includes("DELETE FROM orchestration_v2_effect_outbox")
        ? Effect.die("interrupted")
        : Effect.succeed(statement);
    const exit = yield* maintenance
      .purgeDeletedThread(thread.id)
      .pipe(Effect.provideService(Statement.CurrentTransformer, failAfterEvents), Effect.exit);
    assert.isTrue(exit._tag === "Failure");

    const stream = yield* eventStore.read({ threadId: thread.id }).pipe(Stream.runCollect);
    assert.equal(Array.from(stream).at(-1)?.event.type, "thread.deleted");
  }).pipe(Effect.provide(layerTest)),
);
