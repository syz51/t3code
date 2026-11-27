// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect } from "vite-plus/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Option from "effect/Option";
import { afterAll, assert, describe, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as TestClock from "effect/testing/TestClock";

import {
  comparisonBase,
  defaultConcurrency,
  docReaderTests,
  formatTypecheckResult,
  gitLines,
  ignoredCheckInputs,
  runSteps,
  splitTests,
  type Step,
} from "./check-changed.ts";
import { decide, readWorkspace } from "../.github/scripts/ci-changes.cjs";

const GiB = 1024 ** 3;

describe("check:changed", () => {
  it("bounds the default concurrency by the scarcer of cores and available memory", () => {
    assert.strictEqual(defaultConcurrency(32, 128 * GiB), 16);
    assert.strictEqual(defaultConcurrency(32, 20 * GiB), 3);
    assert.strictEqual(defaultConcurrency(4, 15 * GiB), 2);
    assert.strictEqual(defaultConcurrency(4, 2 * GiB), 1);
    assert.strictEqual(defaultConcurrency(1, 64 * GiB), 1);
  });

  it("runs the server tests for the one guide they read and leaves other docs inert", () => {
    const packages = readWorkspace();
    assert.isTrue(
      decide(["docs/user/t3-connect-troubleshooting.md"], packages, false).outputs.test_server,
    );
    assert.deepStrictEqual(docReaderTests(["docs/user/t3-connect-troubleshooting.md"]), [
      "apps/server/src/cloud/ConnectReachability.test.ts",
    ]);
    assert.deepStrictEqual(decide(["docs/user/install.md"], packages, false).affected, []);
  });

  it.effect(
    "keeps weighted steps within the budget, in order, and serial steps one at a time",
    () =>
      Effect.gen(function* () {
        const startedAt: Record<string, number> = {};
        let active = 0;
        let maxActive = 0;
        let serialActive = 0;
        let maxSerial = 0;
        const step = (
          name: string,
          options: { weight?: number; serial?: boolean } = {},
        ): Step<never> => {
          const slots = Math.min(options.weight ?? 1, 3);
          return {
            name,
            ...options,
            run: Effect.gen(function* () {
              startedAt[name] = (yield* Clock.currentTimeMillis) / 1000;
              active += slots;
              maxActive = Math.max(maxActive, active);
              if (options.serial) maxSerial = Math.max(maxSerial, ++serialActive);
              yield* Effect.sleep("1 second");
              active -= slots;
              if (options.serial) serialActive--;
              return { ok: true, output: "" };
            }),
          };
        };
        const fiber = yield* runSteps(
          [
            step("light 1"),
            // Above the budget, so it holds every slot rather than never starting.
            step("heavy", { weight: 5 }),
            step("pair", { weight: 2 }),
            step("light 2"),
            step("test 1", { serial: true }),
            step("test 2", { serial: true }),
          ],
          { concurrency: 3, timeoutSeconds: 60 },
        ).pipe(Effect.forkChild);
        yield* TestClock.adjust("10 seconds");
        const results = yield* Fiber.join(fiber);

        assert.deepStrictEqual(
          results.map((result) => result.outcome),
          ["pass", "pass", "pass", "pass", "pass", "pass"],
        );
        assert.strictEqual(maxActive, 3);
        // Lighter steps queued behind the heavy one never start ahead of it.
        assert.deepStrictEqual(startedAt, {
          "light 1": 0,
          heavy: 1,
          pair: 2,
          "light 2": 2,
          "test 1": 3,
          "test 2": 4,
        });
        assert.strictEqual(maxSerial, 1);
      }),
  );

  it.effect("interrupts a step at its timeout and reports TIMEOUT, apart from FAIL", () =>
    Effect.gen(function* () {
      let interrupted = false;
      const fiber = yield* runSteps(
        [
          {
            name: "hangs",
            run: Effect.never.pipe(
              Effect.onInterrupt(() => Effect.sync(() => (interrupted = true))),
            ),
          },
          { name: "fails", run: Effect.succeed({ ok: false, output: "error" }) },
          { name: "passes", run: Effect.succeed({ ok: true, output: "" }) },
        ],
        { concurrency: 3, timeoutSeconds: 10 },
      ).pipe(Effect.forkChild);
      yield* TestClock.adjust("9 seconds");
      assert.isFalse(interrupted);
      yield* TestClock.adjust("1 second");
      const results = yield* Fiber.join(fiber);

      assert.isTrue(interrupted);
      assert.deepStrictEqual(
        results.map(({ name, outcome, time }) => [name, outcome, time]),
        [
          ["hangs", "TIMEOUT", "killed after 10s"],
          ["fails", "FAIL", "0.0s"],
          ["passes", "pass", "0.0s"],
        ],
      );
    }),
  );

  it("runs the .github/scripts node:test files with node --test, not vitest", () => {
    assert.deepStrictEqual(
      splitTests([
        "apps/server/src/ws.test.ts",
        ".github/scripts/ci-changes.test.cjs",
        ".github\\scripts\\thread-transfer-report.test.cjs",
        "scripts/check-changed.test.ts",
      ]),
      {
        vitestTests: ["apps/server/src/ws.test.ts", "scripts/check-changed.test.ts"],
        nodeTests: [
          ".github/scripts/ci-changes.test.cjs",
          ".github\\scripts\\thread-transfer-report.test.cjs",
        ],
      },
    );
  });

  it.effect("fails instead of returning an empty file list when git exits nonzero", () => {
    const spawner = (exitCode: number) =>
      ChildProcessSpawner.make(() =>
        Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(1),
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
            isRunning: Effect.succeed(false),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.encodeText(Stream.make(exitCode === 0 ? "a.ts\nb.ts\n" : "")),
            stderr: Stream.encodeText(
              Stream.make(exitCode === 0 ? "" : "fatal: index file corrupt"),
            ),
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          }),
        ),
      );
    return Effect.gen(function* () {
      const listed = yield* gitLines("/repo", ["ls-files"]).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner(0)),
      );
      assert.deepStrictEqual(listed, ["a.ts", "b.ts"]);
      const error = yield* gitLines("/repo", ["ls-files"]).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner(128)),
        Effect.flip,
      );
      assert.strictEqual(
        error,
        "check:changed: git ls-files exited with 128: fatal: index file corrupt",
      );
    });
  });

  it("opens the built desktop app only for startup, settlement, and sidebar changes", () => {
    const packages = readWorkspace();
    const launches = (file: string) => decide([file], packages, false).outputs.desktop_launch;
    for (const file of [
      "apps/server/src/orchestration-v2/ThreadSettlementService.ts",
      "apps/server/src/persistence/Migrations/054_ProjectionThreadsAutoSettleDisabledAt.ts",
      "apps/web/src/components/sidebar/SidebarThreadRow.tsx",
      "apps/desktop/src/backend/DesktopBackendManager.ts",
      "apps/desktop/src/electron/ElectronProtocol.ts",
      "packages/contracts/src/settings.ts",
      "scripts/fixtures/desktop-launch/statev2.sqlite",
    ]) {
      assert.isTrue(launches(file), file);
    }
    for (const file of [
      "apps/server/src/orchestration-v2/ThreadSettlementService.test.ts",
      "apps/web/src/components/chat/ChatView.tsx",
      "apps/desktop/src/updates/DesktopRemoteUpdates.ts",
      "packages/contracts/src/orchestration.ts",
    ]) {
      assert.isFalse(launches(file), file);
    }
    // A script-only change still builds the app it opens.
    assert.isTrue(decide(["scripts/smoke-desktop-app.ts"], packages, false).outputs.build);
  });

  it.each([
    "packages/shared/src/testing/longTempDir.ts",
    "packages/shared/src/testing/providerEnv.ts",
    "packages/shared/src/testing/gitEnv.ts",
    "packages/shared/src/testing/gitRepositoryEnv.ts",
  ])("tests every package when the shared test setup file %s changes", (file) => {
    assert.strictEqual(decide([file], readWorkspace(), false).outputs.test_packages, "");
  });

  it("reports killed typecheck workers with package names and concurrency guidance", () => {
    const output = [
      "\x1b[34m~/apps/server$ effect-tsgo tsrs --noEmit\x1b[0m",
      "\x1b[34m~/apps/web$ effect-tsgo tsrs --noEmit\x1b[0m",
      "",
      "\x1b[90m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m",
      "\x1b[97;1m    Vite+ Task Runner • Execution Summary\x1b[0m",
      "\x1b[90m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m",
      "",
      "\x1b[1mTask Details:\x1b[0m",
      "\x1b[90m────────────────────────────────────────────────\x1b[0m",
      "  \x1b[90m[1]\x1b[0m \x1b[97;1mt3#typecheck\x1b[0m: \x1b[34m~/apps/server$ effect-tsgo tsrs --noEmit\x1b[0m \x1b[31;1m✗\x1b[0m \x1b[31m(exit code: 137)\x1b[0m",
      "      \x1b[90m→ Cache miss: no previous cache entry found\x1b[0m",
      "  \x1b[90m·······················································\x1b[0m",
      "  \x1b[90m[2]\x1b[0m \x1b[97;1m@t3tools/web#typecheck\x1b[0m: \x1b[34m~/apps/web$ effect-tsgo tsrs --noEmit\x1b[0m \x1b[31;1m✗\x1b[0m \x1b[31m(exit code: 143)\x1b[0m",
      "      \x1b[90m→ Cache miss: no previous cache entry found\x1b[0m",
      "\x1b[90m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m",
    ].join("\n");

    const formatted = formatTypecheckResult(
      { ok: false, exitCode: 1, output },
      ["t3", "@t3tools/web"],
      6,
    );
    assert.isFalse(formatted.ok);
    expect(formatted.output).not.toContain("Vite+ Task Runner • Execution Summary");
    expect(formatted.output).toContain("t3#typecheck (exit 137, SIGKILL)");
    expect(formatted.output).toContain("@t3tools/web#typecheck (exit 143, SIGTERM)");
    expect(formatted.output).toContain("killed (likely out of memory)");
    expect(formatted.output).toContain("CHECK_CHANGED_CONCURRENCY=3");
    expect(formatted.output).toContain("--concurrency 3");
    expect(formatted.summaryNote).toContain("t3#typecheck");
    expect(formatted.summaryNote).toContain("killed (likely out of memory)");
    expect(formatted.summaryNote).toContain("CHECK_CHANGED_CONCURRENCY");
    expect(formatted.summaryNote).toContain("--concurrency");
  });

  it("preserves real type error diagnostics without blaming OOM for aborted siblings", () => {
    const output = [
      "~/apps/web$ effect-tsgo tsrs --noEmit",
      "src/app.tsx(12,5): error TS2322: Type 'number' is not assignable to type 'string'.",
      "~/apps/server$ effect-tsgo tsrs --noEmit",
      "",
      "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
      "    Vite+ Task Runner • Execution Summary",
      "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
      "Task Details:",
      "────────────────────────────────────────────────",
      "  [1] @t3tools/web#typecheck: ~/apps/web$ effect-tsgo tsrs --noEmit ✗ (exit code: 1)",
      "      → Cache miss: no previous cache entry found",
      "  ·······················································",
      "  [2] t3#typecheck: ~/apps/server$ effect-tsgo tsrs --noEmit ✗ (exit code: 137)",
      "      → Cache miss: no previous cache entry found",
      "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    ].join("\n");

    const formatted = formatTypecheckResult(
      { ok: false, exitCode: 1, output },
      ["@t3tools/web", "t3"],
      4,
    );
    assert.isFalse(formatted.ok);
    expect(formatted.output).toContain(
      "src/app.tsx(12,5): error TS2322: Type 'number' is not assignable to type 'string'.",
    );
    expect(formatted.output).toContain("Failed typecheck tasks: @t3tools/web#typecheck (exit 1)");
    expect(formatted.output).not.toContain("likely out of memory");
    assert.isUndefined(formatted.summaryNote);
  });

  it("strips the verbose Vite+ summary on a passing typecheck run", () => {
    const output = [
      "~/apps/web$ effect-tsgo tsrs --noEmit ◉ cache hit, replaying",
      "",
      "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
      "    Vite+ Task Runner • Execution Summary",
      "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
      "  [1] @t3tools/web#typecheck: ~/apps/web$ effect-tsgo tsrs --noEmit ✓",
      "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    ].join("\n");

    const formatted = formatTypecheckResult({ ok: true, exitCode: 0, output }, ["@t3tools/web"], 4);
    assert.isTrue(formatted.ok);
    assert.strictEqual(
      formatted.output,
      "~/apps/web$ effect-tsgo tsrs --noEmit ◉ cache hit, replaying",
    );
    assert.isUndefined(formatted.summaryNote);
  });

  it("reports outer vp kill signals even when no Vite+ summary was printed", () => {
    const formatted = formatTypecheckResult(
      { ok: false, signal: "SIGKILL", output: "" },
      ["@t3tools/web"],
      1,
    );
    assert.isFalse(formatted.ok);
    expect(formatted.output).toContain("@t3tools/web");
    expect(formatted.output).toContain("signal SIGKILL");
    expect(formatted.output).toContain("killed (likely out of memory)");
    expect(formatted.output).toContain("CHECK_CHANGED_CONCURRENCY");
    expect(formatted.output).toContain("--concurrency");
    expect(formatted.summaryNote).toContain("@t3tools/web");
  });
});

