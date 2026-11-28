// @effect-diagnostics nodeBuiltinImport:off -- Junction fixtures work without symlink privileges on Windows.
import * as NodeFSP from "node:fs/promises";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { AuthSessionId, MessageId, ProjectId, RunId, ThreadId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NetService from "@t3tools/shared/Net";
import * as ConfigProvider from "effect/ConfigProvider";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Runtime from "effect/Runtime";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as TestClock from "effect/testing/TestClock";
import * as TestConsole from "effect/testing/TestConsole";
import { CliError, Command } from "effect/cli";
import { vi } from "vite-plus/test";

import * as McpBridge from "../mcp/AcpMcpStdioBridge.ts";
import {
  makePersistedServerRuntimeState,
  persistServerRuntimeState,
} from "../serverRuntimeState.ts";
import {
  latestRunError,
  launchModelSelection,
  readLatestMessages,
  readOutputSchema,
  resolveProject,
  threadCommand,
  type ThreadTools,
  titleFromMessage,
  waitForRun,
} from "./thread.ts";

vi.mock("../auth/EnvironmentAuth.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../auth/EnvironmentAuth.ts")>();
  return {
    ...actual,
    layerRuntime: Layer.mock(actual.EnvironmentAuth)({
      issueMcpClientSession: () =>
        Effect.map(DateTime.now, (expiresAt) => ({
          sessionId: AuthSessionId.make("test-session"),
          token: "synthetic-token",
          expiresAt,
        })),
      revokeSession: () => Effect.succeed(true),
    }),
  };
});

const threadId = ThreadId.make("thread-1");
const runId = RunId.make("run-1");

it.effect("list includes delegated threads across pages and still leaves out subagents", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-thread-list-" });
    yield* persistServerRuntimeState({
      path: path.join(baseDir, "userdata", "server-runtime.json"),
      state: yield* makePersistedServerRuntimeState({
        config: { host: "127.0.0.1", devUrl: undefined },
        port: 3_773,
      }),
    });
    const projectId = ProjectId.make("project-1");
    const item = (id: string) => ({
      threadId: id,
      projectId,
      title: id,
      createdBy: "user",
      creationSource: "web",
      status: "idle",
      latestRunId: null,
      providerInstanceId: "codex",
      model: "test",
      runtimeMode: "full-access",
      interactionMode: "default",
      linkedPullRequest: null,
      settled: false,
      settledAt: null,
      snoozed: false,
      snoozedUntil: null,
      parentThreadId: null,
      relationshipToParent: null,
      itemCount: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const root = item("root");
    const delegated = {
      ...item("delegated"),
      delegatedFrom: { environmentId: "env-1", threadId: "remote", title: "Remote" },
    };
    const subagent = { ...item("child"), parentThreadId: "root", relationshipToParent: "subagent" };
    using _session = vi.spyOn(McpBridge, "mcpToolSession").mockReturnValue(
      Effect.succeed({
        call: (tool, args) => {
          if (tool === "t3_project_list")
            return Effect.succeed({
              structuredContent: {
                projects: [{ id: projectId, title: "Project", workspaceRoot: baseDir }],
                nextCursor: null,
              },
            });
          if (tool === "t3_thread_list") {
            const all = args.includeSubagents ? [root, subagent, delegated] : [root];
            const cursor = Number(args.cursor);
            return Effect.succeed({
              structuredContent: {
                projectId,
                currentThreadId: null,
                threads: all.slice(cursor, cursor + 2),
                nextCursor: cursor + 2 < all.length ? cursor + 2 : null,
                total: all.length,
              },
            });
          }
          return Effect.die(`unexpected ${tool} call`);
        },
      }),
    );
    yield* Command.runWith(threadCommand, { version: "0.0.0" })([
      "list",
      "--project",
      projectId,
      "--json",
      "--base-dir",
      baseDir,
    ]);
    const listed = JSON.parse(String((yield* TestConsole.logLines).at(-1))) as Array<{
      threadId: string;
    }>;
    assert.deepStrictEqual(
      listed.map((entry) => entry.threadId),
      ["root", "delegated"],
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        NetService.layer,
        ConfigProvider.layer(ConfigProvider.fromEnv({ env: { T3CODE_PORT: "3773" } })),
      ),
    ),
  ),
);

it.effect(
  "start resolves project ids and registered aliases through absolute, relative, and home-relative paths",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs
        .makeTempDirectoryScoped({ prefix: "t3-thread-project-path-" })
        .pipe(Effect.flatMap((directory) => fs.realPath(directory)));
      const home = path.join(root, "home");
      const cwd = path.join(root, "current");
      const workspaceRoot = path.join(home, "My Project");
      const aliasRoot = path.join(home, "My Project Alias");
      const nestedRoot = path.join(workspaceRoot, "nested");
      const baseDir = path.join(root, "state");
      yield* fs.makeDirectory(nestedRoot, { recursive: true });
      yield* fs.makeDirectory(cwd);
      yield* Effect.promise(() => NodeFSP.symlink(workspaceRoot, aliasRoot, "junction"));
      const projects = [
        { id: ProjectId.make("current-project"), title: "Current", workspaceRoot: cwd },
        { id: ProjectId.make("home-project"), title: "Home", workspaceRoot: home },
        { id: ProjectId.make("intended-project"), title: "Intended", workspaceRoot },
        { id: ProjectId.make("alias-project"), title: "Alias", workspaceRoot: aliasRoot },
        { id: ProjectId.make("nested-project"), title: "Nested", workspaceRoot: nestedRoot },
        { id: ProjectId.make("~/literal-id"), title: "Exact id", workspaceRoot: cwd },
      ];
      yield* persistServerRuntimeState({
        path: path.join(baseDir, "userdata", "server-runtime.json"),
        state: yield* makePersistedServerRuntimeState({
          config: { host: "127.0.0.1", devUrl: undefined },
          port: 3_773,
        }),
      });
      using _session = vi.spyOn(McpBridge, "mcpToolSession").mockReturnValue(
        Effect.succeed({
          call: (tool, args) => {
            switch (tool) {
              case "t3_project_list":
                return Effect.succeed({ structuredContent: { projects, nextCursor: null } });
              case "t3_thread_launch":
                return Effect.succeed({
                  structuredContent: { threadId, projectId: args.projectId, runId: null },
                });
              default:
                return Effect.die(`unexpected ${tool} call`);
            }
          },
        }),
      );

      for (const [identifier, expectedProjectId] of [
        ["intended-project", "intended-project"],
        ["~/literal-id", "~/literal-id"],
        [workspaceRoot, "intended-project"],
        [path.relative(cwd, workspaceRoot), "intended-project"],
        [aliasRoot, "alias-project"],
        [path.join(aliasRoot, "nested"), "nested-project"],
        [".", "current-project"],
        ["~/My Project", "intended-project"],
        ["~", "home-project"],
        ["~/My Project/nested", "nested-project"],
        ["~/My Project/missing", "intended-project"],
      ] as const) {
        yield* Command.runWith(threadCommand, { version: "0.0.0" })([
          "start",
          identifier,
          "Inspect this project",
          "--json",
          "--base-dir",
          baseDir,
        ]).pipe(
          Effect.provideService(HostProcess.HomeDirectory, home),
          Effect.provideService(HostProcess.WorkingDirectory, cwd),
        );
        assert.strictEqual(
          (yield* TestConsole.logLines).at(-1),
          JSON.stringify({ threadId, projectId: expectedProjectId, runId: null }),
          identifier,
        );
      }
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          NodeCrypto.layer,
          NetService.layer,
          ConfigProvider.layer(ConfigProvider.fromEnv({ env: { T3CODE_PORT: "3773" } })),
        ),
      ),
    ),
);

