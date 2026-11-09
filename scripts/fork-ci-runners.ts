// @effect-diagnostics nodeBuiltinImport:off - edits workflow files; needs no install.
// Fork-only: points upstream's workflows at runners the fork has. Run with
// `bun scripts/fork-ci-runners.ts` after each upstream sync; docs/operations/fork.md explains when.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

// The fork has no Blacksmith installation, so its jobs would queue until GitHub cancels them.
// GitHub-hosted runners are free for public repositories; they have no vCPU size in the label.
const hostedRunners: Record<string, string> = {
  "ubuntu-2404": "ubuntu-24.04",
  "ubuntu-2404-arm": "ubuntu-24.04-arm",
  "macos-26": "macos-26",
  "windows-2025": "windows-2025",
};

const workflowDir = ".github/workflows";
for (const name of NodeFS.readdirSync(workflowDir)) {
  if (!/\.ya?ml$/.test(name)) continue;
  const file = NodePath.join(workflowDir, name);
  const text = NodeFS.readFileSync(file, "utf8");
  const mapped = text.replace(
    /^(\s*(?:runs-on|runner):\s*)blacksmith-\d+vcpu-([a-z0-9-]+)/gm,
    (line, prefix: string, os: string) => {
      const runner = hostedRunners[os];
      if (runner === undefined) throw new Error(`${file}: no GitHub-hosted runner for ${line}`);
      return `${prefix}${runner}`;
    },
  );
  if (mapped !== text) NodeFS.writeFileSync(file, mapped);
}

// Fork PRs target `fork`, which lags upstream's `main` until the next sync.
const budgetFile = NodePath.join(workflowDir, "agent-context-budget.yml");
const budget = NodeFS.readFileSync(budgetFile, "utf8");
const upstreamFetch = "git fetch --quiet --depth=1 origin main\n";
const forkFetch = 'git fetch --quiet --depth=1 origin "$GITHUB_BASE_REF"\n';
if (budget.includes(upstreamFetch)) {
  NodeFS.writeFileSync(budgetFile, budget.replace(upstreamFetch, forkFetch));
} else if (!budget.includes(forkFetch)) {
  throw new Error(
    `${budgetFile}: upstream changed how it fetches main. Redo the base-branch edit.`,
  );
}

process.stdout.write("Workflows use GitHub-hosted runners. Review and commit the result.\n");