// Hooks export GIT_DIR and GIT_INDEX_FILE, and user config or the default
// ~/.config/git/ignore can ignore or sign fixture files.
// Git for Windows rejects the null device as a config path, so use an empty file.
const emptyConfigDir = NodeFS.mkdtempSync(
  NodePath.join(NodeOS.tmpdir(), "t3-check-changed-config-"),
);
const emptyConfig = NodePath.join(emptyConfigDir, "empty.gitconfig");
NodeFS.writeFileSync(emptyConfig, "");
afterAll(() => NodeFS.rmSync(emptyConfigDir, { recursive: true, force: true }));
const fixtureConfig = {
  "core.excludesFile": emptyConfig,
  "user.name": "Fixture",
  "user.email": "fixture@example.invalid",
};
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_"))),
  GIT_CONFIG_GLOBAL: emptyConfig,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_COUNT: String(Object.keys(fixtureConfig).length),
  ...Object.fromEntries(
    Object.entries(fixtureConfig).flatMap(([key, value], index) => [
      [`GIT_CONFIG_KEY_${index}`, key],
      [`GIT_CONFIG_VALUE_${index}`, value],
    ]),
  ),
};

// History A -> B -> C, with HEAD at C. Each remote's main, and fork where given, points at A or B.
function fixture(remotes: Record<string, "A" | "B">, forks: Record<string, "A" | "B"> = {}) {
  const root = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-check-changed-")),
  );
  const commits: Record<string, string> = {};
  try {
    const write = (file: string, content: string) => {
      const path = NodePath.join(root, file);
      NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
      NodeFS.writeFileSync(path, content);
    };
    const git = (...args: Array<string>) =>
      NodeChildProcess.execFileSync("git", args, { cwd: root, encoding: "utf8", env }).trim();
    git("init");
    for (const name of ["A", "B", "C"]) {
      write(`${name}.txt`, name);
      git("add", ".");
      git("commit", "-m", name);
      commits[name] = git("rev-parse", "HEAD");
    }
    for (const [remote, commit] of Object.entries(remotes)) {
      git("remote", "add", remote, NodePath.join(root, "missing"));
      git("update-ref", `refs/remotes/${remote}/main`, commits[commit]!);
    }
    for (const [remote, commit] of Object.entries(forks)) {
      git("update-ref", `refs/remotes/${remote}/fork`, commits[commit]!);
    }
  } catch (error) {
    NodeFS.rmSync(root, { recursive: true, force: true });
    throw error;
  }
  return {
    commits,
    root,
    [Symbol.dispose]() {
      NodeFS.rmSync(root, { recursive: true, force: true });
    },
  };
}