it.effect("start leaves the workspace to the project's default unless a flag chooses it", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs
      .makeTempDirectoryScoped({ prefix: "t3-thread-workspace-" })
      .pipe(Effect.flatMap((directory) => fs.realPath(directory)));
    const baseDir = path.join(root, "state");
    yield* persistServerRuntimeState({
      path: path.join(baseDir, "userdata", "server-runtime.json"),
      state: yield* makePersistedServerRuntimeState({
        config: { host: "127.0.0.1", devUrl: undefined },
        port: 3_773,
      }),
    });
    const launches: Array<Record<string, unknown>> = [];
    using _session = vi.spyOn(McpBridge, "mcpToolSession").mockReturnValue(
      Effect.succeed({
        call: (tool, args) => {
          if (tool === "t3_project_list") {
            return Effect.succeed({
              structuredContent: {
                projects: [
                  { id: ProjectId.make("project-1"), title: "Project", workspaceRoot: root },
                ],
                nextCursor: null,
              },
            });
          }
          if (tool !== "t3_thread_launch") return Effect.die(`unexpected ${tool} call`);
          launches.push(args);
          return Effect.succeed({
            structuredContent: { threadId, projectId: args.projectId, runId: null },
          });
        },
      }),
    );
    const start = (...flags: ReadonlyArray<string>) =>
      Command.runWith(threadCommand, { version: "0.0.0" })([
        "start",
        "project-1",
        "Inspect this project",
        "--base-dir",
        baseDir,
        ...flags,
      ]);

    yield* start();
    yield* start("--local");
    yield* start("--worktree", "origin/main", "--branch", "fix");
    assert.deepStrictEqual(
      launches.map((launch) => launch.workspaceStrategy),
      [undefined, { type: "root" }, { type: "worktree", baseRef: "origin/main", branch: "fix" }],
    );

    yield* start("--local", "--worktree", "origin/main").pipe(Effect.exit);
    assert.strictEqual(launches.length, 3);
    assert.include(
      (yield* TestConsole.errorLines).join("\n"),
      "--local and --worktree choose different workspaces.",
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        NetService.layer,
        ConfigProvider.layer(ConfigProvider.fromEnv({ env: { T3CODE_PORT: "3773" } })),
      ),
    ),
  ),
);

it.effect("does not sign in to whatever took over a dead server's port", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-thread-dead-server-" });
    const state = yield* makePersistedServerRuntimeState({
      config: { host: "127.0.0.1", devUrl: undefined },
      port: 3_773,
    });
    yield* persistServerRuntimeState({
      path: path.join(baseDir, "userdata", "server-runtime.json"),
      // Above Linux's PID ceiling, as in pair.test.ts: no process can hold it.
      state: { ...state, pid: 4_194_305 },
    });
    using session = vi
      .spyOn(McpBridge, "mcpToolSession")
      .mockReturnValue(Effect.die("no session should open"));

    const error = yield* Command.runWith(threadCommand, { version: "0.0.0" })([
      "list",
      "--base-dir",
      baseDir,
    ]).pipe(Effect.flip);

    assert.strictEqual(error._tag, "ThreadServerNotRunningError");
    assert.strictEqual(session.mock.calls.length, 0);
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        NetService.layer,
        ConfigProvider.layer(ConfigProvider.fromEnv({ env: { T3CODE_PORT: "3773" } })),
      ),
    ),
  ),
);

/** Answers each tool call with the next scripted response for that tool. */
const scriptedTools = (script: Record<string, Array<unknown>>) => {
  const calls: Array<{ readonly tool: string; readonly args: unknown }> = [];
  const call = ((tool: string, args: unknown) => {
    calls.push({ tool, args });
    const next = script[tool]?.shift();
    return next === undefined ? Effect.die(`unscripted ${tool} call`) : Effect.succeed(next);
  }) as ThreadTools["call"];
  return { tools: { call } satisfies ThreadTools, calls };
};

it.effect("--wait follows the sent run to its continuation's terminal status", () =>
  Effect.gen(function* () {
    const continuation = RunId.make("run-2");
    const { tools, calls } = scriptedTools({
      t3_thread_wait: [
        { threadId, runId, status: "running", timedOut: true },
        { threadId, runId: continuation, status: "failed", timedOut: false },
      ],
      t3_thread_read: [{ thread: { pendingRequestCount: 0 } }],
    });

    const outcome = yield* waitForRun(tools, threadId, runId);

    assert.deepStrictEqual(outcome, { type: "ended", runId: continuation, status: "failed" });
    assert.deepStrictEqual(
      calls.filter((entry) => entry.tool === "t3_thread_wait").map((entry) => entry.args),
      [
        { threadId, runId, timeoutMs: 15_000 },
        { threadId, runId, timeoutMs: 15_000 },
      ],
    );
  }),
);

/** The reads that ask whether a run after `runId` holds a message someone sent. */
const laterRunReads = (
  laterRun: RunId,
  items: ReadonlyArray<{ readonly runId: RunId; readonly type: string }>,
) => [
  {
    recentRuns: [
      { runId, ordinal: 1 },
      { runId: laterRun, ordinal: 2 },
    ],
  },
  { thread: {}, items, nextPosition: null, hasMore: false },
];

