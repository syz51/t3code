import type { TraceSink } from "@t3tools/shared/observability";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as Tracer from "effect/Tracer";

const NOTABLE_SPAN_MS = 50;
const MAX_RECENT_SPANS = 128;
const REPORTED_SPANS = 8;
const ACTIVE_SPAN_MAX_AGE_NS = BigInt(5 * 60_000) * 1_000_000n;
const DEFAULT_MIN_WINDOW_MS = 60_000;
const DEFAULT_MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_SNAPSHOT_FILES = 10;
const DEFAULT_COOLDOWN_MS = 30_000;
const STALL_SNAPSHOT_PREFIX = "stall-";
const STALL_SNAPSHOT_SUFFIX = ".trace.ndjson";
const END_TIME_NANO_PATTERN = /"endTimeUnixNano":"(\d+)"/;

interface StallSpanAttribution {
  readonly activeSpans: ReadonlyArray<string>;
  readonly slowSpans: ReadonlyArray<string>;
}

interface RecentSpan {
  readonly name: string;
  readonly durationMs: number;
  readonly endTimeNs: bigint;
}

interface StallTraceCaptureInput {
  readonly detectedAt: DateTime.Utc;
  readonly delayMaxMs: number;
  readonly windowMs: number;
}

interface StallTraceCaptureService {
  readonly attribute: (input: StallTraceCaptureInput) => StallSpanAttribution;
  readonly saveSnapshot: (input: StallTraceCaptureInput) => Effect.Effect<string | undefined>;
}

export class StallTraceCapture extends Context.Reference<StallTraceCaptureService>(
  "t3/observability/StallTraceCapture",
  {
    defaultValue: () => ({
      attribute: () => ({
        activeSpans: [],
        slowSpans: [],
      }),
      saveSnapshot: () => Effect.undefined,
    }),
  },
) {}

const extractEndTimeNs = (line: string): bigint | undefined => {
  const match = END_TIME_NANO_PATTERN.exec(line);
  if (match?.[1] === undefined) return undefined;
  try {
    return BigInt(match[1]);
  } catch {
    return undefined;
  }
};

const isStallSnapshotName = (name: string) =>
  name.startsWith(STALL_SNAPSHOT_PREFIX) && name.endsWith(STALL_SNAPSHOT_SUFFIX);

/**
 * Tracks active and slow spans and preserves a bounded slice of `server.trace.ndjson`
 * whenever `EventLoopMonitor` records a stall, so stall traces survive fast rotation.
 */
