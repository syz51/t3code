// @effect-diagnostics nodeBuiltinImport:off - edits workflow files; needs no install.
// Fork-only: points upstream's workflows at runners the fork has. Run with
// `bun scripts/fork-ci-runners.ts` after each upstream sync; docs/operations/fork.md explains when.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

// The fork has no Blacksmith installation, so its jobs would queue until GitHub cancels them.
// GitHub-hosted runners are free for public repositories; they have no vCPU size in the label.
const hostedRunners: Record<string, { label: string; vcpus: number }> = {
  "ubuntu-2404": { label: "ubuntu-24.04", vcpus: 4 },
  "ubuntu-2404-arm": { label: "ubuntu-24.04-arm", vcpus: 4 },
  "macos-26": { label: "macos-26", vcpus: 3 },
  "windows-2025": { label: "windows-2025", vcpus: 4 },
};
// GitHub cancels a hosted job after six hours.
const maxTimeoutMinutes = 360;
// Mapped lines keep upstream's value in these comments, so a rerun after a sync rescales from it.
const mappedMarker = " # fork-mapped: ";
const scaledMarker = " # fork-scaled: ";

const labelLine = new RegExp(
  `^(\\s*(?:runs-on|runner):\\s*)(?:[\\w.-]+${mappedMarker})?(blacksmith-(\\d+)vcpu-([a-z0-9-]+))\\s*$`,
  "gm",
);
const timeoutLine = new RegExp(`^(\\s*timeout-minutes:\\s*)(.+?)(?:${scaledMarker}(.+))?$`, "gm");

const workflowDir = ".github/workflows";
const files = NodeFS.readdirSync(workflowDir)
  .filter((name) => /\.ya?ml$/.test(name))
  .map((name) => NodePath.join(workflowDir, name));
const jobsOf = (text: string) => text.split(/^(?= {2}[\w-]+:\s*(?:#.*)?$)/m);

// Upstream sizes each job's timeouts for its runner, so scale them by the vCPUs the job loses.
const slowdownOf = (file: string, job: string) => {
  let slowdown = 1;
  for (const [line, , , vcpus, os] of job.matchAll(labelLine)) {
    const runner = hostedRunners[os!];
    if (runner === undefined) throw new Error(`${file}: no GitHub-hosted runner for ${line}`);
    slowdown = Math.max(slowdown, Math.ceil(Number(vcpus) / runner.vcpus));
  }
  return slowdown;
};

// A reusable workflow runs on the `runner` its callers pass, so it takes their largest slowdown.
const callerSlowdowns = new Map<string, number>();
for (const file of files) {
  for (const job of jobsOf(NodeFS.readFileSync(file, "utf8"))) {
    const called = job.match(/^\s*uses:\s*\.\/(\.github\/workflows\/[\w.-]+)\s*$/m)?.[1];
    if (called === undefined) continue;
    callerSlowdowns.set(called, Math.max(callerSlowdowns.get(called) ?? 1, slowdownOf(file, job)));
  }
}

for (const file of files) {
  const text = NodeFS.readFileSync(file, "utf8");
  const mapped = jobsOf(text)
    .map((job) => {
      const slowdown = Math.max(slowdownOf(file, job), callerSlowdowns.get(file) ?? 1);
      return job
        .replace(labelLine, (_, prefix: string, label: string, _vcpus: string, os: string) => {
          return `${prefix}${hostedRunners[os]!.label}${mappedMarker}${label}`;
        })
        .replace(timeoutLine, (_, prefix: string, current: string, upstream?: string) => {
          const minutes = upstream ?? current;
          if (slowdown === 1) return `${prefix}${minutes}`;
          // Scales each number, so `${{ cond && 70 || 30 }}` scales both branches.
          const scaled = minutes.replace(/\b\d+\b/g, (value) =>
            String(Math.min(Number(value) * slowdown, maxTimeoutMinutes)),
          );
          return `${prefix}${scaled}${scaledMarker}${minutes}`;
        });
    })
    .join("");
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