it.effect("--wait lasts until background work the agent waits on wakes it and that run ends", () =>
  Effect.gen(function* () {
    const wakeRun = RunId.make("run-2");
    const { tools, calls } = scriptedTools({
      t3_thread_wait: [
        { threadId, runId, status: "completed", timedOut: false },
        {
          threadId,
          runId,
          status: "completed",
          timedOut: false,
          resultRun: { runId: wakeRun, status: "completed" },
          // The wake run submits the result the first run owes, which the server stores there.
          output: { head: "abc" },
        },
      ],
      // The wake run starts from a notification, which the messages view leaves out.
      t3_thread_read: laterRunReads(wakeRun, []),
    });

    const outcome = yield* waitForRun(tools, threadId, runId, true);

    assert.deepStrictEqual(
      calls.filter((entry) => entry.tool === "t3_thread_wait").map((entry) => entry.args),
      [
        { threadId, runId, timeoutMs: 15_000 },
        { threadId, runId, timeoutMs: 15_000, untilDelegatedWorkSettled: true },
      ],
    );
    assert.deepStrictEqual(outcome, {
      type: "ended",
      runId: wakeRun,
      status: "completed",
      output: { head: "abc" },
    });
  }),
);

it.effect(
  "--wait waits out the moment between background work ending and its wake run starting",
  () =>
    Effect.gen(function* () {
      const wakeRun = RunId.make("run-2");
      const ownOnly = { recentRuns: [{ runId, ordinal: 1, status: "completed" }] };
      const withWake = (status: string) => [
        {
          recentRuns: [
            { runId, ordinal: 1, status: "completed" },
            { runId: wakeRun, ordinal: 2, status },
          ],
        },
        { thread: {}, items: [], nextPosition: null, hasMore: false },
      ];
      const { tools } = scriptedTools({
        t3_thread_wait: [
          { threadId, runId, status: "completed", timedOut: false },
          { threadId, runId, status: "completed", timedOut: true },
          // The work ended, and the run it wakes is not recorded yet.
          {
            threadId,
            runId,
            status: "completed",
            timedOut: false,
            resultRun: { runId, status: "completed" },
          },
          {
            threadId,
            runId,
            status: "completed",
            timedOut: false,
            resultRun: { runId: wakeRun, status: "completed" },
          },
        ],
        t3_thread_read: [
          ownOnly,
          { thread: { pendingRequestCount: 0 } },
          ownOnly,
          ...withWake("running"),
          ...withWake("completed"),
        ],
      });

      const fiber = yield* Effect.forkChild(waitForRun(tools, threadId, runId, true));
      yield* TestClock.adjust("500 millis");

      assert.deepStrictEqual(yield* Fiber.join(fiber), {
        type: "ended",
        runId: wakeRun,
        status: "completed",
      });
    }),
);

it.effect(
  "--wait keeps its own run's result when another client's later run settles the thread",
  () =>
    Effect.gen(function* () {
      const sentRun = RunId.make("run-2");
      const { tools } = scriptedTools({
        t3_thread_wait: [
          { threadId, runId, status: "completed", timedOut: false },
          {
            threadId,
            runId,
            status: "completed",
            timedOut: false,
            resultRun: { runId: sentRun, status: "failed" },
            output: { head: "abc" },
          },
        ],
        t3_thread_read: laterRunReads(sentRun, [{ runId: sentRun, type: "user_message" }]),
      });

      assert.deepStrictEqual(yield* waitForRun(tools, threadId, runId, true), {
        type: "ended",
        runId,
        status: "completed",
        output: { head: "abc" },
      });
    }),
);

it.effect("--wait stops when the thread waits for an answer instead of polling forever", () =>
  Effect.gen(function* () {
    const { tools } = scriptedTools({
      t3_thread_wait: [
        { threadId, runId, status: "queued", timedOut: true },
        { threadId, runId, status: "queued", timedOut: true },
      ],
      t3_thread_read: [{ thread: { pendingRequestCount: 1 } }],
    });

    assert.deepStrictEqual(yield* waitForRun(tools, threadId, runId), { type: "needs_input" });
  }),
);

it.effect("--wait reports its run's result when a later run is the one waiting", () =>
  Effect.gen(function* () {
    const { tools } = scriptedTools({
      t3_thread_wait: [
        { threadId, runId, status: "running", timedOut: true },
        { threadId, runId, status: "completed", timedOut: false },
      ],
      t3_thread_read: [{ thread: { pendingRequestCount: 1 } }],
    });

    assert.deepStrictEqual(yield* waitForRun(tools, threadId, runId), {
      type: "ended",
      runId,
      status: "completed",
    });
  }),
);

it.effect("start sends each --option as a typed model option", () =>
  Effect.gen(function* () {
    const selection = yield* launchModelSelection({
      provider: Option.some("codex"),
      model: Option.some("gpt-6.1-sol"),
      option: ["reasoningEffort=high", " fastMode = false ", "note=a=b"],
    });

    assert.deepStrictEqual(selection, {
      instanceId: "codex",
      model: "gpt-6.1-sol",
      options: [
        { id: "reasoningEffort", value: "high" },
        { id: "fastMode", value: false },
        { id: "note", value: "a=b" },
      ],
    });
  }),
);

it.effect("start rejects a repeated --option before reaching the server", () =>
  Effect.gen(function* () {
    const error = yield* Command.runWith(threadCommand, { version: "0.0.0" })([
      "start",
      ".",
      "hi",
      "--provider",
      "codex",
      "--model",
      "gpt-6.1-sol",
      "--option",
      "reasoningEffort=high",
      "--option",
      "reasoningEffort=low",
    ]).pipe(Effect.flip);

    assert.strictEqual(error.message, "--option reasoningEffort is given more than once.");
  }).pipe(
    Effect.provide(
      Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, NetService.layer, TestConsole.layer),
    ),
  ),
);

it.effect("--output-schema reads a ~/ path from the home directory", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-thread-schema-" });
    yield* fs.writeFileString(path.join(home, "schema.json"), '{"type":"object"}');

    const output = yield* readOutputSchema(Option.some("~/schema.json")).pipe(
      Effect.provideService(HostProcess.HomeDirectory, home),
    );

    assert.deepStrictEqual(output, { outputSchema: { type: "object" } });
  }).pipe(Effect.provide(NodeServices.layer)),
);

