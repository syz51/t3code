import type { OrchestrationV2ThreadShell, ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

import type * as Orchestrator from "./Orchestrator.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

export interface ShellThreadReadRequest {
  readonly threadId: ThreadId;
  /** Sequence of the committed event the shell must reflect. */
  readonly sequence: number;
}

interface ShellThreadRead extends ShellThreadReadRequest {
  settledAt: number | null;
  readonly shell: Deferred.Deferred<
    OrchestrationV2ThreadShell | null,
    Orchestrator.OrchestratorV2Error
  >;
}

// Long enough for subscribers whose 50 ms event groups are out of step, short enough that a
// later replay reads the shell again.
const SETTLED_READ_KEPT_MS = 1_000;

/** Shares thread shell reads between shell subscribers that project the same events. */
export class ShellThreadReads extends Context.Service<
  ShellThreadReads,
  {
    /** Each shell is at least as new as its request's event; a missing thread reads as null. */
    readonly read: (
      requests: ReadonlyArray<ShellThreadReadRequest>,
    ) => Effect.Effect<
      ReadonlyMap<ThreadId, OrchestrationV2ThreadShell | null>,
      Orchestrator.OrchestratorV2Error
    >;
  }
>()("t3/orchestration-v2/ShellThreadReads") {}

const make = Effect.gen(function* () {
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const scope = yield* Effect.scope;
  // A read started for an event answers that thread's older events, never newer ones.
  const latest = new Map<ThreadId, ShellThreadRead>();

  const settle = (
    read: ShellThreadRead,
    exit: Exit.Exit<OrchestrationV2ThreadShell | null, Orchestrator.OrchestratorV2Error>,
    now: number,
  ) => {
    if (Exit.isFailure(exit)) {
      if (latest.get(read.threadId) === read) latest.delete(read.threadId);
    } else {
      read.settledAt = now;
    }
    Deferred.doneUnsafe(read.shell, exit);
  };
  const usable = (read: ShellThreadRead, now: number) =>
    read.settledAt === null || now - read.settledAt <= SETTLED_READ_KEPT_MS;

  const load = Effect.fn("ShellThreadReads.load")(
    function* (reads: ReadonlyArray<ShellThreadRead>) {
      // A failed batch can't name its thread, so the scalar reads below report which one is bad.
      const batch =
        reads.length > 1
          ? yield* threadManagement
              .getShellSnapshot({ threadIds: reads.map((read) => read.threadId) })
              .pipe(Effect.orElseSucceed(() => null))
          : null;
      if (batch !== null) {
        const shells = new Map(
          [...batch.threads, ...batch.archivedThreads].map((shell) => [shell.id, shell] as const),
        );
        const now = yield* Clock.currentTimeMillis;
        for (const read of reads) {
          settle(read, Exit.succeed(shells.get(read.threadId) ?? null), now);
        }
        return;
      }
      yield* Effect.forEach(
        reads,
        (read) =>
          Effect.gen(function* () {
            const exit = yield* Effect.exit(threadManagement.getThreadShell(read.threadId));
            settle(read, exit, yield* Clock.currentTimeMillis);
          }),
        { concurrency: 8, discard: true },
      );
    },
    // A defect or a closing scope must not leave a subscriber waiting on a read nobody finishes.
    (effect, reads) =>
      Effect.onExit(effect, (exit) =>
        Effect.sync(() => {
          if (Exit.isSuccess(exit)) return;
          for (const read of reads) settle(read, Exit.failCause(exit.cause), 0);
        }),
      ),
  );

  const read: ShellThreadReads["Service"]["read"] = Effect.fn("ShellThreadReads.read")(
    function* (requests) {
      const now = yield* Clock.currentTimeMillis;
      // Registering a read and starting it are one step: an interrupt between them would leave
      // other subscribers waiting on a read that never runs.
      const wanted = yield* Effect.uninterruptible(
        Effect.gen(function* () {
          for (const [threadId, kept] of latest) {
            if (usable(kept, now)) break;
            latest.delete(threadId);
          }
          const wanted: Array<ShellThreadRead> = [];
          const started: Array<ShellThreadRead> = [];
          for (const request of requests) {
            const shared = latest.get(request.threadId);
            if (
              shared !== undefined &&
              shared.sequence >= request.sequence &&
              usable(shared, now)
            ) {
              wanted.push(shared);
              continue;
            }
            const own: ShellThreadRead = {
              ...request,
              settledAt: null,
              shell: Deferred.makeUnsafe(),
            };
            latest.delete(request.threadId);
            latest.set(request.threadId, own);
            wanted.push(own);
            started.push(own);
          }
          // The read outlives its first subscriber, so one that disconnects cannot strand the others.
          if (started.length > 0) {
            yield* Effect.forkIn(Effect.interruptible(load(started)), scope);
          }
          return wanted;
        }),
      );
      const shells = new Map<ThreadId, OrchestrationV2ThreadShell | null>();
      for (const shared of wanted) {
        shells.set(shared.threadId, yield* Deferred.await(shared.shell));
      }
      return shells;
    },
  );

  return ShellThreadReads.of({ read });
});

export const layer = Layer.effect(ShellThreadReads, make);
