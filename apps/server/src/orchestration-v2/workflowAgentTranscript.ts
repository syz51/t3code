// @effect-diagnostics nodeBuiltinImport:off
/** Workflow members appear only in transcripts, not provider events. */
import * as NodePath from "node:path";

import { OrchestrationWorkflowFileError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { field, text } from "./unknownField.ts";
import { readContainedWorkflowFile, type WorkflowFileIdentity } from "./workflowFileRead.ts";

const TRANSCRIPT_READ_BYTE_CAP = 512 * 1024;

const AGENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

const decodeJsonLine = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

export interface WorkflowAgentTranscriptCursor {
  readonly offset: number;
  readonly identity: WorkflowFileIdentity | null;
}

export const initialWorkflowAgentTranscriptCursor: WorkflowAgentTranscriptCursor = {
  offset: 0,
  identity: null,
};

export const WorkflowAgentTranscriptReadObserver = Context.Reference<
  (read: {
    readonly agentId: string;
    readonly startOffset: number;
    readonly endOffset: number;
    readonly lineCount: number;
  }) => Effect.Effect<void>
>("t3/orchestration/WorkflowAgentTranscriptReadObserver", {
  defaultValue: () => () => Effect.void,
});

/** Skip harness bookkeeping (attachment and isMeta user lines) and lines without uuids needed for idempotent projection. */
function parseWorkflowAgentTranscriptLines(contents: string): ReadonlyArray<unknown> {
  return contents.split("\n").flatMap((line) => {
    if (line.trim().length === 0) return [];
    const entry = Option.getOrUndefined(decodeJsonLine(line));
    const type = text(field(entry, "type"));
    if (type !== "assistant" && type !== "user") return [];
    if (field(entry, "isMeta") === true || text(field(entry, "uuid")) === undefined) return [];
    return [entry];
  });
}

/**
 * The directories that hold a transcript of this subagent. No provider event names the Claude
 * project directory of a session, so every project is checked; only a hit is worth a read.
 */
export const findSubagentTranscriptDirs = Effect.fn("orchestration.findSubagentTranscriptDirs")(
  function* (input: {
    readonly projectsDir: string;
    readonly nativeThreadId: string;
    readonly agentId: string;
  }) {
    if (!AGENT_ID_PATTERN.test(input.agentId)) return [];
    const fileSystem = yield* FileSystem.FileSystem;
    const projects = yield* fileSystem
      .readDirectory(input.projectsDir)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    return yield* Effect.filter(
      projects.map((project) =>
        NodePath.join(input.projectsDir, project, input.nativeThreadId, "subagents"),
      ),
      (transcriptDir) =>
        fileSystem
          .exists(NodePath.join(transcriptDir, `agent-${input.agentId}.jsonl`))
          .pipe(Effect.orElseSucceed(() => false)),
      { concurrency: 32 },
    );
  },
);

/** Reads the complete lines written since `cursor`, and the cursor after them. */
export const readWorkflowAgentTranscript = Effect.fn("orchestration.readWorkflowAgentTranscript")(
  function* (input: {
    readonly transcriptDir: string;
    readonly agentId: string;
    readonly cursor: WorkflowAgentTranscriptCursor;
    readonly configDir?: string;
  }) {
    if (!AGENT_ID_PATTERN.test(input.agentId)) {
      return yield* new OrchestrationWorkflowFileError({
        reason: "invalid-path",
        path: input.agentId,
      });
    }
    const file = yield* readContainedWorkflowFile({
      path: NodePath.join(input.transcriptDir, `agent-${input.agentId}.jsonl`),
      extension: ".jsonl",
      byteCap: TRANSCRIPT_READ_BYTE_CAP,
      fromOffset: input.cursor,
      ...(input.configDir === undefined ? {} : { configDir: input.configDir }),
    });
    const lines = parseWorkflowAgentTranscriptLines(file.contents);
    yield* (yield* WorkflowAgentTranscriptReadObserver)({
      agentId: input.agentId,
      startOffset: file.startOffset,
      endOffset: file.endOffset,
      lineCount: lines.length,
    });
    return {
      lines,
      cursor: { offset: file.endOffset, identity: file.identity },
      truncated: file.truncated,
    };
  },
);