/** Serves t3_thread_read pages the way the server does: positions count every item, and a cursorless read is the newest page. */
const timelineTools = (types: ReadonlyArray<string>) => {
  const items = types.map((type, position) => ({ position, itemId: `item-${position}`, type }));
  const served: Array<number> = [];
  const call = ((_tool: string, input: unknown) => {
    const args = input as { readonly afterPosition?: number; readonly limit: number };
    const isMessage = (item: (typeof items)[number]) =>
      ["user_message", "assistant_message", "proposed_plan"].includes(item.type);
    if (args.afterPosition === undefined) {
      const page = items.filter(isMessage).slice(-args.limit);
      served.push(page.length);
      return Effect.succeed({
        thread: { itemCount: items.length },
        items: page,
        nextPosition: null,
        hasMore: false,
      });
    }
    // Scanning one match past the page keeps reads of huge fixtures linear.
    const matching: typeof items = [];
    for (let position = args.afterPosition + 1; position < items.length; position++) {
      const item = items[position]!;
      if (isMessage(item)) {
        matching.push(item);
        if (matching.length > args.limit) break;
      }
    }
    const page = matching.slice(0, args.limit);
    served.push(page.length);
    return Effect.succeed({
      thread: { itemCount: items.length },
      items: page,
      nextPosition: page.at(-1)?.position ?? null,
      hasMore: matching.length > page.length,
    });
  }) as ThreadTools["call"];
  const latest = (count: number) =>
    items
      .filter((item) => item.type === "user_message" || item.type === "assistant_message")
      .slice(-count)
      .map((item) => item.itemId);
  return { tools: { call } satisfies ThreadTools, served, latest };
};

const tail = (tools: number) => [...Array<string>(tools).fill("tool_call"), "assistant_message"];

it.effect("show retains pull request metadata when reading a later message window", () =>
  Effect.gen(function* () {
    const link = {
      host: "github.com",
      repository: "owner/repo",
      number: 1,
      url: "https://github.com/owner/repo/pull/1",
      source: "manual",
      state: "open",
      watching: false,
      watchStartedAt: null,
    } as const;
    const call = ((_tool: string, input: unknown) => {
      const args = input as { afterPosition?: number; limit: number };
      const first = args.afterPosition === undefined && args.limit === 1;
      return Effect.succeed({
        thread: {
          itemCount: 200,
          status: first ? "running" : "completed",
          pullRequestCount: 1,
          ...(first ? { pullRequests: [link], openPullRequestCount: 1 } : {}),
        },
        items: first ? [] : [{ position: 199, itemId: "message", type: "assistant_message" }],
        nextPosition: 199,
        hasMore: false,
      });
    }) as ThreadTools["call"];
    const { thread } = yield* readLatestMessages({ call }, threadId, 1);
    assert.strictEqual(thread.status, "completed");
    assert.deepStrictEqual(thread.pullRequests, [link]);
    assert.strictEqual(thread.openPullRequestCount, 1);
  }),
);

it.effect("show reads the end of a long thread, not its whole history", () =>
  Effect.gen(function* () {
    const { tools, served, latest } = timelineTools([
      ...Array.from({ length: 1000 }, (_, index) =>
        index % 2 === 0 ? "user_message" : "assistant_message",
      ),
      ...Array.from({ length: 10 }, () => tail(30)).flat(),
      "proposed_plan",
    ]);

    const { messages } = yield* readLatestMessages(tools, threadId, 10);

    assert.deepStrictEqual(
      messages.map((item): string | undefined => item.itemId),
      latest(10),
    );
    assert.isBelow(
      served.reduce((sum, count) => sum + count, 0),
      100,
    );
  }),
);

it.effect("show widens back to the first item when the thread has fewer messages", () =>
  Effect.gen(function* () {
    const { tools, latest } = timelineTools([
      "user_message",
      ...Array.from({ length: 4 }, () => tail(150)).flat(),
    ]);

    const { messages } = yield* readLatestMessages(tools, threadId, 10);

    assert.deepStrictEqual(
      messages.map((item): string | undefined => item.itemId),
      latest(10),
    );
    assert.lengthOf(messages, 5);
  }),
);

it.effect("show returns a --messages count larger than one call can spread", () =>
  Effect.gen(function* () {
    const { tools, latest } = timelineTools(Array<string>(200_000).fill("assistant_message"));

    const { messages } = yield* readLatestMessages(tools, threadId, 200_000);

    assert.deepStrictEqual(
      messages.map((item): string | undefined => item.itemId),
      latest(200_000),
    );
  }),
);

it.effect("show rejects a negative --messages before reaching the server", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-thread-show-messages-" });
    const show = (messages: string) =>
      Command.runWith(threadCommand, { version: "0.0.0" })([
        "show",
        threadId,
        "--messages",
        messages,
        "--base-dir",
        baseDir,
      ]).pipe(Effect.flip);

    const error = yield* show("-1");
    if (!CliError.isCliError(error) || error._tag !== "ShowHelp") {
      assert.fail(`Expected ShowHelp, got ${String(error)}`);
    }
    const flagError = error.errors[0];
    if (flagError?._tag !== "InvalidValue") {
      assert.fail(`Expected InvalidValue, got ${String(flagError?._tag)}`);
    }
    assert.strictEqual(flagError.option, "messages");
    assert.strictEqual(flagError.value, "-1");
    // Zero is valid: it shows the thread's state with no messages.
    assert.strictEqual((yield* show("0"))._tag, "ThreadServerNotRunningError");
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        NetService.layer,
        ConfigProvider.layer(ConfigProvider.fromEnv({ env: { T3CODE_PORT: "3773" } })),
      ),
    ),
  ),
);

it.effect("show gives the latest run's last error only when that run did not complete", () =>
  Effect.gen(function* () {
    const page = {
      thread: {},
      items: [
        { itemId: "item-0", runId: RunId.make("run-0"), type: "error", text: "earlier run" },
        { itemId: "item-1", runId, type: "error", text: "first try" },
        { itemId: "item-2", runId, type: "error", text: "Usage limit reached" },
      ],
      nextPosition: null,
      hasMore: false,
    };
    const { tools, calls } = scriptedTools({ t3_thread_read: [page] });

    assert.strictEqual(
      yield* latestRunError(tools, { threadId, status: "failed", latestRunId: runId }),
      "Usage limit reached",
    );
    assert.deepInclude(calls[0]?.args, { view: "activity" });
    for (const status of ["completed", "running", "queued", "idle"] as const) {
      assert.isNull(yield* latestRunError(tools, { threadId, status, latestRunId: runId }), status);
    }
    assert.lengthOf(calls, 1);
  }),
);

