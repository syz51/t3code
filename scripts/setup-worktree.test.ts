// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { afterEach, describe, expect, it } from "vite-plus/test";

const scriptSource = NodePath.resolve(import.meta.dirname, "setup-worktree.ts");
const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeFakeBun(binDir: string): void {
  NodeFS.mkdirSync(binDir, { recursive: true });
  const scriptPath = NodePath.join(binDir, "bun");
  NodeFS.writeFileSync(
    scriptPath,
    '#!/bin/sh\nmkdir -p node_modules\necho "$*" > node_modules/.bun-args\n',
    { mode: 0o755 },
  );
}

function runGit(cwd: string, args: ReadonlyArray<string>): void {
  const result = NodeChildProcess.spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
}

function runSetupScript(
  worktree: string,
  binDir: string,
  envOverrides: Record<string, string | undefined>,
) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${binDir}${NodePath.delimiter}${process.env.PATH ?? ""}`,
    ...envOverrides,
  };
  if (envOverrides.T3CODE_PROJECT_ROOT === undefined) {
    delete env.T3CODE_PROJECT_ROOT;
  }
  return NodeChildProcess.spawnSync(
    process.execPath,
    [NodePath.join(worktree, "scripts", "setup-worktree.ts")],
    {
      cwd: worktree,
      env,
      encoding: "utf8",
    },
  );
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
});

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "scripts/setup-worktree.ts",
  () => {
    it("defaults T3CODE_PROJECT_ROOT to the main worktree when run by hand", () => {
      const root = makeTempDir("t3-setup-worktree-");
      const mainRepo = NodePath.join(root, "main-repo");
      const linkedWorktree = NodePath.join(root, "linked-worktree");
      const binDir = NodePath.join(root, "bin");
      writeFakeBun(binDir);

      NodeFS.mkdirSync(NodePath.join(mainRepo, "scripts"), { recursive: true });
      NodeFS.copyFileSync(scriptSource, NodePath.join(mainRepo, "scripts", "setup-worktree.ts"));
      NodeFS.writeFileSync(NodePath.join(mainRepo, ".env"), "SECRET=1\n");

      runGit(mainRepo, ["init", "-b", "main"]);
      runGit(mainRepo, ["config", "user.name", "Test User"]);
      runGit(mainRepo, ["config", "user.email", "test@example.com"]);
      runGit(mainRepo, ["add", "scripts/setup-worktree.ts"]);
      runGit(mainRepo, ["commit", "-m", "initial"]);
      runGit(mainRepo, ["worktree", "add", "-b", "feature", linkedWorktree]);

      const result = runSetupScript(linkedWorktree, binDir, { T3CODE_PROJECT_ROOT: undefined });
      expect(result.status).toBe(0);
      expect(NodeFS.existsSync(NodePath.join(linkedWorktree, ".t3", "setup-done"))).toBe(true);
      expect(NodeFS.existsSync(NodePath.join(linkedWorktree, ".t3", "setup-running"))).toBe(false);
      expect(
        NodeFS.readFileSync(
          NodePath.join(linkedWorktree, "node_modules", ".bun-args"),
          "utf8",
        ).trim(),
      ).toBe("install --frozen-lockfile");
      expect(NodeFS.lstatSync(NodePath.join(linkedWorktree, ".env")).isSymbolicLink()).toBe(true);
      expect(NodeFS.realpathSync(NodePath.join(linkedWorktree, ".env"))).toBe(
        NodeFS.realpathSync(NodePath.join(mainRepo, ".env")),
      );
    });

    it("prefers an explicit T3CODE_PROJECT_ROOT over git worktree discovery", () => {
      const root = makeTempDir("t3-setup-worktree-explicit-");
      const mainRepo = NodePath.join(root, "main-repo");
      const explicitRoot = NodePath.join(root, "explicit-root");
      const linkedWorktree = NodePath.join(root, "linked-worktree");
      const binDir = NodePath.join(root, "bin");
      writeFakeBun(binDir);

      NodeFS.mkdirSync(NodePath.join(mainRepo, "scripts"), { recursive: true });
      NodeFS.mkdirSync(explicitRoot, { recursive: true });
      NodeFS.copyFileSync(scriptSource, NodePath.join(mainRepo, "scripts", "setup-worktree.ts"));
      NodeFS.writeFileSync(NodePath.join(mainRepo, ".env"), "SOURCE=main\n");
      NodeFS.writeFileSync(NodePath.join(explicitRoot, ".env"), "SOURCE=explicit\n");

      runGit(mainRepo, ["init", "-b", "main"]);
      runGit(mainRepo, ["config", "user.name", "Test User"]);
      runGit(mainRepo, ["config", "user.email", "test@example.com"]);
      runGit(mainRepo, ["add", "scripts/setup-worktree.ts"]);
      runGit(mainRepo, ["commit", "-m", "initial"]);
      runGit(mainRepo, ["worktree", "add", "-b", "feature", linkedWorktree]);

      const result = runSetupScript(linkedWorktree, binDir, { T3CODE_PROJECT_ROOT: explicitRoot });
      expect(result.status).toBe(0);
      expect(NodeFS.realpathSync(NodePath.join(linkedWorktree, ".env"))).toBe(
        NodeFS.realpathSync(NodePath.join(explicitRoot, ".env")),
      );
    });

    it("throws when T3CODE_PROJECT_ROOT is unset outside a git worktree", () => {
      const root = makeTempDir("t3-setup-worktree-nogit-");
      const binDir = NodePath.join(root, "bin");
      writeFakeBun(binDir);

      NodeFS.mkdirSync(NodePath.join(root, "scripts"), { recursive: true });
      NodeFS.copyFileSync(scriptSource, NodePath.join(root, "scripts", "setup-worktree.ts"));

      const result = runSetupScript(root, binDir, { T3CODE_PROJECT_ROOT: undefined });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("T3CODE_PROJECT_ROOT is not set");
      expect(NodeFS.existsSync(NodePath.join(root, ".t3", "setup-failed"))).toBe(true);
    });

    it("ignores inherited GIT_DIR when discovering the main worktree", () => {
      const root = makeTempDir("t3-setup-worktree-gitdir-");
      const mainRepo = NodePath.join(root, "main-repo");
      const otherRepo = NodePath.join(root, "other-repo");
      const linkedWorktree = NodePath.join(root, "linked-worktree");
      const binDir = NodePath.join(root, "bin");
      writeFakeBun(binDir);

      NodeFS.mkdirSync(NodePath.join(mainRepo, "scripts"), { recursive: true });
      NodeFS.mkdirSync(otherRepo, { recursive: true });
      NodeFS.copyFileSync(scriptSource, NodePath.join(mainRepo, "scripts", "setup-worktree.ts"));
      NodeFS.writeFileSync(NodePath.join(mainRepo, ".env"), "REPO=main\n");
      NodeFS.writeFileSync(NodePath.join(otherRepo, ".env"), "REPO=other\n");

      runGit(mainRepo, ["init", "-b", "main"]);
      runGit(mainRepo, ["config", "user.name", "Test User"]);
      runGit(mainRepo, ["config", "user.email", "test@example.com"]);
      runGit(mainRepo, ["add", "scripts/setup-worktree.ts"]);
      runGit(mainRepo, ["commit", "-m", "initial"]);
      runGit(mainRepo, ["worktree", "add", "-b", "feature", linkedWorktree]);

      runGit(otherRepo, ["init", "-b", "main"]);
      runGit(otherRepo, ["config", "user.name", "Test User"]);
      runGit(otherRepo, ["config", "user.email", "test@example.com"]);
      NodeFS.writeFileSync(NodePath.join(otherRepo, "README.md"), "other\n");
      runGit(otherRepo, ["add", "README.md"]);
      runGit(otherRepo, ["commit", "-m", "other"]);

      const result = runSetupScript(linkedWorktree, binDir, {
        T3CODE_PROJECT_ROOT: undefined,
        GIT_DIR: NodePath.join(otherRepo, ".git"),
        GIT_WORK_TREE: otherRepo,
      });
      expect(result.status).toBe(0);
      expect(NodeFS.realpathSync(NodePath.join(linkedWorktree, ".env"))).toBe(
        NodeFS.realpathSync(NodePath.join(mainRepo, ".env")),
      );
    });

    it("skips env symlinking when run in the main checkout via a symlinked path", () => {
      const root = makeTempDir("t3-setup-worktree-main-");
      const mainRepo = NodePath.join(root, "main-repo");
      const symlinkedMain = NodePath.join(root, "main-link");
      const envTarget = NodePath.join(root, "shared.env");
      const binDir = NodePath.join(root, "bin");
      writeFakeBun(binDir);

      NodeFS.mkdirSync(NodePath.join(mainRepo, "scripts"), { recursive: true });
      NodeFS.copyFileSync(scriptSource, NodePath.join(mainRepo, "scripts", "setup-worktree.ts"));
      NodeFS.writeFileSync(envTarget, "SHARED=1\n");
      NodeFS.symlinkSync(envTarget, NodePath.join(mainRepo, ".env"));
      NodeFS.symlinkSync(mainRepo, symlinkedMain);

      runGit(mainRepo, ["init", "-b", "main"]);
      runGit(mainRepo, ["config", "user.name", "Test User"]);
      runGit(mainRepo, ["config", "user.email", "test@example.com"]);
      runGit(mainRepo, ["add", "scripts/setup-worktree.ts"]);
      runGit(mainRepo, ["commit", "-m", "initial"]);

      const result = runSetupScript(symlinkedMain, binDir, { T3CODE_PROJECT_ROOT: undefined });
      expect(result.status).toBe(0);
      expect(result.stderr).not.toContain("Skipping .env");
      expect(NodeFS.existsSync(NodePath.join(mainRepo, ".t3", "setup-done"))).toBe(true);
      expect(NodeFS.readlinkSync(NodePath.join(mainRepo, ".env"))).toBe(envTarget);
    });
  },
);
