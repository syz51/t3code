import { assert, describe, it } from "@effect/vitest";
import type { OtlpTraceRecord, TraceRecord } from "@t3tools/shared/observability";
import * as Effect from "effect/Effect";

import * as BrowserTraceCollector from "./BrowserTraceCollector.ts";

const makeOtlpSpan = (overrides: Partial<OtlpTraceRecord>): OtlpTraceRecord => ({
  type: "otlp-span",
  name: "EnvironmentRegistry.getEntry",
  traceId: "trace-1",
  spanId: "aaaaaaaaaaaaaa01",
  sampled: true,
  kind: "internal",
  startTimeUnixNano: "1000000",
  endTimeUnixNano: "2000000",
  durationMs: 0.2,
  attributes: {},
  resourceAttributes: {},
  scope: { attributes: {} },
  events: [],
  links: [],
  status: { code: "0" },
  ...overrides,
});

describe("BrowserTraceCollector", () => {
  it.effect(
    "filters fast successful event-less browser OTLP spans when minSpanDurationMs is set",
    () =>
      Effect.gen(function* () {
        const recorded: Array<TraceRecord> = [];
        const collector = BrowserTraceCollector.make(
          {
            filePath: "unused",
            push: (record) => recorded.push(record),
            flush: Effect.void,
            flushSync: () => {},
            close: () => Effect.void,
          },
          { minSpanDurationMs: 10 },
        );

        yield* collector.record([
          makeOtlpSpan({ name: "fast-dropped", durationMs: 0.1 }),
          makeOtlpSpan({ name: "fast-sampled", spanId: "aaaaaaaaaaaaaa00", durationMs: 0.1 }),
          makeOtlpSpan({ name: "slow-kept", durationMs: 12 }),
          makeOtlpSpan({ name: "failed-kept", status: { code: "2", message: "boom" } }),
          makeOtlpSpan({
            name: "logged-kept",
            events: [{ name: "warn", timeUnixNano: "1000000", attributes: {} }],
          }),
        ]);

        assert.deepStrictEqual(
          recorded.map((record) => record.name),
          ["fast-sampled", "slow-kept", "failed-kept", "logged-kept"],
        );
      }),
  );
});
