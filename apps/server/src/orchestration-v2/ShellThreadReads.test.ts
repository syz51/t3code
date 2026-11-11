import { assert, it } from "@effect/vitest";
import type { OrchestrationV2ThreadShell } from "@t3tools/contracts";
import { ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import { OrchestratorProjectionError } from "./Orchestrator.ts";
import * as ShellThreadReads from "./ShellThreadReads.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

const provideReads =
  (
    management: Pick<
      Partial<ThreadManagementService.ThreadManagementService["Service"]>,
      "getThreadShell" | "getShellSnapshot"
    >,
  ) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provide(
        ShellThreadReads.layer.pipe(
          Layer.provide(Layer.mock(ThreadManagementService.ThreadManagementService)(management)),
        ),
      ),
    );

// The shell's title names the read that produced it; only the first read waits for `release`.
const gatedReads = Effect.gen(function* () {
  const started = yield* Deferred.make<void>();
  const release = yield* Deferred.make<void>();
  const count = { reads: 0 };
  const getThreadShell = (id: ThreadId) =>
    Effect.suspend(() => {
      count.reads += 1;
      const shell = { id, title: `read ${count.reads}` } as OrchestrationV2ThreadShell;
      return count.reads === 1
        ? Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as(shell),
          )
        : Effect.succeed(shell);
    });
  return { started, release, count, getThreadShell };
});

const threadId = ThreadId.make("thread:shared");
const titleAt = (sequence: number) =>
  ShellThreadReads.ShellThreadReads.pipe(
    Effect.flatMap((shellReads) => shellReads.read([{ threadId, sequence }])),
    Effect.map((shells) => shells.get(threadId)?.title),
  );

it.effect("a read answers older events of its thread and never a newer one", () =>
  Effect.gen(function* () {
    const { started, release, count, getThreadShell } = yield* gatedReads;
    yield* Effect.gen(function* () {
      const first = yield* Effect.forkChild(titleAt(5));
      yield* Deferred.await(started);
      // The read for event 5 is still running and must not answer event 7.
      assert.equal(yield* titleAt(7), "read 2");
      assert.equal(yield* titleAt(6), "read 2");
      assert.equal(yield* titleAt(7), "read 2");
      yield* Deferred.succeed(release, undefined);
      assert.equal(yield* Fiber.join(first), "read 1");
      assert.equal(count.reads, 2);
      // A settled read is kept only briefly, so a later replay reads the shell again.
      yield* TestClock.adjust("2 seconds");
      assert.equal(yield* titleAt(5), "read 3");
    }).pipe(provideReads({ getThreadShell }));
  }),
);

it.effect("a read outlives the subscriber that started it", () =>
  Effect.gen(function* () {
    const { started, release, count, getThreadShell } = yield* gatedReads;
    yield* Effect.gen(function* () {
      const first = yield* Effect.forkChild(titleAt(5));
      yield* Deferred.await(started);
      yield* Fiber.interrupt(first);
      yield* Deferred.succeed(release, undefined);
      assert.equal(yield* titleAt(5), "read 1");
      assert.equal(count.reads, 1);
    }).pipe(provideReads({ getThreadShell }));
  }),
);

it.effect("a failed read is reported to its subscribers and not kept", () =>
  Effect.gen(function* () {
    let reads = 0;
    const getThreadShell = (id: ThreadId) =>
      Effect.suspend(() => {
        reads += 1;
        return reads === 1
          ? Effect.fail(new OrchestratorProjectionError({ threadId: id }))
          : Effect.succeed({ id } as OrchestrationV2ThreadShell);
      });

    yield* Effect.gen(function* () {
      const shellReads = yield* ShellThreadReads.ShellThreadReads;
      const read = shellReads.read([{ threadId, sequence: 1 }]);
      assert.instanceOf(yield* Effect.flip(read), OrchestratorProjectionError);
      assert.equal((yield* read).get(threadId)?.id, threadId);
      assert.equal(reads, 2);
    }).pipe(provideReads({ getThreadShell }));
  }),
);

it.effect("a read that dies fails its subscribers instead of leaving them waiting", () =>
  Effect.gen(function* () {
    const shellReads = yield* ShellThreadReads.ShellThreadReads;
    const exit = yield* Effect.exit(
      shellReads.read([
        { threadId, sequence: 1 },
        { threadId: ThreadId.make("thread:other"), sequence: 2 },
      ]),
    );
    assert.equal(Exit.isFailure(exit) ? Cause.squash(exit.cause) : exit, "batch died");
  }).pipe(provideReads({ getShellSnapshot: () => Effect.die("batch died") })),
);