it.each([
  ["CR", "\r"],
  ["Unicode line separator", "\u2028"],
  ["Unicode paragraph separator", "\u2029"],
])("uses only the first line of a message with %s line endings", (_name, newline) => {
  assert.strictEqual(titleFromMessage(`Review merge${newline}Check changelog`), "Review merge");
});

it("titles from a long first line without splitting an emoji", () => {
  const title = titleFromMessage(`${"a".repeat(78)}😀 and the rest of a long first line`);
  assert.strictEqual(title, `${"a".repeat(78)}…`);
});

const git = Effect.fn("test.git")(function* (cwd: string, args: ReadonlyArray<string>) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const exitCode = yield* spawner.exitCode(ChildProcess.make("git", args, { cwd }));
  assert.strictEqual(Number(exitCode), 0, `git ${args.join(" ")}`);
});

const commitAll = (cwd: string) =>
  Effect.andThen(
    git(cwd, ["add", "."]),
    git(cwd, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.test",
      "commit",
      "--quiet",
      "-m",
      "initial",
    ]),
  );

it.live("resolves a path inside a git worktree of the project's repository to that project", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-thread-worktree-" });
    const repo = path.join(root, "sample");
    const worktree = path.join(root, "worktrees", "sample", "t3-8ff64c24");
    const feature = path.join(root, "wt", "feature");
    const featureWorktree = path.join(root, "worktrees", "feature", "t3-1a2b3c4d");
    yield* fileSystem.makeDirectory(path.join(repo, "pkg"), { recursive: true });
    yield* fileSystem.writeFileString(path.join(repo, "pkg", "index.ts"), "export {};\n");
    yield* git(repo, ["init", "--quiet", "-b", "main"]);
    yield* commitAll(repo);
    yield* git(repo, ["worktree", "add", "--quiet", "-b", "t3/8ff64c24", worktree]);
    yield* git(repo, ["worktree", "add", "--quiet", "-b", "feature", feature]);
    yield* git(feature, ["worktree", "add", "--quiet", "-b", "t3/1a2b3c4d", featureWorktree]);

    const project = (id: string, workspaceRoot: string) => ({
      id: ProjectId.make(id),
      title: path.basename(workspaceRoot),
      workspaceRoot,
    });
    const sample = project("project-sample", repo);
    const featureProject = project("project-feature", feature);
    const resolveFrom = (
      projects: ReadonlyArray<ReturnType<typeof project>>,
      workingDirectory: string,
      identifier = ".",
    ) =>
      resolveProject(
        scriptedTools({ t3_project_list: [{ projects, nextCursor: null }] }).tools,
        identifier,
      ).pipe(Effect.provideService(HostProcess.WorkingDirectory, workingDirectory));

    assert.deepStrictEqual(yield* resolveFrom([sample], worktree), sample);
    assert.deepStrictEqual(yield* resolveFrom([sample], path.join(worktree, "pkg")), sample);
    assert.deepStrictEqual(yield* resolveFrom([sample], worktree, "pkg/index.ts"), sample);
    const worktreeAlias = path.join(root, "worktree-alias");
    yield* Effect.promise(() => NodeFSP.symlink(worktree, worktreeAlias, "junction"));
    assert.deepStrictEqual(
      yield* resolveFrom([sample], worktreeAlias, "pkg/not-created/yet.ts"),
      sample,
    );
    assert.deepStrictEqual(yield* resolveFrom([featureProject], featureWorktree), featureProject);
    const ambiguous = yield* Effect.flip(resolveFrom([sample, featureProject], featureWorktree));
    assert.strictEqual(ambiguous._tag, "ThreadUsageError");
    assert.include(ambiguous.message, "sample (project-sample)");
    assert.include(ambiguous.message, "feature (project-feature)");

    const aliasRoot = path.join(root, "sample-alias");
    yield* Effect.promise(() => NodeFSP.symlink(repo, aliasRoot, "junction"));
    const alias = project("project-alias", aliasRoot);
    const nested = project("project-nested", path.join(repo, "pkg"));
    assert.deepStrictEqual(
      yield* resolveFrom([sample, alias, nested], path.join(worktree, "pkg")),
      nested,
    );
    const aliased = yield* Effect.flip(resolveFrom([sample, alias], worktree));
    assert.strictEqual(aliased._tag, "ThreadUsageError");
    assert.include(aliased.message, "sample (project-sample)");
    assert.include(aliased.message, "sample-alias (project-alias)");

    // A moved checkout stays listed as prunable, even once its old path exists again.
    yield* fileSystem.rename(feature, path.join(root, "moved-feature"));
    yield* fileSystem.makeDirectory(feature);
    assert.deepStrictEqual(yield* resolveFrom([sample, featureProject], featureWorktree), sample);

    // An inherited relative GIT_DIR resolves against Git's cwd, where no repository is.
    vi.stubEnv("GIT_DIR", ".git");
    yield* Effect.addFinalizer(() => Effect.sync(() => vi.unstubAllEnvs()));
    assert.deepStrictEqual(yield* resolveFrom([sample], path.join(worktree, "pkg")), sample);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

const cliTestLayer = Layer.mergeAll(
  NodeServices.layer,
  NodeCrypto.layer,
  NetService.layer,
  ConfigProvider.layer(ConfigProvider.fromEnv({ env: { T3CODE_PORT: "3773" } })),
);

const makeRunningBaseDir = Effect.fn("test.makeRunningBaseDir")(function* (prefix: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const baseDir = yield* fs.makeTempDirectoryScoped({ prefix });
  yield* persistServerRuntimeState({
    path: path.join(baseDir, "userdata", "server-runtime.json"),
    state: yield* makePersistedServerRuntimeState({
      config: { host: "127.0.0.1", devUrl: undefined },
      port: 3_773,
    }),
  });
  return baseDir;
});

it.effect("interrupt prints a concise status line for each interrupt result status", () =>
  Effect.gen(function* () {
    const baseDir = yield* makeRunningBaseDir("t3-thread-interrupt-");
    const calls: Array<{ readonly tool: string; readonly args: Record<string, unknown> }> = [];
    const cases = [
      {
        result: { threadId, runId, status: "interrupt_requested" },
        expected: "Interrupt requested.",
      },
      {
        result: { threadId, runId: null, status: "no_active_run" },
        expected: "No active run.",
      },
      {
        result: { threadId, runId, status: "completed" },
        expected: "Already completed.",
      },
      {
        result: { threadId, runId, status: "failed" },
        expected: "Already failed.",
      },
      {
        result: { threadId, runId, status: "cancelled" },
        expected: "Already cancelled.",
      },
      {
        result: { threadId, runId, status: "interrupted" },
        expected: "Already interrupted.",
      },
      {
        result: { threadId, runId, status: "rolled_back" },
        expected: "Already rolled_back.",
      },
    ] as const;

    let index = 0;
    using _session = vi.spyOn(McpBridge, "mcpToolSession").mockReturnValue(
      Effect.succeed({
        call: (tool, args) => {
          calls.push({ tool, args });
          const next = cases[index++];
          return next === undefined
            ? Effect.die(`unexpected ${tool} call`)
            : Effect.succeed({ structuredContent: next.result });
        },
      }),
    );

    for (const testCase of cases) {
      yield* Command.runWith(threadCommand, { version: "0.0.0" })([
        "interrupt",
        threadId,
        "--base-dir",
        baseDir,
      ]);
      assert.strictEqual(
        (yield* TestConsole.logLines).at(-1),
        testCase.expected,
        testCase.result.status,
      );
    }

    assert.deepStrictEqual(
      calls,
      cases.map(() => ({ tool: "t3_thread_interrupt", args: { threadId } })),
    );
  }).pipe(Effect.scoped, Effect.provide(cliTestLayer)),
);

it.effect("interrupt --json prints the decoded OrchestratorMcpThreadInterruptResult JSON", () =>
  Effect.gen(function* () {
    const baseDir = yield* makeRunningBaseDir("t3-thread-interrupt-json-");
    const responses = [
      { threadId, runId, status: "interrupt_requested" },
      { threadId, runId: null, status: "no_active_run" },
    ] as const;
    let index = 0;
    using _session = vi.spyOn(McpBridge, "mcpToolSession").mockReturnValue(
      Effect.succeed({
        call: (tool) => {
          if (tool !== "t3_thread_interrupt") return Effect.die(`unexpected ${tool} call`);
          const next = responses[index++];
          return next === undefined
            ? Effect.die("extra t3_thread_interrupt call")
            : Effect.succeed({ structuredContent: next });
        },
      }),
    );

    for (const expected of responses) {
      yield* Command.runWith(threadCommand, { version: "0.0.0" })([
        "interrupt",
        threadId,
        "--json",
        "--base-dir",
        baseDir,
      ]);
      assert.deepStrictEqual(JSON.parse(String((yield* TestConsole.logLines).at(-1))), expected);
    }
  }).pipe(Effect.scoped, Effect.provide(cliTestLayer)),
);

it.effect("interrupt rejects an invalid thread id before opening a session", () =>
  Effect.gen(function* () {
    const baseDir = yield* makeRunningBaseDir("t3-thread-interrupt-invalid-");
    using session = vi
      .spyOn(McpBridge, "mcpToolSession")
      .mockReturnValue(Effect.die("no session should open"));

    const before = (yield* TestConsole.errorLines).length;
    const error = yield* Command.runWith(threadCommand, { version: "0.0.0" })([
      "interrupt",
      "   ",
      "--base-dir",
      baseDir,
    ]).pipe(Effect.flip);

    assert.strictEqual(error._tag, "ThreadUsageError");
    assert.strictEqual(error.message, "'   ' is not a thread id.");
    assert.strictEqual(
      (error as { readonly [Runtime.errorReported]?: boolean })[Runtime.errorReported],
      false,
    );
    assert.deepStrictEqual((yield* TestConsole.errorLines).slice(before), [
      "'   ' is not a thread id.",
    ]);
    assert.strictEqual(session.mock.calls.length, 0);
  }).pipe(Effect.scoped, Effect.provide(cliTestLayer)),
);

it.effect("interrupt routes server and tool errors through reportThreadErrors", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const missingBaseDir = yield* fs.makeTempDirectoryScoped({
      prefix: "t3-thread-interrupt-missing-",
    });
    const beforeMissing = (yield* TestConsole.errorLines).length;
    const notRunning = yield* Command.runWith(threadCommand, { version: "0.0.0" })([
      "interrupt",
      threadId,
      "--base-dir",
      missingBaseDir,
    ]).pipe(Effect.flip);
    assert.strictEqual(notRunning._tag, "ThreadServerNotRunningError");
    assert.deepStrictEqual((yield* TestConsole.errorLines).slice(beforeMissing), [
      notRunning.message,
    ]);

    const baseDir = yield* makeRunningBaseDir("t3-thread-interrupt-errors-");
    const cases: ReadonlyArray<{
      readonly call: McpBridge.McpToolSession["call"];
      readonly tag: string;
      readonly message: string;
    }> = [
      {
        call: () =>
          Effect.succeed({
            isError: true,
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  _tag: "OrchestratorMcpFailure",
                  code: "thread_not_found",
                  message: `Thread ${threadId} was not found.`,
                }),
              },
            ],
          }),
        tag: "ThreadToolFailedError",
        message: `Thread ${threadId} was not found.`,
      },
      {
        call: () =>
          Effect.fail(
            new McpBridge.AcpMcpBridgeError({
              message: "T3 Code MCP tools/call failed.",
              rpcError: { code: -32602, message: "Tool 't3_thread_interrupt' not found" },
            }),
          ),
        tag: "ThreadToolMissingError",
        message: "This T3 Code server has no t3_thread_interrupt tool. Update T3 Code, then retry.",
      },
      {
        call: () =>
          Effect.succeed({ structuredContent: { threadId, runId: null, status: "bogus" } }),
        tag: "ThreadToolFailedError",
        message:
          "The server sent an unexpected t3_thread_interrupt result. Update the t3 CLI to match the server.",
      },
    ];

    for (const testCase of cases) {
      using _session = vi
        .spyOn(McpBridge, "mcpToolSession")
        .mockReturnValue(Effect.succeed({ call: testCase.call }));
      const before = (yield* TestConsole.errorLines).length;
      const error = yield* Command.runWith(threadCommand, { version: "0.0.0" })([
        "interrupt",
        threadId,
        "--base-dir",
        baseDir,
      ]).pipe(Effect.flip);

      assert.strictEqual(error._tag, testCase.tag);
      assert.strictEqual(error.message, testCase.message);
      assert.strictEqual(
        (error as { readonly [Runtime.errorReported]?: boolean })[Runtime.errorReported],
        false,
      );
      assert.deepStrictEqual((yield* TestConsole.errorLines).slice(before), [testCase.message]);
    }
  }).pipe(Effect.scoped, Effect.provide(cliTestLayer)),
);