const inFixture = <A, E>(effect: Effect.Effect<A, E, ChildProcessSpawner.ChildProcessSpawner>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return yield* effect.pipe(
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make((command) => spawner.spawn(ChildProcess.setEnv(command, env))),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.runPromise);
const compare = (root: string, ref: Option.Option<string>) => inFixture(comparisonBase(root, ref));

it.each(["upstream", "team/upstream"])(
  "compares against %s/main when the fork's origin/main lags it",
  async (remote) => {
    using project = fixture({ origin: "A", [remote]: "B" });
    const result = await compare(project.root, Option.none());
    assert.strictEqual(result.base, project.commits.B);
    assert.strictEqual(result.ref, remote + "/main");
  },
);

it.each([
  {
    name: "a closer remote fork",
    mains: { origin: "A", upstream: "A" },
    fork: "B",
    ref: "origin/fork",
  },
  {
    name: "a remote main closer than the fork",
    mains: { origin: "A", upstream: "B" },
    fork: "A",
    ref: "upstream/main",
  },
  {
    name: "a remote main level with the fork",
    mains: { origin: "A", upstream: "B" },
    fork: "B",
    ref: "upstream/main",
  },
] as const)("compares against $name", async ({ mains, fork, ref }) => {
  using project = fixture(mains, { origin: fork });
  const result = await compare(project.root, Option.none());
  assert.strictEqual(result.base, project.commits.B);
  assert.strictEqual(result.ref, ref);
});

it("compares against an explicit ref instead of the closest remote main", async () => {
  using project = fixture({ origin: "A", upstream: "B" });
  const result = await compare(project.root, Option.some("origin/main"));
  assert.strictEqual(result.base, project.commits.A);
  assert.strictEqual(result.ref, "origin/main");
});

it("lists the ignored inputs that main's pathspecs list, without entering node_modules", async () => {
  using project = fixture({});
  const git = (...args: Array<string>) =>
    NodeChildProcess.execFileSync("git", args, { cwd: project.root, encoding: "utf8", env });
  const write = (file: string, content = "") => {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(project.root, file)), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(project.root, file), content);
  };
  write(".gitignore", "node_modules/\ndist/\n.generated/\n.env*\n*.gen.d.ts\nreplaced/\nskipped/");
  for (const file of ["replaced", "skipped"]) write(file);
  git("add", ".");
  git("commit", "-m", "files that directories replace");
  git("update-index", "--skip-worktree", "skipped");
  for (const file of ["replaced", "skipped"]) NodeFS.rmSync(NodePath.join(project.root, file));
  for (const file of [
    ".env.local",
    "src/types.gen.d.ts",
    "src/.generated/routes.ts",
    "dist/index.d.ts",
    "dist/node_modules/pkg/index.d.ts",
    "node_modules/pkg/index.d.ts",
    // A package folder left behind by a branch switch.
    "old/dist/a.d.ts",
    "old/node_modules/pkg/index.d.ts",
    "replaced/sub/a.d.ts",
    "skipped/a.d.ts",
  ])
    write(file);
  const command =
    "ls-files -o -i --exclude-standard -- :(glob)**/.generated/** :(glob)**/.astro/** :(glob)**/*.d.ts :(glob)**/.env* :(exclude,glob)**/node_modules/**";
  const old = git(...command.split(" "))
    .split("\n")
    .filter(Boolean)
    .sort();
  assert.includeMembers(old, ["old/dist/a.d.ts", "replaced/sub/a.d.ts", "skipped/a.d.ts"]);
  assert.deepStrictEqual(await inFixture(ignoredCheckInputs(project.root)), old);
});

