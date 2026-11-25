import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  MessageId,
  NodeId,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadShell,
  ProviderInstanceId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { threadShellFromProjection } from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import { idleThreadProjection, liveThreadShell } from "./McpToolAccess.testkit.ts";
import {
  assertLiveCaller,
  assertTargetWithinLimits,
  isLiveCallerShell,
  readThread,
} from "./threadAccess.ts";

const bareId = ThreadId.make("5d0b4a3e-8c1f-4a52-9d37-2f6c7e1b9a04");
const claudeCode: McpInvocationContext.McpClientCaller = {
  sessionId: "thread-access",
  label: "Claude Code",
  access: "full-access",
};
const client: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:thread-access"),
  requestNamespace: "client:thread-access",
  thread: undefined,
  client: claudeCode,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};

const linksHint =
  "Thread ids belong to one environment: for a thread on a linked one, find it with `t3_environment_links` and pass its `environmentId` to a tool that takes one.";

const readBare = (
  existing: ReadonlyArray<OrchestrationV2ThreadShell | ThreadId>,
  scope: McpInvocationContext.McpInvocationScope = client,
  threadId: ThreadId = bareId,
) => {
  const shells = existing.map((shell) =>
    typeof shell === "string" ? liveThreadShell(shell) : shell,
  );
  return readThread(threadId).pipe(
    Effect.flip,
    Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
    Effect.provide(
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: (threadId) =>
          Effect.succeed(shells.find((shell) => shell.id === threadId) ?? null),
      }),
    ),
  );
};

it.effect("points a bare uuid at the mcp: thread it belongs to", () =>
  Effect.gen(function* () {
    const error = yield* readBare([ThreadId.make(`mcp:${bareId}`)]);

    expect(error.code).toBe("thread_not_found");
    expect(error.message).toBe(
      `The thread was not found. Did you mean \`mcp:${bareId}\`? ${linksHint}`,
    );
  }),
);