const messageId = MessageId.make("message-1");

it.effect("send passes --mode (defaulting to queue) and formats each delivery outcome", () =>
  Effect.gen(function* () {
    const baseDir = yield* makeRunningBaseDir("t3-thread-send-mode-");
    const calls: Array<{ readonly tool: string; readonly args: Record<string, unknown> }> = [];
    const cases = [
      {
        label: "default mode on idle thread",
        flags: [] as ReadonlyArray<string>,
        expectedMode: "queue",
        result: { threadId, messageId, runId, status: "running", delivery: "started" },
        expectedLine: "Sent.",
      },
      {
        label: "default mode on running thread",
        flags: [] as ReadonlyArray<string>,
        expectedMode: "queue",
        result: { threadId, messageId, runId, status: "queued", delivery: "queued" },
        expectedLine: "Queued.",
      },
      {
        label: "explicit --mode queue on running thread",
        flags: ["--mode", "queue"],
        expectedMode: "queue",
        result: { threadId, messageId, runId, status: "queued", delivery: "queued" },
        expectedLine: "Queued.",
      },
      {
        label: "--mode auto on idle thread",
        flags: ["--mode", "auto"],
        expectedMode: "auto",
        result: { threadId, messageId, runId, status: "running", delivery: "started" },
        expectedLine: "Sent.",
      },
      {
        label: "--mode auto on running thread (steers)",
        flags: ["--mode", "auto"],
        expectedMode: "auto",
        result: { threadId, messageId, runId, status: "running", delivery: "steered" },
        expectedLine: "Steered.",
      },
      {
        label: "--mode auto on unsteerable running thread (queues)",
        flags: ["--mode", "auto"],
        expectedMode: "auto",
        result: { threadId, messageId, runId, status: "queued", delivery: "queued" },
        expectedLine: "Queued.",
      },
      {
        label: "--mode steer on running thread",
        flags: ["--mode", "steer"],
        expectedMode: "steer",
        result: { threadId, messageId, runId, status: "running", delivery: "steered" },
        expectedLine: "Steered.",
      },
      {
        label: "--mode restart on running thread",
        flags: ["--mode", "restart"],
        expectedMode: "restart",
        result: { threadId, messageId, runId, status: "running", delivery: "restarted" },
        expectedLine: "Restarted.",
      },
    ] as const;

    let index = 0;
    using _session = vi.spyOn(McpBridge, "mcpToolSession").mockReturnValue(
      Effect.succeed({
        call: (tool, args) => {
          calls.push({ tool, args });
          const next = cases[index++];
          return next === undefined
            ? Effect.die(`unexpected ${tool} call`)
            : Effect.succeed({ structuredContent: next.result });
        },
      }),
    );

    for (const testCase of cases) {
      yield* Command.runWith(threadCommand, { version: "0.0.0" })([
        "send",
        threadId,
        "Hello",
        ...testCase.flags,
        "--base-dir",
        baseDir,
      ]);
      assert.strictEqual(
        (yield* TestConsole.logLines).at(-1),
        testCase.expectedLine,
        testCase.label,
      );
    }

    assert.deepStrictEqual(
      calls,
      cases.map((testCase) => ({
        tool: "t3_thread_send",
        args: { threadId, message: "Hello", mode: testCase.expectedMode },
      })),
    );
  }).pipe(Effect.scoped, Effect.provide(cliTestLayer)),
);