function launcherFixture() {
  const root = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3 checks & (fixture) ")),
  );
  const write = (file: string, content: string) => {
    const path = NodePath.join(root, file);
    NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
    NodeFS.writeFileSync(path, content);
  };
  for (const file of [
    "scripts/check-changed.ts",
    "scripts/check-changed-command.ts",
    ".github/scripts/ci-changes.cjs",
  ]) {
    write(file, NodeFS.readFileSync(NodePath.join(import.meta.dirname, "..", file), "utf8"));
  }
  write(".gitignore", "node_modules/\nrecords/\n");
  write(
    "package.json",
    JSON.stringify({
      type: "module",
      workspaces: ["packages/*"],
      scripts: {
        "knip:check:files": "knip --include files",
        "knip:check:exports": "knip --exports",
      },
    }),
  );
  write("packages/example/package.json", JSON.stringify({ name: "example" }));
  const source = "packages/example/space & (draft) %PATH% ! 研究.ts";
  write(source, "export const value = 1;\n");
  write(
    "node_modules/vite-plus/package.json",
    JSON.stringify({ type: "module", exports: { "./bin": "./cli.js" } }),
  );
  write(
    "node_modules/vite-plus/cli.js",
    `
    import fs from 'node:fs';
    import path from 'node:path';
    const args = process.argv.slice(2);
    fs.writeFileSync(path.join(process.env.RECORDS, process.pid + '.json'), JSON.stringify({ args, cwd: process.cwd() }));
    if (args[0] === 'run' && process.env.VP_RUN_STDOUT) {
      process.stdout.write(process.env.VP_RUN_STDOUT);
    } else {
      console.log('fixture stdout: ' + args[0]);
    }
    if (args[0] === 'run' && process.env.VP_RUN_STDERR) {
      process.stderr.write(process.env.VP_RUN_STDERR);
    } else {
      console.error('fixture stderr: ' + args[0]);
    }
    if (args[0] === 'run' && process.env.VP_RUN_SIGNAL) {
      process.kill(process.pid, process.env.VP_RUN_SIGNAL);
    }
    if (args[0] === 'run' && process.env.VP_RUN_EXIT) {
      process.exit(Number(process.env.VP_RUN_EXIT));
    }
    process.exit(args[0] === process.env.FAIL_STEP ? 23 : 0);
  `,
  );
  // Select the Windows launcher without changing the Effect runtime's host platform.
  write(
    "scripts/check-changed.ts",
    NodeFS.readFileSync(NodePath.join(import.meta.dirname, "check-changed.ts"), "utf8").replace(
      "vitePlusCommand(args, platform)",
      'vitePlusCommand(args, "win32")',
    ),
  );
  for (const name of ["effect", "@effect/platform-node", "@t3tools/shared"]) {
    const dest = NodePath.join(root, "node_modules", name);
    NodeFS.mkdirSync(NodePath.dirname(dest), { recursive: true });
    NodeFS.symlinkSync(
      NodeFS.realpathSync(NodePath.join(import.meta.dirname, "node_modules", name)),
      dest,
      "junction",
    );
  }
  const git = (...args: Array<string>) =>
    NodeChildProcess.execFileSync("git", args, { cwd: root, stdio: "pipe", env });
  git("init");
  git("add", ".");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "-c",
    "core.hooksPath=",
    "commit",
    "-m",
    "fixture",
  );
  const records = NodePath.join(root, "records");
  NodeFS.mkdirSync(records);
  return {
    root,
    source,
    write,
    run(failStep = "", extraEnv: Record<string, string> = {}) {
      return NodeChildProcess.spawnSync(process.execPath, ["scripts/check-changed.ts", "HEAD"], {
        cwd: root,
        encoding: "utf8",
        env: { ...env, TEMP: NodeOS.tmpdir(), RECORDS: records, FAIL_STEP: failStep, ...extraEnv },
      });
    },
    calls: (): Array<{ args: Array<string>; cwd: string }> =>
      NodeFS.readdirSync(records).map((file) =>
        JSON.parse(NodeFS.readFileSync(NodePath.join(records, file), "utf8")),
      ),
    [Symbol.dispose]() {
      NodeFS.rmSync(root, { recursive: true, force: true });
    },
  };
}

