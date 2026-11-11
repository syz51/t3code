import * as Effect from "effect/Effect";

import type * as GitVcsDriver from "./GitVcsDriver.ts";

const CONVENTIONAL_DEFAULT_BRANCHES = ["main", "master"];

/**
 * The project's default branch as a worktree base: `remote/branch` when a
 * remote has one, else a local conventional branch. Untraced: each caller
 * wraps it in its own span.
 */
export const resolveDefaultBaseRef = Effect.fnUntraced(function* (
  git: Pick<
    GitVcsDriver.GitVcsDriver["Service"],
    "resolvePrimaryRemoteName" | "resolveDefaultBranchName" | "resolveCommit"
  >,
  cwd: string,
) {
  const refExists = (revision: string) =>
    git.resolveCommit({ cwd, revision }).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
  const remoteName = yield* git
    .resolvePrimaryRemoteName(cwd)
    .pipe(Effect.orElseSucceed(() => null));
  if (remoteName !== null) {
    const remoteDefault = yield* git
      .resolveDefaultBranchName(cwd, remoteName)
      .pipe(Effect.orElseSucceed(() => null));
    // Fetch does not update a recorded HEAD, so it can outlive the branch it names.
    for (const branch of remoteDefault === null
      ? CONVENTIONAL_DEFAULT_BRANCHES
      : [remoteDefault, ...CONVENTIONAL_DEFAULT_BRANCHES]) {
      // Launch resolves a bare name through a local branch's upstream, or else assumes `origin`.
      if (yield* refExists(`refs/remotes/${remoteName}/${branch}`)) {
        return `${remoteName}/${branch}`;
      }
    }
  }
  // Local-only repositories, or a remote with neither a usable HEAD nor a conventional branch.
  for (const branch of CONVENTIONAL_DEFAULT_BRANCHES) {
    if (yield* refExists(`refs/heads/${branch}`)) return branch;
  }
  return "main";
});
