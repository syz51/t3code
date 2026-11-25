import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { makeLocalFileTracer, makeTraceSink } from "@t3tools/shared/observability";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Tracer from "effect/Tracer";

import * as StallTraceCapture from "./StallTraceCapture.ts";

const msToNs = (ms: number) => BigInt(ms) * 1_000_000n;

describe("StallTraceCapture", () => {
  it.effect("attributes active and slow spans and preserves trace lines across rotation", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "stall-trace-capture-" });
      const tracePath = path.join(dir, "server.trace.ndjson");
      const snapshotDir = path.join(dir, "event-loop-stall-traces");

      const baseMs = Date.parse("2026-11-25T06:00:00.000Z");
      // Older record outside the 60s capture window (must be excluded).
      const oldLine = JSON.stringify({
        type: "effect-span",
        name: "old.span",
        endTimeUnixNano: String(msToNs(baseMs - 120_000)),
        durationMs: 12,
      });
      // Record inside the capture window that already rotated into `.1`.
      const rotatedLine = JSON.stringify({
        type: "effect-span",
        name: "rotated.inWindow",
        endTimeUnixNano: String(msToNs(baseMs - 40_000)),
        durationMs: 85,
      });
      yield* fs.writeFileString(`${tracePath}.1`, `${oldLine}\n${rotatedLine}\n`);

      const sink = yield* makeTraceSink({
        filePath: tracePath,
        maxBytes: 1024 * 1024,
        maxFiles: 2,
        batchWindowMs: 60_000,
      });
      const fileTracer = yield* makeLocalFileTracer({
        filePath: tracePath,
        maxBytes: 1024 * 1024,
        maxFiles: 2,
        batchWindowMs: 60_000,
        sink,
      });
      const capture = yield* StallTraceCapture.make({
        tracer: fileTracer,
        sink,
        snapshotDir,
        minWindowMs: 60_000,
        cooldownMs: 30_000,
      });

      const startSpan = (name: string, startMs: number) =>
        capture.tracer.span({
          name,
          parent: Option.none(),
          annotations: Context.empty(),
          links: [],
          startTime: msToNs(startMs),
          kind: "internal",
          root: false,
          sampled: true,
        });

      // Long-lived idle subscription opened 10 minutes earlier should not be blamed.
      const idleSubscription = startSpan("ws.subscribeShell", baseMs - 600_000);
      // Fast span (<50ms) should stay out of slowSpans.
      const fast = startSpan("sqlite.fast", baseMs - 5_000);
      fast.end(msToNs(baseMs - 4_995), Exit.void);
      // Slow span in window should appear in slowSpans and in the preserved snapshot.
      const slow = startSpan("ProjectionStore.heavyRead", baseMs - 4_000);
      slow.end(msToNs(baseMs - 2_800), Exit.void);
      // Active span still open when the stall sample fires.
      const active = startSpan("AntigravityUsage.scan", baseMs - 2_500);

      const detectedAt = DateTime.makeUnsafe(baseMs);
      const attribution = capture.service.attribute({
        detectedAt,
        delayMaxMs: 2_500,
        windowMs: 30_000,
      });
      const snapshotPath = yield* capture.service.saveSnapshot({
        detectedAt,
        delayMaxMs: 2_500,
        windowMs: 30_000,
      });

      assert.deepStrictEqual(attribution.activeSpans, ["AntigravityUsage.scan (2500ms)"]);
      assert.deepStrictEqual(attribution.slowSpans, ["ProjectionStore.heavyRead (1200ms)"]);
      assert.isDefined(snapshotPath);

      const savedText = yield* fs.readFileString(snapshotPath!);
      assert.notInclude(savedText, "old.span");
      assert.include(savedText, "rotated.inWindow");
      assert.include(savedText, "ProjectionStore.heavyRead");

      // A second snapshot within cooldown skips writing another file while attribution stays live.
      const duringCooldownAt = DateTime.makeUnsafe(baseMs + 5_000);
      const duringCooldownPath = yield* capture.service.saveSnapshot({
        detectedAt: duringCooldownAt,
        delayMaxMs: 2_100,
        windowMs: 30_000,
      });
      const duringCooldownAttr = capture.service.attribute({
        detectedAt: duringCooldownAt,
        delayMaxMs: 2_100,
        windowMs: 30_000,
      });
      assert.isUndefined(duringCooldownPath);
      assert.deepStrictEqual(duringCooldownAttr.activeSpans, ["AntigravityUsage.scan (7500ms)"]);

      active.end(msToNs(baseMs + 6_000), Exit.void);
      idleSubscription.end(msToNs(baseMs + 6_000), Exit.void);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "bounds snapshot size to newest lines and prunes snapshots beyond maxSnapshotFiles",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "stall-trace-prune-" });
        const tracePath = path.join(dir, "server.trace.ndjson");
        const snapshotDir = path.join(dir, "event-loop-stall-traces");

        const baseMs = Date.parse("2026-11-25T06:10:00.000Z");
        const line1 = JSON.stringify({
          name: "first-trimmed",
          endTimeUnixNano: String(msToNs(baseMs - 2_000)),
          pad: "a".repeat(80),
        });
        const line2 = JSON.stringify({
          name: "second-kept",
          endTimeUnixNano: String(msToNs(baseMs - 1_000)),
          pad: "b".repeat(80),
        });
        yield* fs.writeFileString(tracePath, `${line1}\n${line2}\n`);

        const inner = Tracer.make({ span: (options) => new Tracer.NativeSpan(options) });
        const capture = yield* StallTraceCapture.make({
          tracer: inner,
          sink: { filePath: tracePath, flush: Effect.void },
          snapshotDir,
          maxSnapshotBytes: Buffer.byteLength(line2) + 10,
          maxSnapshotFiles: 2,
          cooldownMs: 0,
        });

        const snap1 = yield* capture.service.saveSnapshot({
          detectedAt: DateTime.makeUnsafe(baseMs),
          delayMaxMs: 2_100,
          windowMs: 30_000,
        });
        assert.isDefined(snap1);
        const text = yield* fs.readFileString(snap1!);
        assert.notInclude(text, "first-trimmed");
        assert.include(text, "second-kept");

        yield* capture.service.saveSnapshot({
          detectedAt: DateTime.makeUnsafe(baseMs + 1_000),
          delayMaxMs: 2_100,
          windowMs: 30_000,
        });
        yield* capture.service.saveSnapshot({
          detectedAt: DateTime.makeUnsafe(baseMs + 2_000),
          delayMaxMs: 2_100,
          windowMs: 30_000,
        });

        const files = (yield* fs.readDirectory(snapshotDir)).toSorted();
        assert.strictEqual(files.length, 2);
        assert.notInclude(files, path.basename(snap1!));
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});
