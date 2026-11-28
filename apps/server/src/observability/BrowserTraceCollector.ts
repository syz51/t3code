import {
  shouldRecordLocalTraceRecord,
  type TraceRecord,
  type TraceSink,
} from "@t3tools/shared/observability";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

interface BrowserTraceCollectorOptions {
  readonly minSpanDurationMs?: number;
}

export class BrowserTraceCollector extends Context.Service<
  BrowserTraceCollector,
  {
    readonly record: (records: ReadonlyArray<TraceRecord>) => Effect.Effect<void>;
  }
>()("t3/observability/BrowserTraceCollector") {}

/** @public */
export const make = (
  sink: TraceSink,
  options: BrowserTraceCollectorOptions = {},
): BrowserTraceCollector["Service"] => {
  const minSpanDurationMs = options.minSpanDurationMs ?? 0;
  return BrowserTraceCollector.of({
    record: Effect.fn("BrowserTraceCollector.record")(function (records) {
      return Effect.sync(() => {
        for (const record of records) {
          if (shouldRecordLocalTraceRecord(record, minSpanDurationMs)) {
            sink.push(record);
          }
        }
      });
    }),
  });
};

export const layer = (sink: TraceSink, options: BrowserTraceCollectorOptions = {}) =>
  Layer.succeed(BrowserTraceCollector, make(sink, options));