it("checks changed source paths through the Windows launcher", () => {
  using project = launcherFixture();
  project.write(project.source, "export const value = 2;\n");
  const result = project.run();
  expect(result.status, result.stdout + result.stderr).toBe(0);
  const calls = project.calls();
  expect(calls.find(({ args }) => args[0] === "lint")).toEqual({
    args: ["lint", "--no-error-on-unmatched-pattern", project.source],
    cwd: project.root,
  });
  expect(calls.some(({ args }) => args[0] === "fmt" && args.includes(project.source))).toBe(true);
  expect(calls.some(({ args }) => args[0] === "run" && args.includes("typecheck"))).toBe(true);
  expect(calls.some(({ args }) => args[0] === "install")).toBe(false);
  expect(result.stdout).toContain("fixture stdout: lint");
  expect(result.stdout).toContain("fixture stderr: lint");
});

it("lints an Astro component and runs knip when only it changed", () => {
  using project = launcherFixture();
  const page = "packages/example/Page.astro";
  project.write(page, "---\nconst title = 1;\n---\n<h1>{title}</h1>\n");
  const result = project.run();
  expect(result.status, result.stdout + result.stderr).toBe(0);
  const calls = project.calls();
  expect(calls.find(({ args }) => args[0] === "lint")?.args).toEqual([
    "lint",
    "--no-error-on-unmatched-pattern",
    page,
  ]);
  const commands = calls.map(({ args }) => args);
  expect(commands).toContainEqual(["exec", "knip", "--include", "files"]);
  expect(commands).toContainEqual(["exec", "knip", "--exports"]);
});

