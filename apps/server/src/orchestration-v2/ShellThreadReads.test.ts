import { assert, it } from "@effect/vitest";
import type { OrchestrationV2ThreadShell } from "@t3tools/contracts";
import { ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import * as ShellThreadReads from "./ShellThreadReads.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

const provideReads =
  (
    getThreadShell: (
      threadId: ThreadId,
    ) => Effect.Effect<OrchestrationV2ThreadShell | null, string>,
  ) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provide(ShellThreadReads.layer),
      Effect.provideService(ThreadManagementService.ThreadManagementService, {
        getThreadShell,
      } as unknown as ThreadManagementService.ThreadManagementService["Service"]),
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
    }).pipe(provideReads(getThreadShell));
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
    }).pipe(provideReads(getThreadShell));
  }),
);

it.effect("a failed read is reported to its subscribers and not kept", () =>
  Effect.gen(function* () {
    let reads = 0;
    const getThreadShell = (id: ThreadId) =>
      Effect.suspend(() => {
        reads += 1;
        return reads === 1
          ? Effect.fail("read failed")
          : Effect.succeed({ id } as OrchestrationV2ThreadShell);
      });

    yield* Effect.gen(function* () {
      const shellReads = yield* ShellThreadReads.ShellThreadReads;
      const read = shellReads.read([{ threadId, sequence: 1 }]);
      assert.equal(yield* Effect.flip(read), "read failed" as never);
      assert.equal((yield* read).get(threadId)?.id, threadId);
      assert.equal(reads, 2);
    }).pipe(provideReads(getThreadShell));
  }),
);
