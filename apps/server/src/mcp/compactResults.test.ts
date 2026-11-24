import { expect, it } from "vite-plus/test";

import { compactToolResult } from "./compactResults.ts";

// Ids and texts as long as recorded results carry them.
const id = (prefix: string, length: number) => prefix.padEnd(length, "0");
const environmentId = id("environment-", 36);
const threadId = id("thread-", 36);
const runId = id("run:", 57);
const link = `[Review the release notes draft](t3-thread://v2/${environmentId}/${threadId})`;

const thread = {
  threadId,
  projectId: id("project-", 36),
  title: "Review the release notes draft",
  link,
  createdBy: "user",
  creationSource: "web",
  status: "completed",
  latestRunId: runId,
  activeRunId: null,
  providerInstanceId: "claudeAgent",
  model: "claude-opus-5-5",
  runtimeMode: "full-access",
  interactionMode: "default",
  linkedPullRequest: null,
  pullRequests: [],
  titleRegeneration: null,
  branch: null,
  worktreePath: null,
  parentThreadId: null,
  relationshipToParent: null,
  runCount: 1,
  itemCount: 5,
  pendingRequestCount: 0,
  archived: false,
  settled: false,
  settledAt: null,
  snoozed: false,
  snoozedUntil: null,
  createdAt: "2026-11-11T10:00:00.000Z",
  updatedAt: "2026-11-11T10:05:00.000Z",
};
const recentRuns = [
  {
    runId,
    ordinal: 1,
    status: "completed",
    providerInstanceId: "claudeAgent",
    model: "claude-opus-5-5",
    requestedAt: "2026-11-11T10:00:00.000Z",
    startedAt: "2026-11-11T10:00:01.000Z",
    completedAt: "2026-11-11T10:05:00.000Z",
  },
];
const item = (position: number, extra: Record<string, unknown> = {}) => ({
  position,
  visibility: "local",
  sourceThreadId: threadId,
  itemId: id(`item:${position}:`, 80),
  runId,
  messageId: id(`message:${position}:`, 78),
  createdBy: "agent",
  creationSource: "provider",
  type: "assistant_message",
  status: "completed",
  title: null,
  text: "The draft covers the three fixes. ".repeat(6),
  textTruncated: false,
  nextTextOffset: null,
  updatedAt: "2026-11-11T10:05:00.000Z",
  ...extra,
});
const read = (items: ReadonlyArray<unknown>) => ({
  thread,
  recentRuns,
  items,
  nextPosition: 5,
  hasMore: false,
});
const size = (value: unknown) => JSON.stringify(value).length;

it("halves a five-item read and keeps what the next call takes", () => {
  const whole = read([0, 1, 2, 3, 4].map((position) => item(position)));
  const compact = compactToolResult("t3_thread_read", { threadId }, whole);

  expect(size(compact)).toBeLessThanOrEqual(size(whole) / 2);
  expect(compact).toMatchObject({ link, status: "completed", nextPosition: 5, hasMore: false });
  expect(compact).not.toHaveProperty("thread");
  expect(compact).not.toHaveProperty("recentRuns");
  expect(Object(compact).items[0]).toEqual({
    position: 0,
    createdBy: "agent",
    creationSource: "provider",
    type: "assistant_message",
    status: "completed",
    text: item(0).text,
    updatedAt: "2026-11-11T10:05:00.000Z",
  });
});

it("returns the thread record and runs whole when asked", () => {
  const whole = read([item(0)]);
  expect(
    compactToolResult("t3_thread_read", { threadId, include: ["thread", "runs"] }, whole),
  ).toMatchObject({ thread, recentRuns, items: [{ runId }] });
});

it("keeps an item's id when a later read pages its text", () => {
  const cut = item(0, { textTruncated: true, nextTextOffset: 3500 });
  const inherited = item(1, { visibility: "inherited", sourceThreadId: "thread-parent" });
  const items = Object(
    compactToolResult("t3_thread_read", { threadId }, read([cut, inherited])),
  ).items;
  expect(items[0]).toMatchObject({
    itemId: cut.itemId,
    textTruncated: true,
    nextTextOffset: 3500,
  });
  expect(items[1]).toMatchObject({ visibility: "inherited", sourceThreadId: "thread-parent" });
  expect(items[1]).not.toHaveProperty("itemId");

  const named = compactToolResult(
    "t3_thread_read",
    { threadId, itemId: cut.itemId, textOffset: 3500 },
    read([item(0)]),
  );
  expect(Object(named).items[0].itemId).toBe(item(0).itemId);
});

const taskId = id("subagent:", 127);
const childThreadId = id("thread:subagent:", 129);
const childLink = `[Check the migration](t3-thread://v2/${environmentId}/${childThreadId})`;
const running = {
  taskId,
  childThreadId,
  link: childLink,
  childRunId: id("run:", 162),
  childNodeId: taskId,
  status: "running",
  workState: "working",
  hasPendingChildRuns: false,
  latestTerminalRunId: null,
  latestTerminalStatus: null,
  latestTerminalSummary: null,
  latestTerminalResultContextTransferId: null,
  providerInstanceId: "claudeAgent",
  model: "claude-opus-5-5",
  options: [
    { id: "effort", value: "high" },
    { id: "thinking", value: "on" },
  ],
  summary: null,
  resultContextTransferId: null,
  hasPendingQuestion: false,
  pendingApproval: null,
  waitTimedOut: false,
  next: "Its result arrives as a message. Do not poll; end your turn or do other work.",
};

it("acknowledges a delegated task in under 500 characters", () => {
  const ack = compactToolResult("delegate_task", {}, running);
  expect(size(ack)).toBeLessThan(500);
  expect(ack).toEqual({
    taskId,
    link: `<t3-thread://v2/${environmentId}/${childThreadId}>`,
    status: "running",
    workState: "working",
    next: running.next,
  });
});

it("keeps what a finished or remote task reports", () => {
  const { next: _next, ...settled } = running;
  const finished = {
    ...settled,
    status: "completed",
    workState: "result_available",
    summary: "The migration is safe.",
    hasPendingQuestion: true,
  };
  expect(compactToolResult("task_status", { taskId }, finished)).toEqual({
    taskId,
    link: childLink,
    status: "completed",
    workState: "result_available",
    providerInstanceId: "claudeAgent",
    model: "claude-opus-5-5",
    options: running.options,
    summary: "The migration is safe.",
    hasPendingQuestion: true,
  });

  // No link carries this id, so the only name the thread has stays.
  const { link: _link, ...unlinked } = running;
  expect(compactToolResult("delegate_task", {}, unlinked)).toMatchObject({ childThreadId });
});

it("leaves other tools' results whole", () => {
  expect(compactToolResult("t3_thread_launch", {}, { threadId, runId: null })).toBeUndefined();
});