it.each(["install", "lint"])("reports a failing %s step with its output", (step) => {
  using project = launcherFixture();
  project.write(project.source, "export const value = 2;\n");
  project.write(
    "packages/example/package.json",
    JSON.stringify({ name: "example", version: "1.0.1" }),
  );
  const result = project.run(step);
  expect(result.status, result.stdout + result.stderr).toBe(1);
  const install = project.calls().find(({ args }) => args[0] === "install");
  expect(install?.args, result.stdout + result.stderr).toEqual([
    "install",
    "--lockfile-only",
    "--ignore-scripts",
  ]);
  expect(install?.cwd).not.toBe(project.root);
  expect(result.stdout + result.stderr).toContain(`fixture stdout: ${step}`);
  expect(result.stdout + result.stderr).toContain(`fixture stderr: ${step}`);
  expect(result.stdout).toContain(step === "install" ? "FAIL  unused patches" : "FAIL  lint");
  if (step === "lint") expect(result.stdout).toContain("pass  unused patches");
  expect(
    NodeFS.existsSync(NodePath.join(project.root, "node_modules/.cache/check-changed.json")),
  ).toBe(false);
});

it("reports a killed typecheck worker in check:changed output", () => {
  using project = launcherFixture();
  project.write(project.source, "export const value = 2;\n");
  const summary = [
    "~/packages/example$ effect-tsgo tsrs --noEmit",
    "",
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    "    Vite+ Task Runner • Execution Summary",
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    "Task Details:",
    "────────────────────────────────────────────────",
    "  [1] example#typecheck: ~/packages/example$ effect-tsgo tsrs --noEmit ✗ (exit code: 137)",
    "      → Cache miss: no previous cache entry found",
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    "",
  ].join("\n");
  const result = project.run("", {
    CHECK_CHANGED_CONCURRENCY: "4",
    VP_RUN_STDOUT: summary,
    VP_RUN_STDERR: " ",
    VP_RUN_EXIT: "1",
  });
  expect(result.status, result.stdout + result.stderr).toBe(1);
  const typecheckCall = project
    .calls()
    .find(({ args }) => args[0] === "run" && args.includes("typecheck"));
  expect(typecheckCall?.args).toContain("--verbose");
  expect(result.stdout).toContain("FAIL  typecheck (1 packages)");
  expect(result.stdout).toContain("example#typecheck (exit 137, SIGKILL)");
  expect(result.stdout).toContain("killed (likely out of memory)");
  expect(result.stdout).toContain("CHECK_CHANGED_CONCURRENCY");
  expect(result.stdout).toContain("--concurrency");
  expect(result.stdout).toContain("KILLED: typecheck worker killed (likely out of memory)");
  expect(
    NodeFS.existsSync(NodePath.join(project.root, "node_modules/.cache/check-changed.json")),
  ).toBe(false);
});