export const make = Effect.fn("StallTraceCapture.make")(function* (options: {
  readonly tracer: Tracer.Tracer;
  readonly sink: Pick<TraceSink, "filePath" | "flush">;
  readonly snapshotDir: string;
  readonly maxSnapshotBytes?: number;
  readonly maxSnapshotFiles?: number;
  readonly minWindowMs?: number;
  readonly cooldownMs?: number;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const maxSnapshotBytes = options.maxSnapshotBytes ?? DEFAULT_MAX_SNAPSHOT_BYTES;
  const maxSnapshotFiles = options.maxSnapshotFiles ?? DEFAULT_MAX_SNAPSHOT_FILES;
  const minWindowMs = options.minWindowMs ?? DEFAULT_MIN_WINDOW_MS;
  const cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;

  const open = new Map<Tracer.Span, { readonly name: string; readonly startTimeNs: bigint }>();
  const recent: Array<RecentSpan> = [];
  const snapshotLock = yield* Semaphore.make(1);
  let lastSnapshotAtMs: number | undefined;

  const wrapped = Tracer.make({
    ...(options.tracer.context === undefined ? {} : { context: options.tracer.context }),
    span(spanOptions) {
      const span = options.tracer.span(spanOptions);
      open.set(span, { name: spanOptions.name, startTimeNs: spanOptions.startTime });
      const end = span.end.bind(span);
      span.end = (endTime, exit) => {
        open.delete(span);
        const durationMs = Number(endTime - spanOptions.startTime) / 1_000_000;
        if (durationMs >= NOTABLE_SPAN_MS) {
          recent.push({ name: spanOptions.name, durationMs, endTimeNs: endTime });
          if (recent.length > MAX_RECENT_SPANS) recent.shift();
        }
        end(endTime, exit);
      };
      return span;
    },
  });

  // Untraced: runs inside the stall snapshot path with tracing disabled.
  const writeSnapshot = Effect.fnUntraced(function* (
    detectedAt: DateTime.Utc,
    detectedAtMs: number,
    windowStartNs: bigint,
  ) {
    if (lastSnapshotAtMs !== undefined && detectedAtMs - lastSnapshotAtMs < cooldownMs) {
      return undefined;
    }
    yield* options.sink.flush.pipe(Effect.ignore);

    const kept: Array<{ readonly line: string; readonly bytes: number }> = [];
    let head = 0;
    let keptBytes = 0;

    const pushLine = (line: string) => {
      if (line.length === 0) return;
      const endTimeNs = extractEndTimeNs(line);
      if (endTimeNs === undefined || endTimeNs < windowStartNs) return;
      const bytes = Buffer.byteLength(line) + 1;
      if (bytes > maxSnapshotBytes) return;
      kept.push({ line, bytes });
      keptBytes += bytes;
      while (keptBytes > maxSnapshotBytes && head < kept.length) {
        keptBytes -= kept[head]!.bytes;
        head += 1;
      }
      if (head > 1024 && head * 2 >= kept.length) {
        kept.splice(0, head);
        head = 0;
      }
    };

    const sourceFiles = [`${options.sink.filePath}.1`, options.sink.filePath];
    for (const sourcePath of sourceFiles) {
      yield* fs.stream(sourcePath).pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.runForEachArray((lines) =>
          Effect.sync(() => {
            for (const line of lines) pushLine(line);
          }),
        ),
        Effect.ignore,
      );
    }

    const retained = head === 0 ? kept : kept.slice(head);
    if (retained.length === 0) return undefined;

    yield* fs.makeDirectory(options.snapshotDir, { recursive: true });
    const fileName = `${STALL_SNAPSHOT_PREFIX}${DateTime.formatIso(detectedAt).replaceAll(":", "-")}${STALL_SNAPSHOT_SUFFIX}`;
    const snapshotPath = path.join(options.snapshotDir, fileName);
    const pendingPath = `${snapshotPath}.tmp`;
    yield* fs.writeFileString(pendingPath, `${retained.map((entry) => entry.line).join("\n")}\n`);
    yield* fs
      .rename(pendingPath, snapshotPath)
      .pipe(Effect.tapError(() => fs.remove(pendingPath, { force: true }).pipe(Effect.ignore)));
    lastSnapshotAtMs = detectedAtMs;

    const entries = (yield* fs.readDirectory(options.snapshotDir))
      .filter(isStallSnapshotName)
      .toSorted();
    const excess = entries.length - maxSnapshotFiles;
    for (let index = 0; index < excess; index++) {
      yield* fs
        .remove(path.join(options.snapshotDir, entries[index]!), { force: true })
        .pipe(Effect.ignore);
    }

    return snapshotPath;
  });

  const windowStartNanos = ({ detectedAt, delayMaxMs, windowMs }: StallTraceCaptureInput) => {
    const detectedAtMs = DateTime.toEpochMillis(detectedAt);
    const detectedAtNs = BigInt(detectedAtMs) * 1_000_000n;
    const captureWindowMs = Math.max(windowMs, delayMaxMs + 30_000, minWindowMs);
    return {
      detectedAtMs,
      detectedAtNs,
      windowStartNs: detectedAtNs - BigInt(Math.round(captureWindowMs)) * 1_000_000n,
    };
  };

  const attribute: StallTraceCaptureService["attribute"] = (input) => {
    const { detectedAtNs, windowStartNs } = windowStartNanos(input);

    const activeSpans = [...open.values()]
      .filter(
        ({ startTimeNs }) =>
          detectedAtNs >= startTimeNs && detectedAtNs - startTimeNs <= ACTIVE_SPAN_MAX_AGE_NS,
      )
      .map(({ name, startTimeNs }) => ({
        name,
        elapsedMs: Number(detectedAtNs - startTimeNs) / 1_000_000,
      }))
      .toSorted((left, right) => right.elapsedMs - left.elapsedMs)
      .slice(0, REPORTED_SPANS)
      .map(({ name, elapsedMs }) => `${name} (${Math.round(elapsedMs)}ms)`);

    const slowSpans = recent
      .filter(({ endTimeNs }) => endTimeNs >= windowStartNs)
      .toSorted((left, right) => right.durationMs - left.durationMs)
      .slice(0, REPORTED_SPANS)
      .map(({ name, durationMs }) => `${name} (${Math.round(durationMs)}ms)`);

    return { activeSpans, slowSpans };
  };

  const saveSnapshot: StallTraceCaptureService["saveSnapshot"] = Effect.fnUntraced(function* (
    input: StallTraceCaptureInput,
  ) {
    const { detectedAtMs, windowStartNs } = windowStartNanos(input);
    return yield* snapshotLock
      .withPermits(1)(writeSnapshot(input.detectedAt, detectedAtMs, windowStartNs))
      .pipe(
        Effect.uninterruptible,
        Effect.withTracerEnabled(false),
        Effect.catch((cause) =>
          Effect.logWarning("Failed to preserve event-loop stall trace snapshot", {
            snapshotDir: options.snapshotDir,
            cause,
          }).pipe(Effect.as(undefined)),
        ),
      );
  });

  return {
    tracer: wrapped,
    service: { attribute, saveSnapshot } satisfies StallTraceCaptureService,
  };
});
