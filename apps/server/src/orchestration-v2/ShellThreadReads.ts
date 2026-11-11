import type { OrchestrationV2ThreadShell, ThreadId } from "@t3tools/contracts";
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
  readonly shell: Deferred.Deferred<
    OrchestrationV2ThreadShell | null,
    Orchestrator.OrchestratorV2Error
  >;
}

const RETAINED_READS = 1_024;

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
  // A read started for an event stays valid for that thread's older events, never for newer ones.
  const latest = new Map<ThreadId, ShellThreadRead>();

  const settle = (
    read: ShellThreadRead,
    exit: Exit.Exit<OrchestrationV2ThreadShell | null, Orchestrator.OrchestratorV2Error>,
  ) => {
    if (Exit.isFailure(exit) && latest.get(read.threadId) === read) latest.delete(read.threadId);
    Deferred.doneUnsafe(read.shell, exit);
  };

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
        for (const read of reads) settle(read, Exit.succeed(shells.get(read.threadId) ?? null));
        return;
      }
      yield* Effect.forEach(
        reads,
        (read) =>
          threadManagement.getThreadShell(read.threadId).pipe(
            Effect.exit,
            Effect.map((exit) => settle(read, exit)),
          ),
        { concurrency: 8, discard: true },
      );
    },
    // A defect or a closing scope must not leave a subscriber waiting on a read nobody finishes.
    (effect, reads) =>
      Effect.onExit(effect, (exit) =>
        Effect.sync(() => {
          if (Exit.isSuccess(exit)) return;
          for (const read of reads) settle(read, Exit.failCause(exit.cause));
        }),
      ),
  );

  const read: ShellThreadReads["Service"]["read"] = Effect.fn("ShellThreadReads.read")(
    function* (requests) {
      const wanted: Array<ShellThreadRead> = [];
      const started: Array<ShellThreadRead> = [];
      for (const request of requests) {
        const shared = latest.get(request.threadId);
        if (shared !== undefined && shared.sequence >= request.sequence) {
          wanted.push(shared);
          continue;
        }
        const own = { ...request, shell: Deferred.makeUnsafe() } satisfies ShellThreadRead;
        latest.delete(request.threadId);
        latest.set(request.threadId, own);
        wanted.push(own);
        started.push(own);
      }
      for (const threadId of latest.keys()) {
        if (latest.size <= RETAINED_READS) break;
        latest.delete(threadId);
      }
      // The read outlives its first subscriber, so one that disconnects cannot strand the others.
      if (started.length > 0) yield* Effect.forkIn(load(started), scope);
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