it("prints real typecheck diagnostics without an OOM warning", () => {
  using project = launcherFixture();
  project.write(project.source, "export const value = 2;\n");
  const summary = [
    "~/packages/example$ effect-tsgo tsrs --noEmit",
    "",
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    "    Vite+ Task Runner • Execution Summary",
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    "Task Details:",
    "────────────────────────────────────────────────",
    "  [1] example#typecheck: ~/packages/example$ effect-tsgo tsrs --noEmit ✗ (exit code: 1)",
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    "",
  ].join("\n");
  const result = project.run("", {
    VP_RUN_STDOUT: summary,
    VP_RUN_STDERR:
      "src/index.ts(1,1): error TS2322: Type 'number' is not assignable to 'string'.\n",
    VP_RUN_EXIT: "1",
  });
  expect(result.status, result.stdout + result.stderr).toBe(1);
  expect(result.stdout).toContain("error TS2322: Type 'number' is not assignable to 'string'.");
  expect(result.stdout).toContain("Failed typecheck tasks: example#typecheck (exit 1)");
  expect(result.stdout).not.toContain("likely out of memory");
});

it.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "reports a signal-killed typecheck process even when no summary was emitted",
  () => {
    using project = launcherFixture();
    project.write(project.source, "export const value = 2;\n");
    const result = project.run("", {
      CHECK_CHANGED_CONCURRENCY: "4",
      VP_RUN_STDOUT: " ",
      VP_RUN_STDERR: " ",
      VP_RUN_SIGNAL: "SIGKILL",
    });
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stdout).toContain("example");
    expect(result.stdout).toContain("signal SIGKILL");
    expect(result.stdout).toContain("killed (likely out of memory)");
    expect(result.stdout).toContain("CHECK_CHANGED_CONCURRENCY=2");
    expect(result.stdout).toContain("--concurrency 2");
  },
);
