import {
  EnvironmentId,
  type OrchestrationV2PendingBackgroundTask,
  ThreadId,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

const persisted = vi.hoisted(() => ({ title: "" }));
const openMenu = vi.hoisted(() => vi.fn());
vi.mock(import("../../state/session"), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironmentScope: () => true,
  readEnvironmentScope: () => true,
}));
vi.mock(import("../../state/use-orchestration-command"), async (importOriginal) => ({
  ...(await importOriginal()),
  useOrchestrationCommand: (() =>
    async ({ input }: { input: { title: string } }) => {
      persisted.title = input.title;
      return { _tag: "Success" };
    }) as never,
}));
vi.mock(import("~/hooks/useThreadActionMenu"), () => ({
  useThreadActionMenu: () => ({ openMenu, closeMenu: () => {}, readMenu: () => null }),
}));

import { render, stubGlobal } from "../../../test/render";
import { ChatHeader } from "./ChatHeader";

function header(
  title: string,
  options?: {
    readonly pendingBackgroundTasks?: ReadonlyArray<OrchestrationV2PendingBackgroundTask>;
    readonly onOpenThread?: (threadId: ThreadId) => void;
  },
) {
  return (
    <>
      <ChatHeader
        activeThreadEnvironmentId={EnvironmentId.make("environment")}
        activeThreadId={ThreadId.make("thread")}
        activeThreadTitle={title}
        pendingBackgroundTasks={options?.pendingBackgroundTasks}
        isServerThread
        activeProject={null}
        parentThreadLink={null}
        onOpenThread={options?.onOpenThread ?? (() => {})}
        rightPanelOpen={false}
        onNewThreadInProject={() => {}}
      />
      <div tabIndex={0}>Outside rename</div>
    </>
  );
}

it.each(["blur", "Enter"] as const)(
  "preserves a concurrent title update when an untouched rename ends with %s",
  async (finish) => {
    persisted.title = "New thread";
    await using screen = await render(header(persisted.title));
    await screen.getByRole("button", { name: "Thread actions for New thread" }).dblClick();
    const input = screen.getByRole("textbox", { name: "Thread title" });
    await expect.element(input).toHaveValue("New thread");

    persisted.title = "Fix login redirect";
    await screen.rerender(header(persisted.title));
    if (finish === "Enter") await userEvent.keyboard("{Enter}");
    else await screen.getByText("Outside rename").click();

    await expect.element(input).not.toBeInTheDocument();
    expect(persisted.title).toBe("Fix login redirect");

    await screen.rerender(header(persisted.title));
    await screen.getByRole("button", { name: "Thread actions for Fix login redirect" }).dblClick();
    await screen.getByRole("textbox", { name: "Thread title" }).fill("My edited title");
    persisted.title = "Another concurrent title";
    await screen.rerender(header(persisted.title));
    await userEvent.keyboard("{Enter}");
    await expect
      .element(screen.getByRole("textbox", { name: "Thread title" }))
      .not.toBeInTheDocument();
    expect(persisted.title).toBe("My edited title");
  },
);

it("opens the thread menu on a desktop title click without waiting", async () => {
  openMenu.mockClear();
  using _bridge = stubGlobal("desktopBridge", {});
  await using screen = await render(header("New thread"));
  await screen.getByRole("button", { name: "Thread actions for New thread" }).click();
  expect(openMenu).toHaveBeenCalledOnce();
});

it("keeps the Escape that cancels a rename from also reaching window shortcuts", async () => {
  persisted.title = "New thread";
  await using screen = await render(header(persisted.title));
  await screen.getByRole("button", { name: "Thread actions for New thread" }).dblClick();
  const input = screen.getByRole("textbox", { name: "Thread title" });
  await input.fill("Unsaved title");

  // The thread find bar closes from a window keydown listener that skips handled events.
  const windowEscapes: boolean[] = [];
  const recordEscape = (event: KeyboardEvent) => {
    if (event.key === "Escape") windowEscapes.push(event.defaultPrevented);
  };
  window.addEventListener("keydown", recordEscape);
  using _listener = {
    [Symbol.dispose]: () => window.removeEventListener("keydown", recordEscape),
  };
  await userEvent.keyboard("{Escape}");

  await expect.element(input).not.toBeInTheDocument();
  expect(persisted.title).toBe("New thread");
  expect(windowEscapes).toEqual([true]);
});

it("shows a waiting indicator in the header for a delegated child and opens it on click, then clears when done", async () => {
  const openThread = vi.fn();
  const childId = ThreadId.make("thread:child-1");
  const childTask: OrchestrationV2PendingBackgroundTask = {
    taskId: "subagent-1",
    kind: "subagent",
    description: "Investigate auth bug",
    childThreadId: childId,
  };
  await using screen = await render(
    header("Parent task", { pendingBackgroundTasks: [childTask], onOpenThread: openThread }),
  );
  const waitingButton = screen.getByTestId("chat-header-waiting");
  await expect.element(waitingButton).toBeVisible();
  await expect.element(waitingButton).toHaveTextContent("Waiting · Investigate auth bug");
  await waitingButton.click();
  expect(openThread).toHaveBeenCalledWith(childId);

  // Clears once the child task finishes.
  await screen.rerender(
    header("Parent task", { pendingBackgroundTasks: [], onOpenThread: openThread }),
  );
  await expect.element(screen.getByTestId("chat-header-waiting")).not.toBeInTheDocument();
});

it("opens a waiting popover in the header for multiple tasks and lets the user open each delegated child", async () => {
  const openThread = vi.fn();
  const childId = ThreadId.make("thread:child-2");
  const tasks: ReadonlyArray<OrchestrationV2PendingBackgroundTask> = [
    {
      taskId: "subagent-2",
      kind: "subagent",
      description: "Audit API routes",
      childThreadId: childId,
    },
    {
      taskId: "pull-request-watch:github.com/syz51/t3code#42",
      kind: "monitor",
      description: "Watching pull request #42",
      awaited: true,
    },
  ];
  await using screen = await render(
    header("Parent task", { pendingBackgroundTasks: tasks, onOpenThread: openThread }),
  );
  const waitingButton = screen.getByTestId("chat-header-waiting");
  await expect.element(waitingButton).toBeVisible();
  await waitingButton.click();
  await expect.element(page.getByText("Audit API routes")).toBeVisible();
  await expect.element(page.getByText("Watching pull request #42")).toBeVisible();

  // Transitioning to the single-child indicator clears popoverOpen so a later multi-task
  // transition does not mount the popover already open.
  await screen.rerender(
    header("Parent task", { pendingBackgroundTasks: [tasks[0]!], onOpenThread: openThread }),
  );
  await expect.element(page.getByText("Watching pull request #42")).not.toBeInTheDocument();
  await screen.rerender(
    header("Parent task", { pendingBackgroundTasks: tasks, onOpenThread: openThread }),
  );
  await expect.element(page.getByText("Watching pull request #42")).not.toBeInTheDocument();

  await waitingButton.click();
  await expect.element(page.getByText("Watching pull request #42")).toBeVisible();
  await page.getByRole("button", { name: "Open", exact: true }).click();
  expect(openThread).toHaveBeenCalledWith(childId);
});
