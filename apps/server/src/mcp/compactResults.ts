/**
 * An agent pays for every character of a tool result, on every later turn.
 * These cut what it cannot use from the encoded results of the most-called
 * tools: null and false fields, and ids no tool takes as input.
 */
type Encoded = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is Encoded =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const present = (record: Encoded, dropped: ReadonlyArray<string> = []): Encoded =>
  Object.fromEntries(
    Object.entries(record).filter(
      ([key, value]) => value !== null && value !== undefined && !dropped.includes(key),
    ),
  );

const TASK_IDS_NO_TOOL_TAKES = [
  "childNodeId",
  "childRunId",
  "latestTerminalRunId",
  "resultContextTransferId",
  "latestTerminalResultContextTransferId",
];
const TASK_FLAGS = ["hasPendingChildRuns", "hasPendingQuestion", "waitTimedOut"];
const TASK_MODEL = ["providerInstanceId", "model", "executedModel", "options"];

const LABELED_LINK = /^\[.*\]\(<?([^<>]+?)>?\)$/s;

const compactDelegatedTask =
  (acknowledges: boolean) =>
  (_params: Encoded, result: Encoded): Encoded => {
    const dropped = [...TASK_IDS_NO_TOOL_TAKES, ...TASK_FLAGS.filter((flag) => !result[flag])];
    const { link, childThreadId, options } = result;
    // Thread tools take `link` as `threadId`, so the id it already carries is not repeated.
    if (
      typeof link === "string" &&
      typeof childThreadId === "string" &&
      link.includes(childThreadId)
    )
      dropped.push("childThreadId");
    if (Array.isArray(options) && options.length === 0) dropped.push("options");
    if (!acknowledges || result.next === undefined) return present(result, dropped);
    // The acknowledgement of a task that still runs says only how to follow it. Its caller
    // chose the title, and a bare link shows the thread's current one.
    return present(
      typeof link === "string" ? { ...result, link: link.replace(LABELED_LINK, "<$1>") } : result,
      [...dropped, ...TASK_MODEL],
    );
  };

const compactItem =
  (threadId: unknown, named: boolean, runs: boolean) =>
  (item: unknown): unknown => {
    if (!isRecord(item)) return item;
    const dropped = runs ? ["messageId"] : ["messageId", "runId"];
    // `itemId` only pages a cut-off text, with `nextTextOffset`.
    if (item.textTruncated !== true) dropped.push("textTruncated", ...(named ? [] : ["itemId"]));
    if (item.visibility === "local") dropped.push("visibility");
    if (item.sourceThreadId === threadId) dropped.push("sourceThreadId");
    return present(item, dropped);
  };

const compactThreadRead = (params: Encoded, result: Encoded): Encoded => {
  const { thread, recentRuns, items, ...paging } = result;
  if (!isRecord(thread) || !Array.isArray(items)) return result;
  const include: ReadonlyArray<unknown> = Array.isArray(params.include) ? params.include : [];
  const runs = include.includes("runs");
  return {
    // Asked for, the record and the runs come whole: the CLI prints them as they are.
    ...(include.includes("thread")
      ? { thread }
      : present({ link: thread.link, status: thread.status })),
    ...(runs ? { recentRuns } : {}),
    items: items.map(compactItem(thread.threadId, params.itemId != null, runs)),
    ...paging,
  };
};

const compactors: Readonly<Record<string, (params: Encoded, result: Encoded) => Encoded>> = {
  delegate_task: compactDelegatedTask(true),
  task_status: compactDelegatedTask(false),
  t3_thread_read: compactThreadRead,
};

/** The tool's encoded result as an agent gets it, or `undefined` for a tool whose result stays whole. */
export const compactToolResult = (
  tool: string,
  params: unknown,
  result: unknown,
): Encoded | undefined => {
  const compact = compactors[tool];
  return compact === undefined || !isRecord(result)
    ? undefined
    : compact(isRecord(params) ? params : {}, result);
};