it.effect("send --json prints the decoded result for each mode", () =>
  Effect.gen(function* () {
    const baseDir = yield* makeRunningBaseDir("t3-thread-send-json-");
    const cases = [
      {
        mode: "queue",
        result: { threadId, messageId, runId, status: "queued", delivery: "queued" },
      },
      {
        mode: "auto",
        result: { threadId, messageId, runId, status: "running", delivery: "steered" },
      },
      {
        mode: "steer",
        result: { threadId, messageId, runId, status: "running", delivery: "steered" },
      },
      {
        mode: "restart",
        result: { threadId, messageId, runId, status: "running", delivery: "restarted" },
      },
    ] as const;

    let index = 0;
    using _session = vi.spyOn(McpBridge, "mcpToolSession").mockReturnValue(
      Effect.succeed({
        call: (tool, args) => {
          if (tool !== "t3_thread_send") return Effect.die(`unexpected ${tool} call`);
          const next = cases[index++];
          if (next === undefined) return Effect.die("extra t3_thread_send call");
          assert.strictEqual(args.mode, next.mode);
          return Effect.succeed({ structuredContent: next.result });
        },
      }),
    );

    for (const testCase of cases) {
      yield* Command.runWith(threadCommand, { version: "0.0.0" })([
        "send",
        threadId,
        "Hello",
        "--mode",
        testCase.mode,
        "--json",
        "--base-dir",
        baseDir,
      ]);
      assert.deepStrictEqual(
        JSON.parse(String((yield* TestConsole.logLines).at(-1))),
        testCase.result,
        testCase.mode,
      );
    }
  }).pipe(Effect.scoped, Effect.provide(cliTestLayer)),
);