it.effect("tells a caller with linked environments that the thread may be on one of them", () =>
  Effect.gen(function* () {
    const error = yield* readBare([], { ...client, linkedEnvironments: true });

    expect(error.code).toBe("thread_not_found");
    expect(error.message).toContain("t3_environment_links");
    expect(error.message).toContain("environmentId");

    const linksOff = yield* readBare([], { ...client, linkedEnvironments: false });
    expect(linksOff.message).toBe("The thread was not found.");
    const peerLink = yield* readBare([], {
      ...client,
      linkedEnvironments: true,
      client: { ...claudeCode, linked: true },
    });
    expect(peerLink.message).toBe("The thread was not found.");

    // A thread a fenced link started may not use this environment's links.
    const fencedThread = ThreadId.make("thread:started-by-fenced-link");
    const fenced = yield* readBare(
      [
        {
          ...liveThreadShell(fencedThread),
          linkOrigin: { sessionId: "peer-session", label: "Laptop", access: "auto" },
        },
      ],
      {
        ...client,
        linkedEnvironments: true,
        client: undefined,
        thread: {
          threadId: fencedThread,
          providerSessionId: "provider-session",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
      },
    );
    expect(fenced.message).toBe("The thread was not found.");
  }),
);

it.effect("points an unencoded delegated-task id at the encoded thread it belongs to", () =>
  Effect.gen(function* () {
    const commandId = `command:mcp:${bareId}:delegate-task:0e7d2c41-6b9a-4f3e-8d15-a2c4b6e8f019`;
    const encoded = ThreadId.make(`thread:delegated-task:${encodeURIComponent(commandId)}`);
    const error = yield* readBare(
      [encoded],
      client,
      ThreadId.make(`thread:delegated-task:${commandId}`),
    );

    expect(error.code).toBe("thread_not_found");
    expect(error.message).toContain(`\`${encoded}\``);
  }),
);

it.effect("identifies the target and effective caller ceiling when a thread write is refused", () =>
  Effect.gen(function* () {
    for (const [runtimeMode, interactionMode, code] of [
      ["approval-required", "default", "runtime_mode_escalation_denied"],
      ["full-access", "plan", "interaction_mode_escalation_denied"],
      ["approval-required", "plan", "runtime_mode_escalation_denied"],
    ] as const) {
      const target = liveThreadShell(bareId, { runtimeMode: "full-access" });
      const error = yield* assertTargetWithinLimits({ runtimeMode, interactionMode }, target).pipe(
        Effect.flip,
      );

      expect(error.code).toBe(code);
      expect(error.message).toContain(bareId);
      expect(error.message).toContain("full-access/default");
      expect(error.message).toContain(`${runtimeMode}/${interactionMode}`);
      expect(error.message).not.toMatch(/child|parent mode/i);
    }
  }),
);

const claudeInstanceId = ProviderInstanceId.make("claudeAgent");
const codexInstanceId = ProviderInstanceId.make("codex");
const requestedAt = DateTime.makeUnsafe("2026-11-08T12:32:48.852Z");
const completedAt = DateTime.makeUnsafe("2026-11-08T12:32:31.797Z");

const makeRun = (
  threadId: ThreadId,
  overrides: Partial<OrchestrationV2Run> = {},
): OrchestrationV2Run => ({
  id: RunId.make("run:wake"),
  threadId,
  ordinal: 1,
  providerInstanceId: claudeInstanceId,
  modelSelection: { instanceId: claudeInstanceId, model: "claude-sonnet-4-6" },
  providerThreadId: ProviderThreadId.make("provider-thread:1"),
  userMessageId: MessageId.make("message:1"),
  rootNodeId: NodeId.make("node:1"),
  activeAttemptId: RunAttemptId.make("attempt:1"),
  status: "queued",
  queuePosition: 1,
  requestedAt,
  startedAt: null,
  completedAt: null,
  checkpointId: null,
  contextHandoffId: null,
  ...overrides,
});

it("isLiveCallerShell accepts an unheld queued continuation for the same provider and refuses settled, held, or foreign shells", () => {
  const threadId = ThreadId.make("thread:wake-shell");
  const baseShell: OrchestrationV2ThreadShell = {
    ...liveThreadShell(threadId, { activeRunId: null }),
    providerInstanceId: claudeInstanceId,
    modelSelection: { instanceId: claudeInstanceId, model: "claude-sonnet-4-6" },
  };
  const settledRun = makeRun(threadId, {
    id: RunId.make("run:settled"),
    ordinal: 1,
    status: "completed",
    queuePosition: null,
    startedAt: completedAt,
    completedAt,
  });
  const queuedWake = makeRun(threadId, {
    id: RunId.make("run:queued-wake"),
    ordinal: 2,
    status: "queued",
  });
  const heldWake = makeRun(threadId, {
    id: RunId.make("run:held-wake"),
    ordinal: 2,
    status: "queued",
    queueHeld: true,
  });

  const queuedShell = threadShellFromProjection({
    ...idleThreadProjection(baseShell),
    runs: [settledRun, queuedWake],
  });
  const settledShell = threadShellFromProjection({
    ...idleThreadProjection(baseShell),
    runs: [settledRun],
  });
  const heldShell = threadShellFromProjection({
    ...idleThreadProjection(baseShell),
    runs: [settledRun, heldWake],
  });
  const idleShell = threadShellFromProjection(idleThreadProjection(baseShell));

  expect(isLiveCallerShell(queuedShell, claudeInstanceId)).toBe(true);
  expect(isLiveCallerShell(queuedShell, codexInstanceId)).toBe(false);
  expect(isLiveCallerShell({ ...queuedShell, archivedAt: requestedAt }, claudeInstanceId)).toBe(
    false,
  );
  expect(isLiveCallerShell(settledShell, claudeInstanceId)).toBe(false);
  expect(isLiveCallerShell(heldShell, claudeInstanceId)).toBe(false);
  expect(isLiveCallerShell(idleShell, claudeInstanceId)).toBe(false);
});

it.effect(
  "assertLiveCaller verifies queued run ownership so another provider's queued run cannot revive a stale caller",
  () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:queued-owner");
      const baseShell: OrchestrationV2ThreadShell = {
        ...liveThreadShell(threadId, { activeRunId: null }),
        providerInstanceId: claudeInstanceId,
        modelSelection: { instanceId: claudeInstanceId, model: "claude-sonnet-4-6" },
      };
      const queuedRunId = RunId.make("run:queued");
      const scope: McpInvocationContext.McpInvocationScope = {
        ...client,
        client: undefined,
        thread: {
          threadId,
          providerSessionId: "provider:claude",
          providerInstanceId: claudeInstanceId,
        },
      };
      const checkWithRun = (run: OrchestrationV2Run) => {
        const shell = threadShellFromProjection({
          ...idleThreadProjection(baseShell),
          runs: [run],
        });
        const threads = ThreadManagement.ThreadManagementService.of({
          getProjectThreadRecords: () =>
            Effect.succeed({
              ...idleThreadProjection(baseShell),
              runs: [run],
            }),
        } as unknown as ThreadManagement.ThreadManagementService["Service"]);
        return assertLiveCaller({
          caller: shell,
          scope,
          threads,
          limits: { runtimeMode: shell.runtimeMode, interactionMode: shell.interactionMode },
        });
      };

      // Unheld queued wake run for the same provider passes.
      yield* checkWithRun(makeRun(threadId, { id: queuedRunId, status: "queued" }));

      // A run that transitioned from queued to running before the run check still passes.
      const shellStillQueued: OrchestrationV2ThreadShell = {
        ...baseShell,
        status: "queued",
        latestRunId: queuedRunId,
        latestRunRequestedAt: requestedAt,
        latestRunCompletedAt: null,
      };
      yield* assertLiveCaller({
        caller: shellStillQueued,
        scope,
        threads: ThreadManagement.ThreadManagementService.of({
          getProjectThreadRecords: () =>
            Effect.succeed({
              ...idleThreadProjection(baseShell),
              runs: [
                makeRun(threadId, { id: queuedRunId, status: "running", startedAt: requestedAt }),
              ],
            }),
        } as unknown as ThreadManagement.ThreadManagementService["Service"]),
        limits: {
          runtimeMode: shellStillQueued.runtimeMode,
          interactionMode: shellStillQueued.interactionMode,
        },
      });

      // Another provider queued a run behind Claude's queued wake run: Claude still passes.
      const claudeQueued = makeRun(threadId, {
        id: RunId.make("run:claude-wake"),
        ordinal: 2,
        status: "queued",
      });
      const codexQueuedBehind = makeRun(threadId, {
        id: RunId.make("run:codex-followup"),
        ordinal: 3,
        status: "queued",
        providerInstanceId: codexInstanceId,
        modelSelection: { instanceId: codexInstanceId, model: "gpt-5" },
      });
      const multiQueuedShell = threadShellFromProjection({
        ...idleThreadProjection(baseShell),
        runs: [claudeQueued, codexQueuedBehind],
      });
      expect(multiQueuedShell.latestRunId).toBe(codexQueuedBehind.id);
      yield* assertLiveCaller({
        caller: multiQueuedShell,
        scope,
        threads: ThreadManagement.ThreadManagementService.of({
          getProjectThreadRecords: () =>
            Effect.succeed({
              ...idleThreadProjection(baseShell),
              runs: [claudeQueued, codexQueuedBehind],
            }),
        } as unknown as ThreadManagement.ThreadManagementService["Service"]),
        limits: {
          runtimeMode: multiQueuedShell.runtimeMode,
          interactionMode: multiQueuedShell.interactionMode,
        },
      });

      // Another provider queued a run while thread.providerInstanceId still names Claude.
      const foreignQueuedError = yield* checkWithRun(
        makeRun(threadId, {
          id: queuedRunId,
          status: "queued",
          providerInstanceId: codexInstanceId,
          modelSelection: { instanceId: codexInstanceId, model: "gpt-5" },
        }),
      ).pipe(Effect.flip);
      expect(foreignQueuedError.code).toBe("parent_not_active");

      // A held queued run cannot revive a stale caller even if a stale shell reported status queued.
      const heldError = yield* assertLiveCaller({
        caller: shellStillQueued,
        scope,
        threads: ThreadManagement.ThreadManagementService.of({
          getProjectThreadRecords: () =>
            Effect.succeed({
              ...idleThreadProjection(baseShell),
              runs: [makeRun(threadId, { id: queuedRunId, status: "queued", queueHeld: true })],
            }),
        } as unknown as ThreadManagement.ThreadManagementService["Service"]),
        limits: {
          runtimeMode: shellStillQueued.runtimeMode,
          interactionMode: shellStillQueued.interactionMode,
        },
      }).pipe(Effect.flip);
      expect(heldError.code).toBe("parent_not_active");
    }),
);