it.effect("send --mode steer on an idle thread reports the server error cleanly", () =>
  Effect.gen(function* () {
    const baseDir = yield* makeRunningBaseDir("t3-thread-send-steer-idle-");
    const serverMessage =
      'Thread thread-1 has no active turn to steer. Use mode: "auto" or "queue" to start a new turn.';
    const calls: Array<{ readonly tool: string; readonly args: Record<string, unknown> }> = [];
    using _session = vi.spyOn(McpBridge, "mcpToolSession").mockReturnValue(
      Effect.succeed({
        call: (tool, args) => {
          calls.push({ tool, args });
          return Effect.succeed({
            isError: true,
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  _tag: "OrchestratorMcpFailure",
                  code: "thread_not_sendable",
                  message: serverMessage,
                }),
              },
            ],
          });
        },
      }),
    );

    const before = (yield* TestConsole.errorLines).length;
    const error = yield* Command.runWith(threadCommand, { version: "0.0.0" })([
      "send",
      threadId,
      "Redirect now",
      "--mode",
      "steer",
      "--base-dir",
      baseDir,
    ]).pipe(Effect.flip);

    assert.strictEqual(error._tag, "ThreadToolFailedError");
    assert.strictEqual(error.message, serverMessage);
    assert.deepStrictEqual((yield* TestConsole.errorLines).slice(before), [serverMessage]);
    assert.deepStrictEqual(calls, [
      { tool: "t3_thread_send", args: { threadId, message: "Redirect now", mode: "steer" } },
    ]);
  }).pipe(Effect.scoped, Effect.provide(cliTestLayer)),
);

it.effect(
  "send --mode auto --wait follows wakes on an idle thread and skips them when steering",
  () =>
    Effect.gen(function* () {
      const baseDir = yield* makeRunningBaseDir("t3-thread-send-wait-");
      const runScenario = (idle: boolean) =>
        Effect.gen(function* () {
          const calls: Array<{ readonly tool: string; readonly args: Record<string, unknown> }> =
            [];
          let waitCalls = 0;
          using _session = vi.spyOn(McpBridge, "mcpToolSession").mockReturnValue(
            Effect.succeed({
              call: (tool, args) => {
                calls.push({ tool, args });
                if (tool === "t3_thread_wait") {
                  waitCalls += 1;
                  if (waitCalls === 1) {
                    return Effect.succeed({
                      structuredContent: {
                        threadId,
                        runId: idle ? null : runId,
                        status: idle ? "idle" : "running",
                        timedOut: !idle,
                      },
                    });
                  }
                  return Effect.succeed({
                    structuredContent: {
                      threadId,
                      runId,
                      status: "completed",
                      timedOut: false,
                      ...(args.untilDelegatedWorkSettled
                        ? { resultRun: { runId, status: "completed" } }
                        : {}),
                    },
                  });
                }
                if (tool === "t3_thread_send") {
                  return Effect.succeed({
                    structuredContent: {
                      threadId,
                      messageId,
                      runId,
                      status: "running",
                      delivery: idle ? "started" : "steered",
                    },
                  });
                }
                if (tool === "t3_thread_read") {
                  if (args.view === "messages") {
                    return Effect.succeed({
                      structuredContent: {
                        items: [
                          {
                            position: 0,
                            itemId: "item-1",
                            runId,
                            messageId: null,
                            type: "assistant_message",
                            status: "completed",
                            text: idle ? "Idle reply" : "Steered reply",
                            updatedAt: "2026-01-01T00:00:00.000Z",
                          },
                        ],
                        nextPosition: 0,
                        hasMore: false,
                      },
                    });
                  }
                  return Effect.succeed({
                    structuredContent: {
                      recentRuns: [
                        {
                          runId,
                          ordinal: 1,
                          status: "completed",
                          providerInstanceId: "codex",
                          model: "test",
                          requestedAt: "2026-01-01T00:00:00.000Z",
                          startedAt: "2026-01-01T00:00:00.000Z",
                          completedAt: "2026-01-01T00:00:01.000Z",
                        },
                      ],
                      items: [],
                      nextPosition: null,
                      hasMore: false,
                    },
                  });
                }
                return Effect.die(`unexpected ${tool} call`);
              },
            }),
          );

          yield* Command.runWith(threadCommand, { version: "0.0.0" })([
            "send",
            threadId,
            "Follow up",
            "--mode",
            "auto",
            "--wait",
            "--base-dir",
            baseDir,
          ]);

          assert.strictEqual(
            (yield* TestConsole.logLines).at(-1),
            idle ? "Idle reply" : "Steered reply",
          );
          const sendCall = calls.find((entry) => entry.tool === "t3_thread_send");
          assert.deepStrictEqual(sendCall?.args, {
            threadId,
            message: "Follow up",
            mode: "auto",
          });
          const settledWait = calls.some(
            (entry) =>
              entry.tool === "t3_thread_wait" &&
              entry.args.runId === runId &&
              entry.args.untilDelegatedWorkSettled === true,
          );
          assert.strictEqual(settledWait, idle);
        });

      yield* runScenario(true);
      yield* runScenario(false);
    }).pipe(Effect.scoped, Effect.provide(cliTestLayer)),
);

it.effect("send rejects an invalid --mode before opening a session", () =>
  Effect.gen(function* () {
    const baseDir = yield* makeRunningBaseDir("t3-thread-send-invalid-mode-");
    using session = vi
      .spyOn(McpBridge, "mcpToolSession")
      .mockReturnValue(Effect.die("no session should open"));

    const error = yield* Command.runWith(threadCommand, { version: "0.0.0" })([
      "send",
      threadId,
      "Hello",
      "--mode",
      "bogus",
      "--base-dir",
      baseDir,
    ]).pipe(Effect.flip);

    if (!CliError.isCliError(error) || error._tag !== "ShowHelp") {
      assert.fail(`Expected ShowHelp, got ${String(error)}`);
    }
    const flagError = error.errors[0];
    if (flagError?._tag !== "InvalidValue") {
      assert.fail(`Expected InvalidValue, got ${String(flagError?._tag)}`);
    }
    assert.strictEqual(flagError.option, "mode");
    assert.strictEqual(flagError.value, "bogus");
    assert.strictEqual(session.mock.calls.length, 0);
  }).pipe(Effect.scoped, Effect.provide(cliTestLayer)),
);

it.effect("send --help documents --mode choices and default behavior", () =>
  Effect.gen(function* () {
    yield* Command.runWith(threadCommand, { version: "0.0.0" })(["send", "--help"]);
    const help = (yield* TestConsole.logLines).join("\n");
    assert.include(help, "--mode");
    assert.include(help, "queue");
    assert.include(help, "auto");
    assert.include(help, "steer");
    assert.include(help, "restart");
    assert.include(help, "idle");
    assert.include(help, "running");
  }).pipe(Effect.provide(Layer.mergeAll(cliTestLayer, Layer.fresh(TestConsole.layer)))),
);
