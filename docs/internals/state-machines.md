# Implicit state machines

This page lists the state machines that the fork's code holds without a declared type or table.
An audit of the fork at commit `22b65998f3` wrote it (board task t3code-161, November 2026).
Use it before you change one of these machines: it shows where each transition is enforced and where it is not.

The page is a record of that audit, not a specification. A line number is correct for commit `22b65998f3` only.
The change that added this page also moved lines in `ClaudeAdapterV2.ts`, `CheckpointService.ts`, `workflowAgentTranscript.ts` and `GitVcsDriverCore.ts`.
Read a cited line of these files with `git show 22b65998f3:<path>`.
When you change a machine, correct its entry or delete it.

## How to read an entry

- **Owner** says who wrote the code: `upstream` (pingdotgg/t3code), `fork`, or both.
- **Stored in** names each place that holds the state. Two places can disagree.
- **Restart** says what the state is after the server, the app or the browser tab starts again.
- **Gaps** lists each place where the code does not enforce the machine. Each gap has an id such as `A-G3.2`.
  A point that belongs to no single machine has an id such as `A-P1`.
- **Tracked** names the task on the `t3code` work board that holds a confirmed gap.

Each gap carries one verdict:

- `confirmed`: a probe test or an existing test shows the wrong behaviour.
- `by design`: a comment, a document or a test shows that the behaviour is intended.
- `refuted`: a probe test or an existing test shows that the gap does not exist.
- `split`: the gap has two parts with different verdicts. The entry names each part.
- `no verdict of its own`: the point repeats a gap or records that a search found nothing. It names the gap where there is one.

Some verdicts say that one part is not verified: no probe was possible for that part in the audit.
Board task t3code-254 holds these parts, unless the entry names another task for the part.

## Evidence

A probe is a test that passes while it asserts the wrong behaviour. Probe files are not in the repository.
`<archive>/probes/<area>/` in an entry is a path in the audit archive; board task t3code-161 names its location.
`<repo>` is the root of this repository.
The areas name the probe directory of their own area as `PROBES/`, `$P`, `P/` or `<probes>`.
Each area starts with its evidence conventions: the short names and the test runs that its entries cite.

## Coverage

The audit did not read all code. These board tasks hold the code that it did not read:

| Area                                              | Task       |
| ------------------------------------------------- | ---------- |
| A, orchestration core                             | t3code-212 |
| B, provider sessions; other providers last        | t3code-213 |
| C, MCP tools, scheduled tasks, CLI                | t3code-214 |
| D, git, workspace, projects, pull requests        | t3code-219 |
| E, server shell, auth, relay, peers               | t3code-215 |
| F, web client and `packages/client-runtime`       | t3code-216 |
| G, desktop app and shared packages                | t3code-217 |
| `apps/mobile`, `apps/marketing`, unused providers | t3code-218 |

The audit found 107 machines in seven areas.

## Area A: Orchestration core (`apps/server/src/orchestration-v2`, persistence)

### Area A: evidence conventions

All paths are relative to the repository root, at HEAD `22b65998f3` (= `origin/fork`).
Short names used below:

- Probe directory = `<archive>/probes/A/`
- All test commands ran from `apps/server`.

Probes (both pass; each test asserts the behaviour that this report calls wrong or surprising):

- `AuditOutbox.probe.test.ts`: ran as `apps/server/src/orchestration-v2/AuditOutbox.probe.test.ts`, command `vp test run src/orchestration-v2/AuditOutbox.probe.test.ts`, result 4 tests passed, exit 0.
- `AuditReceipt.probe.test.ts`: ran as `apps/server/src/orchestration-v2/AuditReceipt.probe.test.ts`, command `vp test run src/orchestration-v2/AuditReceipt.probe.test.ts`, result 1 test passed, exit 0.

Existing test runs used as pins (all exit 0):

- Run 1: `vp test run src/orchestration-v2/FoundationPersistence.test.ts src/orchestration-v2/EffectWorker.test.ts` -> 2 files, 72 tests passed, exit 0.
- Run 2: `vp test run src/orchestration-v2/RestartContinuation.test.ts src/orchestration-v2/ThreadDeletion.test.ts src/orchestration-v2/ProjectionMaintenance.test.ts src/orchestration-v2/ProjectionRecovery.test.ts src/orchestration-v2/IdleCompaction.test.ts src/orchestration-v2/CheckpointCaptureService.test.ts src/orchestration-v2/ProviderRuntimeRecoveryService.regression.test.ts src/orchestration-v2/ProviderRuntimeRecoveryService.test.ts src/orchestration-v2/Orchestrator.receipt-race.test.ts` -> 9 files, 119 tests passed, exit 0.
- Run 3: `vp test run src/orchestration-v2/runtimeLayer.test.ts -t "persists rejected command receipts across retries"` -> 1 test passed, 158 skipped, exit 0.
- Run 4: `vp test run src/orchestration-v2/ContextHandoffBudget.test.ts src/orchestration-v2/AttachmentClaims.test.ts src/orchestration-v2/RunFinalizationService.test.ts` -> 3 files, 34 tests passed, exit 0.

Fork ownership in this area: `git diff --stat origin/main...origin/fork` shows fork changes only in `apps/server/src/orchestration-v2/Orchestrator.ts`, `apps/server/src/orchestration-v2/ProjectionMaintenance.ts`, `apps/server/src/orchestration-v2/RestartContinuation.ts`, `apps/server/src/persistence/DatabaseMaintenance.ts` and `apps/server/src/persistence/DatabaseStorage.ts`. All other files of the area are upstream code.

Second pass:

Scope: verdicts only for the gaps the second brief lists. No new area was read and no new machine was added.
All commands ran from `apps/server` at HEAD `22b65998f3`. Each probe ran beside the code in `apps/server/src/orchestration-v2/` and then moved to the probe directory `<archive>/probes/A/` (below: `PROBES/`). To run a probe again, copy it back to `apps/server/src/orchestration-v2/`.
Owner check: `git diff --stat origin/main...origin/fork` is empty for `AttachmentClaims.ts`, `attachmentStore.ts`, `ThreadDeletion.ts`, `EffectOutbox.ts`, `EffectWorker.ts`, `ResourceCleanupService.ts`, `IdleCompactionService.ts` and `CheckpointCaptureService.ts`. `git blame` plus `git merge-base --is-ancestor <commit> origin/main` gives upstream for every cited upstream line.

### A-M1. Outbox effect lifecycle

- Owner: upstream
- Stored in: SQLite table `orchestration_v2_effect_outbox` (columns `status`, `lease_owner`, `attempt_count`, `available_at`); wake signals in memory.
- States: `pending`, `running`, `succeeded`, `failed`, `cancelled`.
- Transitions:
  - (none) -> `pending`: enqueue in the command transaction. Enforced at `apps/server/src/orchestration-v2/EffectOutbox.ts:397` (`ON CONFLICT(effect_id) DO NOTHING` at `apps/server/src/orchestration-v2/EffectOutbox.ts:428`).
  - `pending` -> `running`: `claimNext` by one worker; an earlier unsettled effect of the same thread blocks later ones. Enforced at `apps/server/src/orchestration-v2/EffectOutbox.ts:549`.
  - `running` -> `succeeded`: `succeed`, only by the lease owner. Enforced at `apps/server/src/orchestration-v2/EffectOutbox.ts:610`.
  - `running` -> `pending` (retry with back-off, at most 5 attempts): `retry`. Enforced at `apps/server/src/orchestration-v2/EffectOutbox.ts:640`; attempt limit at `apps/server/src/orchestration-v2/EffectWorker.ts:706`.
  - `running` -> `failed`: `fail` on the last attempt. Enforced at `apps/server/src/orchestration-v2/EffectOutbox.ts:673`.
  - `pending` | `running` -> `cancelled`: `cancelUnsettled` in a command transaction (Stop cancels only `provider-turn.start` and `provider-turn.restart`, `apps/server/src/orchestration-v2/Orchestrator.ts:12726`). Enforced at `apps/server/src/orchestration-v2/EffectOutbox.ts:467`.
  - `running` -> `pending` (replay-safe types) or `cancelled` (process-bound types): only at process start. Enforced at `apps/server/src/orchestration-v2/EffectOutbox.ts:515`, called from `apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts:972`. Type lists at `apps/server/src/orchestration-v2/EffectOutbox.ts:135` and `apps/server/src/orchestration-v2/EffectOutbox.ts:148`.
  - `succeeded` | `cancelled` -> deleted after 7 days: `pruneSettled`. Enforced at `apps/server/src/orchestration-v2/EffectOutbox.ts:703` (filter at `apps/server/src/orchestration-v2/EffectOutbox.ts:713`). `failed` rows are never deleted.
- Restart: `pending` stays. `running` goes back to `pending` for replay-safe types and to `cancelled` for process-bound types. Settled states stay.
- Explicit or implicit: Explicit. One module owns the status column and each write checks the previous status and the lease owner.
- Gaps:
  - **A-G1.1** [state with no exit; wait without limit] A `running` effect has no lease expiry and no heartbeat. When its executor does not return, the effect stays `running` and every later effect of that thread stays `pending` until the server process restarts. Only `delegated-tasks.stop` has a time limit (`apps/server/src/orchestration-v2/EffectWorker.ts:637`, `apps/server/src/orchestration-v2/EffectWorker.ts:639`). The comment at `apps/server/src/orchestration-v2/EffectWorker.ts:635` states the same fact. **Verdict:** confirmed. Tracked: t3code-162.
    - Evidence: probe `AuditOutbox.probe.test.ts`, tests "G1.1 a running effect with a dead lease is never reclaimed and blocks its thread for any length of time" (after `TestClock.adjust("30 days")` a second worker claims nothing; the first effect is still `running`) and "G1.1 a worker whose executor never returns keeps the effect running and starves the thread" (real `EffectWorker`, executor `Effect.never`, after 7 days the later `provider-turn.start` is still `pending`; after `Fiber.interrupt` of the worker the claim is still `running`). Both pass while they assert the wrong behaviour. Existing pin: `apps/server/src/orchestration-v2/FoundationPersistence.test.ts:2646` "ignores deadlines blocked by a running effect on the same thread" (Run 1, exit 0).
    - Limit of the proof: the probe uses an executor that never returns. I did not prove that a real executor can hang. Checkpoint capture git calls have a driver timeout (Area D, `apps/server/src/vcs/GitVcsDriverCore.ts:979`). `runtime-request.respond` calls the provider session with no time limit in this area (`apps/server/src/orchestration-v2/RuntimeRequestService.ts:118`); the session side belongs to Area B.
    - Size (confirmed only): M. Effect on the user: one hung side effect makes the thread stop reacting (no next turn, Stop's interrupt effect waits too) until the server restarts.
  - **A-G1.2** [state with no exit] A second enqueue of an effect id that already settled is dropped without a signal. A `failed` row is never pruned, so its id is blocked for all time. **Verdict:** by design.
    - Evidence: probe `AuditOutbox.probe.test.ts`, test "G1.2 a second enqueue of a settled effect id is dropped without a signal" (passes; shows the drop). Intent: `docs/internals/overview.md:47` to `docs/internals/overview.md:53` (retries of a command are idempotent) and `apps/server/src/orchestration-v2/FoundationPersistence.test.ts:1782` "keeps one durable effect across command retries and executes it after recovery" and `apps/server/src/orchestration-v2/FoundationPersistence.test.ts:2717` "prunes settled effects past retention in batches and keeps the rest" (Run 1, exit 0). I found no real path that re-enqueues a settled id: restart continuation ids contain the run id (`apps/server/src/orchestration-v2/Orchestrator.ts:2963`, `apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts:845`, `apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts:1020`).

### A-M2. Command receipts and deduplication

- Owner: upstream
- Stored in: SQLite table `orchestration_command_receipts` (`command_id` primary key, `status`, `error`, `result_sequence`).
- States: no receipt, `accepted`, `rejected`.
- Transitions:
  - no receipt -> `accepted`: command commit; `insertIfAbsent` then `upsert` in the same transaction. Enforced at `apps/server/src/orchestration-v2/EventSink.ts:689` and `apps/server/src/persistence/OrchestrationCommandReceipts.ts:116`.
  - no receipt -> `rejected`: any decide-time error except the mode-limit and runtime-ceiling refusals. Enforced at `apps/server/src/orchestration-v2/Orchestrator.ts:14740` to `apps/server/src/orchestration-v2/Orchestrator.ts:14761` and `apps/server/src/orchestration-v2/EventSink.ts:767`.
  - `accepted` | `rejected` -> same state: a retry of the command id replays the stored result. Enforced at `apps/server/src/orchestration-v2/Orchestrator.ts:14636`.
  - There is no transition out of `accepted` or `rejected`. V2 receipts are never deleted (`apps/server/src/orchestration-v2/ProjectionMaintenance.ts:499`, `docs/internals/overview.md:70`).
- Restart: all states stay (durable).
- Explicit or implicit: Explicit for one command id; implicit where an internal retry loop reuses a fixed command id (G2.1).
- Gaps:
  - **A-G2.1** [state with no exit; lost information] One transient decide-time failure writes a permanent `rejected` receipt. Internal follow-up commands use fixed command ids (`apps/server/src/orchestration-v2/EffectWorker.ts:220`, `apps/server/src/orchestration-v2/EffectWorker.ts:280`, `apps/server/src/orchestration-v2/EffectWorker.ts:313`, `apps/server/src/orchestration-v2/EffectWorker.ts:450`, `apps/server/src/orchestration-v2/EffectWorker.ts:491`, `apps/server/src/orchestration-v2/RestartContinuation.ts:330`, `apps/server/src/orchestration-v2/IdleCompactionService.ts:112`). The outbox then retries the effect up to 5 times, and each retry fails with `OrchestratorCommandPreviouslyRejectedError`, so the retries cannot succeed and the effect ends `failed`. **Verdict:** confirmed. Tracked: t3code-163.
    - Evidence: probe `AuditReceipt.probe.test.ts`, test "G2.1 one transient decide-time failure makes a deterministic system command id fail for good". The adapter's `getCapabilities` fails once. The first `message.dispatch` with command id `command:steer-follow-up:effect:audit-receipt` fails. Four retries with the same id fail with `OrchestratorCommandPreviouslyRejectedError` although the provider answers again. The receipt row is `rejected`, no message is stored, and the same command with a new id is accepted at once. The probe passes while it asserts the wrong behaviour. The receipt rule alone is intended: `apps/server/src/orchestration-v2/runtimeLayer.test.ts:5848` "persists rejected command receipts across retries" (Run 3, exit 0), `docs/internals/glossary.md:28`. The defect is the combination with fixed internal ids and the outbox retry loop.
    - Limit of the proof: the probe injects the failure through the provider capability read. I did not measure how often a decide-time read fails in production.
    - Size (confirmed only): M. Effect on the user: after one short failure, a steered follow-up message, a mailbox acceptance, a restart continuation or an idle compaction is dropped for good, with only a log line.

### A-M3. Run lifecycle

- Owner: upstream (fork adds the rate-limit retry in M7)
- Stored in: SQLite projection table for runs (`status` column plus JSON payload, upsert at `apps/server/src/orchestration-v2/ProjectionStore.ts:2273`); events in `orchestration_events`. Enum at `packages/contracts/src/orchestrationV2.ts:614`.
- States: `preparing`, `queued`, `starting`, `running`, `waiting`, `completed`, `interrupted`, `failed`, `cancelled`, `rolled_back`.
- Transitions:
  - `queued` -> `starting`: `startNextQueuedRun` under the thread lock. Enforced at `apps/server/src/orchestration-v2/Orchestrator.ts:2102` (gate) inside the function that starts at `apps/server/src/orchestration-v2/Orchestrator.ts:2092`.
  - `queued` -> `failed`: start error. Enforced in `failQueuedRunStart`, `apps/server/src/orchestration-v2/Orchestrator.ts:1902`.
  - `preparing` | `starting` | `running` -> `interrupted`: Stop. Enforced at `apps/server/src/orchestration-v2/Orchestrator.ts:12581` (a `waiting` run is not interrupted; comment at `apps/server/src/orchestration-v2/Orchestrator.ts:765`).
  - `running` -> `waiting`: provider turn ended, checkpoint capture queued. Written at `apps/server/src/orchestration-v2/RunExecutionService.ts:732` (not read in full).
  - `waiting` -> `completed`: checkpoint capture commit. Written at `apps/server/src/orchestration-v2/CheckpointCaptureService.ts:133` (status at `apps/server/src/orchestration-v2/CheckpointCaptureService.ts:209`); the service refuses other source states at `apps/server/src/orchestration-v2/CheckpointCaptureService.ts:86`.
  - active -> `cancelled`: thread deletion (`apps/server/src/orchestration-v2/ThreadDeletion.ts:69` to `apps/server/src/orchestration-v2/ThreadDeletion.ts:82`) or restart reconciliation (`apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts:531`).
  - provider-driven writes: guarded per write by `writeIfRunCurrent`, `apps/server/src/orchestration-v2/EventSink.ts:500`.
  - projection write: not enforced. The run row is a whole-snapshot upsert; the store accepts any status over any status.
- Restart: `queued` stays `queued` with `queueHeld: true` (`apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts:429`). A `starting` run that never started returns to `queued`, held. A `waiting` run with a pending or running `checkpoint.capture` effect stays (`apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts:218`); other `waiting`, `running`, `starting`, `preparing` runs become `cancelled` (`apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts:531`). Pins: `apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.test.ts:362` "cancels a stale waiting run when no checkpoint capture can finish it", `apps/server/src/orchestration-v2/ProjectionRecovery.test.ts:140` (Run 2, exit 0).
- Explicit or implicit: Implicit. The enum is named, but no reducer or table owns the transitions; each writer checks its own preconditions and the projection takes the last write.
- Gaps:
  - **A-G3.1** [unguarded transition; two writers] The projection has no transition check. A plain `eventSink.write` of a stale run snapshot moves a `completed` run back to `running`. Safety depends on each writer using the thread lock or `writeIfRunCurrent`. **Verdict:** confirmed (at the store; I proved no faulty real writer). Tracked: t3code-164.
    - Evidence: probe `AuditOutbox.probe.test.ts`, test "G3.1 the projection takes a plain write that moves a finished run back to running and revives a deleted thread" (passes while it asserts the wrong behaviour). Guards that do exist are pinned by `apps/server/src/orchestration-v2/FoundationPersistence.test.ts:1987` and `apps/server/src/orchestration-v2/FoundationPersistence.test.ts:2088` (Run 1, exit 0). Upstream comments show the known hazard: `apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts:818`, `apps/server/src/orchestration-v2/ProjectionStore.ts:2281`.
    - Size (confirmed only): L (a single transition check for run status). Effect on the user: none proven today; a writer that commits a stale snapshot outside the lock would show a finished run as running again.
  - **A-G3.2** [two writers] Checkpoint capture reads the run (`apps/server/src/orchestration-v2/CheckpointCaptureService.ts:69`), runs git, then commits a snapshot built from that read (`apps/server/src/orchestration-v2/CheckpointCaptureService.ts:133`) without the thread lock. A thread deletion in between sets the run `cancelled`; the capture commit would then write `completed`. **Verdict:** confirmed. Tracked: t3code-164.
    - Evidence: `PROBES/AuditCaptureDelete.probe.test.ts`. Command: `vp test run src/orchestration-v2/AuditCaptureDelete.probe.test.ts`. Exit code 0 (1 passed). Test: "G3.2 a thread deletion that commits while checkpoint capture runs git is overwritten: the cancelled run becomes completed".
    - What the probe shows: the capture reads its context (`apps/server/src/orchestration-v2/CheckpointCaptureService.ts:69`). The thread deletion then commits and sets the run to `cancelled`. The capture then commits its older snapshot (`apps/server/src/orchestration-v2/CheckpointCaptureService.ts:133`, `status: "completed"` at `:209`). After that the thread is still deleted, but the run is `completed` with a checkpoint id and the root node is `completed`.
    - Limit of the proof: the probe commits the deletion with the real `planThreadDeletion` through `eventSink.commitCommand` from inside a mocked `CheckpointService.capture`. It does not go through `orchestrator.dispatch(thread.delete)`. That the thread lock does not serialize the two rests on `grep` (no `withLock` or `threadLock` in `CheckpointCaptureService.ts`, `EffectWorker.ts`, `RunFinalizationService.ts`). The existing pin `apps/server/src/orchestration-v2/CheckpointCaptureService.test.ts:678` covers only the case where the read already sees `cancelled`.
    - Owner: upstream. Size: S to M (check the run status and the thread deletion again at commit time, or take the thread lock).
    - Effect on the user: a run and a root node of a deleted thread go back from `cancelled` to `completed`, and a terminal `completed` run event fires for a deleted thread; the probe proves no harm outside the deleted thread.
    - First pass: Tried: code reading only (`grep` for `withLock` in `CheckpointCaptureService.ts`, `RunFinalizationService.ts`, `EffectWorker.ts` found none). I wrote no probe; the visible effect is on a deleted thread only.

### A-M4. Thread lifecycle flags

- Owner: upstream (fork changed `apps/server/src/orchestration-v2/Orchestrator.ts:4221` to `apps/server/src/orchestration-v2/Orchestrator.ts:4238`, pull request watch fields on archive and settle)
- Stored in: SQLite thread projection row (JSON payload, whole-snapshot upsert); fields `archivedAt`, `deletedAt`, `settledOverride`, `settledAt`, `unsettledAt`, `snoozedUntil`, `pinnedAt`.
- States: active, archived, settled (manual or automatic), snoozed, pinned, deleted (combinations of the fields).
- Transitions:
  - archive, unarchive, settle, unsettle, snooze, unsnooze, pin, unpin: one switch in `dispatchThreadMutation`, `apps/server/src/orchestration-v2/Orchestrator.ts:4213` to `apps/server/src/orchestration-v2/Orchestrator.ts:4310`, under the thread lock.
  - active -> settled by the sweep: `thread.auto-settle` rechecks `settledOverride` and `updatedAt` against the sweep snapshot. Enforced at `apps/server/src/orchestration-v2/Orchestrator.ts:14260`.
  - any -> deleted: `planThreadDeletion`, `apps/server/src/orchestration-v2/ThreadDeletion.ts:56`; cancels active runs, attempts, nodes and pending requests, queues session detach and cleanup effects (`apps/server/src/orchestration-v2/ThreadDeletion.ts:185` to `apps/server/src/orchestration-v2/ThreadDeletion.ts:238`). Side chats are deleted in the same plan (`apps/server/src/orchestration-v2/Orchestrator.ts:14327`).
  - deleted -> anything: no command. Not enforced at the projection (see G4.1).
- Restart: all fields are durable.
- Explicit or implicit: Implicit. The state is a set of nullable timestamps; one switch owns the user commands, but every `thread.*` event writes the whole thread row.
- Gaps:
  - **A-G4.1** [unguarded transition] Every `thread.*` event carries the whole thread row. A stale `thread.metadata-updated` snapshot written after `thread.deleted` clears `deletedAt`. **Verdict:** confirmed (at the store; I proved no faulty real writer). Tracked: t3code-164.
    - Evidence: same probe test as G3.1 (second half: thread `deletedAt` is null after the stale write). Deletion behaviour is pinned by `apps/server/src/orchestration-v2/ThreadDeletion.test.ts:137` and `apps/server/src/orchestration-v2/ThreadDeletion.test.ts:228` (Run 2, exit 0).
    - Size (confirmed only): L (same change as G3.1). Effect on the user: none proven today; a stale writer would make a deleted thread visible again.

### A-M5. Queued runs and the queue hold

- Owner: upstream
- Stored in: run projection (`status = queued`, `queuePosition`, `queueHeld`); the reaction that promotes the queue is a live in-memory stream.
- States: queued and free, queued and held, starting, failed, cancelled.
- Transitions:
  - free -> starting: `startNextQueuedRun` after a terminal `run.updated` event (`apps/server/src/orchestration-v2/Orchestrator.ts:15011` to `apps/server/src/orchestration-v2/Orchestrator.ts:15029`) or at startup (`resumeQueuedRuns`, `apps/server/src/orchestration-v2/Orchestrator.ts:3019`).
  - free -> held: worktree missing, provider disabled, previous run failed, restart (`apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts:429`).
  - held -> free: user action, or `releaseUnattendedHolds` for messages no person reviews (`apps/server/src/orchestration-v2/Orchestrator.ts:2975`).
  - queue promotion ignores events written by restart reconciliation (`apps/server/src/orchestration-v2/Orchestrator.ts:15065`).
- Restart: all queued runs become held; `resumeQueuedRuns` starts only what `canStartQueuedRun` allows. Pin: `apps/server/src/orchestration-v2/RestartContinuation.test.ts:903` "continues a cut run past queued follow-ups, which stay held" (Run 2, exit 0).
- Explicit or implicit: Implicit. The hold is a boolean on the run; the promotion is a side reaction to an event stream that starts at the latest sequence of this process (`apps/server/src/orchestration-v2/Orchestrator.ts:15057`).
- Gaps:
  - **A-G5.1** [state lost on a crash] The reaction to a terminal run (deliver delegated completion, release holds, start the next queued run) runs after the commit, from a stream in memory. Its failure is only logged (`apps/server/src/orchestration-v2/Orchestrator.ts:15031`, `apps/server/src/orchestration-v2/Orchestrator.ts:15046`). A crash between the commit and the reaction leaves the next run queued until a restart, where it is then held. **Verdict:** confirmed for the failed-reaction variant (both ids; P2 is the same code path). The crash variant is not a separate gap: see the limit. Tracked: t3code-226.
    - Evidence: `PROBES/AuditQueueReaction.probe.test.ts`. Command: `vp test run src/orchestration-v2/AuditQueueReaction.probe.test.ts`. Exit code 0 (1 passed). Test: "G5.1/P2 one failed run-update reaction leaves a free queued run queued for good while the same reaction starts the queue of another thread".
    - What the probe shows: two threads each have one finished run and one queued run that is not held. The reaction fails once for the first thread (`apps/server/src/orchestration-v2/Orchestrator.ts:15046`, "Failed to react to V2 run update"). The control thread's queued run starts. The first thread's queued run is still `queued` after 30 days on the `TestClock`.
    - Limit of the proof: the probe injects the failure in `projectionStore.getHeldQueuedRuns`. Typed errors inside `startNextQueuedRun` become a `failed` run (`apps/server/src/orchestration-v2/Orchestrator.ts:2920` to `:2923`) and are not this gap. After a restart all queued runs are held (`apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts:429` to `:441`; pin `apps/server/src/orchestration-v2/RestartContinuation.test.ts:903`), so the crash variant equals the normal restart behaviour; I wrote no probe for it.
    - Owner: upstream. Size: M (retry the reaction, or a periodic pass that starts free queued runs of idle threads).
    - Effect on the user: after one transient error, a queued follow-up message stays queued with no active run until another run event on the thread or a server restart.
    - First pass: Tried: code reading of `apps/server/src/orchestration-v2/Orchestrator.ts:14990` to `apps/server/src/orchestration-v2/Orchestrator.ts:15077` and `apps/server/src/orchestration-v2/Orchestrator.ts:3019` to `apps/server/src/orchestration-v2/Orchestrator.ts:3049`. I wrote no probe, because a crash between two fibers needs a full-orchestrator harness that I did not build.

### A-M6. Runtime requests (questions and approvals)

- Owner: upstream
- Stored in: runtime request projection rows (`status`, `responseCapability`); enum at `packages/contracts/src/orchestrationV2.ts:1242`.
- States: `pending` (capability `live` or `message`), `resolved`, `expired`, `cancelled`; capability `not_resumable`.
- Transitions:
  - `pending` -> `resolved`: `runtime-request.respond`; only from `pending` (`apps/server/src/orchestration-v2/Orchestrator.ts:10159`), then a `runtime-request.respond` effect delivers the answer.
  - `resolved` -> delivered: the effect checks `status === "resolved"` and the live session (`apps/server/src/orchestration-v2/RuntimeRequestService.ts:90` to `apps/server/src/orchestration-v2/RuntimeRequestService.ts:117`).
  - delivery failed for good: the request stays `resolved`; an error item is added (`apps/server/src/orchestration-v2/Orchestrator.ts:10508`, command at `apps/server/src/orchestration-v2/EffectWorker.ts:450`).
  - `pending` -> `cancelled`: thread deletion (`apps/server/src/orchestration-v2/ThreadDeletion.ts:113`), shutdown reconciliation.
  - `pending` -> `expired`: startup reconciliation (`apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts:513`). There is no timer; a pending request waits for the user without limit.
- Restart: a pending question with a live capability becomes answerable by message and stays `pending`; other pending requests become `expired`. The `runtime-request.respond` effect is process-bound and is cancelled. Pins: `apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.test.ts:28` and `apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.test.ts:85` (Run 2, exit 0).
- Explicit or implicit: Mostly explicit. The orchestrator checks the source state for each command; the delivery step is a second, implicit phase after `resolved`.
- Gaps:
  - **A-G6.1** [one state in two places] The request is `resolved` before the provider gets the answer. After a failed delivery the request stays `resolved`. **Verdict:** by design.
    - Evidence: intent in the comment at `apps/server/src/orchestration-v2/Orchestrator.ts:10508` to `apps/server/src/orchestration-v2/Orchestrator.ts:10512`; pinned by `apps/server/src/orchestration-v2/EffectWorker.test.ts:292` "does not report an answer whose last delivery attempt is interrupted" (Run 1, exit 0).

### A-M7. Restart reconciliation and restart continuation (with the fork's rate-limit retry)

- Owner: both. Upstream: reconciliation and continuation. Fork: `retryContinuationStart` rate-limit branch (`apps/server/src/orchestration-v2/Orchestrator.ts:2927` to `apps/server/src/orchestration-v2/Orchestrator.ts:2971`), `restartContinuationRetryAt` (`apps/server/src/orchestration-v2/Orchestrator.ts:15433`), rate-limit handling in `apps/server/src/orchestration-v2/RestartContinuation.ts:206` to `apps/server/src/orchestration-v2/RestartContinuation.ts:221`.
- Stored in: run projection (`restartContinuationOfRunId`), outbox effect `effect:restart-continuation:<runId>` with `available_at`, message id `message:restart-continuation:<runId>` (`apps/server/src/orchestration-v2/RestartContinuation.ts:192`).
- States: run cut by restart; continuation effect pending; continuation message admitted (new run); continuation skipped; retry scheduled (effect pending with a future `available_at`); chain limit reached.
- Transitions:
  - cut -> effect pending: reconciliation at startup (`apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts:845`) or shutdown preparation (`apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts:1020`). The same effect id dedupes the two.
  - effect pending -> admitted: `continueRestartedRun` dispatches with command id `command:restart-continuation:<runId>` (`apps/server/src/orchestration-v2/RestartContinuation.ts:330`); skipped when the message exists (`apps/server/src/orchestration-v2/RestartContinuation.ts:202`), newer work ran (`apps/server/src/orchestration-v2/RestartContinuation.ts:236`), the chain is too long (`apps/server/src/orchestration-v2/RestartContinuation.ts:260`), or the user asked to stop the source run (`apps/server/src/orchestration-v2/RestartContinuation.ts:276`).
  - continuation run `failed` -> retry scheduled: only from the live run-update reaction (`apps/server/src/orchestration-v2/Orchestrator.ts:15000` to `apps/server/src/orchestration-v2/Orchestrator.ts:15009`).
- Restart: a pending continuation effect is replay-safe and stays. A scheduled retry stays. Pins: `apps/server/src/orchestration-v2/RestartContinuation.test.ts:151`, `apps/server/src/orchestration-v2/RestartContinuation.test.ts:433`, `apps/server/src/orchestration-v2/RestartContinuation.test.ts:1021`, `apps/server/src/orchestration-v2/RestartContinuation.test.ts:1066` (Run 2, exit 0); `apps/server/src/orchestration-v2/EffectWorker.test.ts:531` (Run 1, exit 0).
- Explicit or implicit: Implicit. The state is derived from run fields, a message id, an effect row and error turn items.
- Gaps:
  - G2.1 also applies here: a rejected receipt for `command:restart-continuation:<runId>` makes all 5 attempts of the effect fail.
  - **A-G7.1** [state lost on a crash] (fork) The retry of a rate-limited delegated run is scheduled only by the in-memory reaction. When the enqueue fails, the code logs a warning (`apps/server/src/orchestration-v2/Orchestrator.ts:15002`) and then reports the failure to the parent. A crash between the failed-run commit and the enqueue has the same result. The fallback is the upstream behaviour (the task is reported failed), not a hang. **Verdict:** confirmed for the crash variant. The failed-enqueue variant is not verified. Tracked: t3code-225.
    - Evidence: `PROBES/AuditRateLimitCrash.probe.test.ts`. Command: `vp test run src/orchestration-v2/AuditRateLimitCrash.probe.test.ts -t "G7.1"`. Exit code 0 (1 passed, 60 skipped). Test: "G7.1 a rate-limited delegated run whose failure commits without the live reaction gets no retry and the task is reported failed at startup recovery".
    - What the probe shows: the failed run and its rate-limit error item are in the store, and no `effect:restart-continuation:<run>` exists. `orchestrator.recoverDelegatedTasks` (the startup step, `apps/server/src/serverRuntimeStartup.ts:542`) then sets the task to `failed` with a rate-limit result. No retry is scheduled and no continuation run starts.
    - Limit of the proof: the probe models the lost reaction with a `command:runtime-reconcile:` command id, which the reaction stream filters out (`apps/server/src/orchestration-v2/Orchestrator.ts:15065`). It does not kill a process. The failed-enqueue variant (`logWarning` at `apps/server/src/orchestration-v2/Orchestrator.ts:15002` to `:15008`) was not injected; a probe for it needs an `EffectOutboxV2` wrapper that fails one `enqueue`.
    - Owner: fork (commit `1950d3e388`, PR #36; not an ancestor of `origin/main`). Size: S to M (enqueue the retry in the same commit as the failure, or derive it again in `recoverDelegatedTasks`).
    - Effect on the user: after a server stop in this window, the parent agent gets "failed on a rate limit" for a delegated task that the fork promises to retry; nothing hangs.
    - First pass: Tried: code reading; `grep` for rate-limit tests found only `apps/server/src/orchestration-v2/RestartContinuation.test.ts:1021` and `apps/server/src/orchestration-v2/RestartContinuation.test.ts:1066`, which cover the delay and the prompt, not this window. I wrote no probe.
  - **A-G7.2** [unguarded transition] (fork) Stop cancels only `provider-turn.start` and `provider-turn.restart` effects (`apps/server/src/orchestration-v2/Orchestrator.ts:12726`). A scheduled retry (`provider-runtime.continue`) stays pending. Whether a Stop during the back-off blocks the retry depends on a `run_interrupt_request` item on the failed run (`apps/server/src/orchestration-v2/RestartContinuation.ts:276`). **Verdict:** refuted.
    - Evidence: existing fork test `apps/server/src/orchestration-v2/DelegatedCompletionDelivery.test.ts:4485`, "retries a delegated run stopped by a rate limit, and fails it after the last retry". Command: `vp test run src/orchestration-v2/DelegatedCompletionDelivery.test.ts -t "retries a delegated run stopped by a rate limit, and fails it after the last retry"`. Exit code 0 (1 passed, 59 skipped).
    - What the test shows: lines 4696 to 4719 stop the child during a pending retry and then run the continuation. The task becomes `failed` with a rate-limit result and no continuation run starts.
    - Limit of the proof: the test stops through `cancelDelegatedTask` with a `thread.stop` on the child. A direct user `thread.stop` dispatch on the child was not probed. The parent-run marker path (`apps/server/src/orchestration-v2/RestartContinuation.ts:299` to `:306`) has its own pin, `apps/server/src/orchestration-v2/RestartContinuation.test.ts:1111`, which I did not run again in this pass.
    - Correction to the first pass: P5 said that no test covers Stop during the back-off. That is wrong; this test covers it. The first `grep` missed it because the title is on the line after `it.effect(`.
    - First pass: Tried: code reading of `apps/server/src/orchestration-v2/Orchestrator.ts:11896` (`markStoppedRun`) and `apps/server/src/orchestration-v2/RestartContinuation.ts:267` to `apps/server/src/orchestration-v2/RestartContinuation.ts:281`; I found no test of a Stop during the back-off and wrote no probe.

### A-M8. Projection maintenance marks (event pruning; fork: superseded updates and settled-thread compaction)

- Owner: both. Upstream: event prune mark. Fork: `SUPERSEDED_MARK`, `SUPERSEDED_THROUGH`, `TURN_ITEMS_COMPACTED_BEFORE` (`apps/server/src/orchestration-v2/ProjectionMaintenance.ts:50` to `apps/server/src/orchestration-v2/ProjectionMaintenance.ts:61`, `apps/server/src/orchestration-v2/ProjectionMaintenance.ts:272`, `apps/server/src/orchestration-v2/ProjectionMaintenance.ts:388`).
- Stored in: SQLite table `orchestration_v2_projection_metadata` (one row per mark: `last_sequence`, `updated_at`).
- States: no mark; mark set and waiting (1 day for events, 1 hour for superseded updates); mark due; pruned-through boundary published; compaction watermark (cutoff of the last pass).
- Transitions:
  - no mark -> mark set: first pass (`apps/server/src/orchestration-v2/ProjectionMaintenance.ts:535`, `apps/server/src/orchestration-v2/ProjectionMaintenance.ts:381`).
  - mark due -> boundary published -> rows deleted -> new mark: `apps/server/src/orchestration-v2/ProjectionMaintenance.ts:525` to `apps/server/src/orchestration-v2/ProjectionMaintenance.ts:535`; the boundary is written before the delete (`apps/server/src/orchestration-v2/ProjectionMaintenance.ts:531`).
  - settled thread untouched for 7 days -> turn items trimmed (one way): window `updated_at < cutoff AND updated_at >= previous watermark` (`apps/server/src/orchestration-v2/ProjectionMaintenance.ts:400`), recheck in the update (`apps/server/src/orchestration-v2/ProjectionMaintenance.ts:483`), watermark written last (`apps/server/src/orchestration-v2/ProjectionMaintenance.ts:493`).
- Restart: marks are durable. A pass that stops before the watermark write repeats its window.
- Explicit or implicit: Implicit. Each mark is a metadata row with its own meaning; no type names the phases.
- Gaps:
  - No gap proven. I checked the fork comment at `apps/server/src/orchestration-v2/ProjectionMaintenance.ts:397` ("Settling bumps updated_at"): `thread.settle` sets `updatedAt` to now unless the thread was already settled (`apps/server/src/orchestration-v2/Orchestrator.ts:4245`), and `thread.auto-settle` goes through the same code (`apps/server/src/orchestration-v2/Orchestrator.ts:14270`). Pins: `apps/server/src/orchestration-v2/ProjectionMaintenance.test.ts:250`, `apps/server/src/orchestration-v2/ProjectionMaintenance.test.ts:345`, `apps/server/src/orchestration-v2/ProjectionMaintenance.test.ts:436` (Run 2, exit 0). Intent for the one-way trim: `docs/operations/fork.md:161` to `docs/operations/fork.md:184` ("Removed output cannot be recovered").

### A-M9. Checkpoint lifecycle

- Owner: upstream
- Stored in: checkpoint projection rows (`status`), hidden git refs, run field `checkpointId`. Enum at `packages/contracts/src/orchestrationV2.ts:1438`.
- States: `ready`, `missing`, `error`, `stale`.
- Transitions:
  - (none) -> `ready` | `missing` | `error`: `capture`, `apps/server/src/orchestration-v2/CheckpointService.ts:367`; a failed git capture becomes `error` with a log line (`apps/server/src/orchestration-v2/CheckpointService.ts:419`); no repository becomes `missing` (`apps/server/src/orchestration-v2/CheckpointService.ts:393`).
  - capture is at-least-once: a settled run with a checkpoint returns early (`apps/server/src/orchestration-v2/CheckpointCaptureService.ts:74`); a rolled-back run returns early (`apps/server/src/orchestration-v2/CheckpointCaptureService.ts:82`).
  - `stale` and rollback: not read (see [Coverage](#coverage)).
- Restart: a `waiting` run keeps its replay-safe `checkpoint.capture` effect and finishes after restart (M3).
- Explicit or implicit: Implicit. The status is computed inside the capture function; rollback and `stale` are written elsewhere.
- Gaps:
  - No gap proven. See G3.2 for the unlocked commit. Pins: `apps/server/src/orchestration-v2/CheckpointCaptureService.test.ts:380` and `apps/server/src/orchestration-v2/CheckpointCaptureService.test.ts:678` (Run 2, exit 0).

### A-M10. Idle compaction timers

- Owner: upstream
- Stored in: memory only (`FiberMap` keyed by thread, `apps/server/src/orchestration-v2/IdleCompactionService.ts:133`); the dedupe is the command id `server:idle-compact:<threadId>:<runId>` (`apps/server/src/orchestration-v2/IdleCompactionService.ts:112`).
- States: no timer; waiting for the window start; dispatching `/compact`; done or skipped.
- Transitions:
  - run `completed` event -> timer started (replaces the thread's older timer): `apps/server/src/orchestration-v2/IdleCompactionService.ts:135` to `apps/server/src/orchestration-v2/IdleCompactionService.ts:139`.
  - waiting -> recheck -> dispatch or stop: loop at `apps/server/src/orchestration-v2/IdleCompactionService.ts:37` to `apps/server/src/orchestration-v2/IdleCompactionService.ts:123`; window rules in `apps/server/src/orchestration-v2/IdleCompaction.ts:32` to `apps/server/src/orchestration-v2/IdleCompaction.ts:105`.
  - any error -> skipped with a warning: `apps/server/src/orchestration-v2/IdleCompactionService.ts:127`.
- Restart: all timers are lost; compactions that were waiting do not happen.
- Explicit or implicit: Implicit. The state is the presence of a sleeping fiber.
- Gaps:
  - **A-G10.1** [state lost on restart] A restart drops waiting compactions. **Verdict:** by design.
    - Intent: `apps/server/src/orchestration-v2/IdleCompactionService.ts:22` to `:27`: "Timers live in memory, so a server restart skips compactions that were still waiting."
    - Evidence: `PROBES/AuditIdleCompactionRestart.probe.test.ts` (a copy of `apps/server/src/orchestration-v2/IdleCompaction.test.ts` plus two cases). Command: `vp test run src/orchestration-v2/AuditIdleCompactionRestart.probe.test.ts -t "G10.1"`. Exit code 0 (2 passed, 13 skipped). Tests: "G10.1 a restart while the timer waits skips the compaction" and "G10.1 control: with no restart the same timer sends the compaction".
    - What the probe shows: a completed run starts a timer that sleeps. When the service scope closes and a new service starts with no new event, 60 minutes pass with no thread read and no `/compact` dispatch. With no restart the same timer dispatches once.
    - Limit of the proof: the orchestrator, the projection store and the settings are mocks. The restart is a closed scope plus a new service instance whose event stream is empty; that the real stream is live only rests on a code reading (`apps/server/src/orchestration-v2/Orchestrator.ts:15641` to `:15644` starts after `latestSequence()`).
    - First pass: Tried: `apps/server/src/orchestration-v2/IdleCompaction.test.ts` (Run 2, exit 0) has no restart case; I wrote no probe.

### A-M11. Notification mailbox and steer delivery

- Owner: upstream
- Stored in: derived from message rows (`notification`, `delegatedCompletion`), run status and provider turn status; no own column.
- States: buffered provider notification; delivered as a steer; undelivered (run ended before the steer was taken); accepted.
- Transitions:
  - undelivered check: `isUndeliveredMailboxSteer`, `apps/server/src/orchestration-v2/NotificationMailbox.ts:23` to `apps/server/src/orchestration-v2/NotificationMailbox.ts:37`.
  - steer effect -> mailbox accepted command (`apps/server/src/orchestration-v2/EffectWorker.ts:280`) or follow-up message (`apps/server/src/orchestration-v2/EffectWorker.ts:313`).
- Restart: `provider-turn.steer` is process-bound and is cancelled at restart; delivery is at-least-once through reused message ids (`apps/server/src/orchestration-v2/NotificationMailbox.ts:22`).
- Explicit or implicit: Implicit. The state is computed from three record types on each read.
- Gaps:
  - G2.1 applies to both fixed command ids. No separate gap proven.

### A-M12. Context handoff and its delivery

- Owner: upstream
- Stored in: context handoff projection rows: `status` (`pending`, `ready`, `failed`, `superseded`, `packages/contracts/src/orchestrationV2.ts:1168`) and `delivery.status` (`pending`, `injected`, `inline`, `packages/contracts/src/orchestrationV2.ts:1182`) per native thread id.
- States: handoff ready; delivery intent written (`pending`); `injected`; `inline`; delivery uncertain.
- Transitions:
  - ready -> delivery `pending` -> `injected`: write intent, inject, write result (`apps/server/src/orchestration-v2/ContextHandoffDelivery.ts:123` to `apps/server/src/orchestration-v2/ContextHandoffDelivery.ts:130`).
  - ready -> `pending` -> `inline` after the provider takes the prompt (`apps/server/src/orchestration-v2/ContextHandoffDelivery.ts:140` to `apps/server/src/orchestration-v2/ContextHandoffDelivery.ts:144`); `unsent` restores the record.
  - delivery `pending` for the same native thread at the next try -> `ContextHandoffDeliveryUncertainError` (`apps/server/src/orchestration-v2/ContextHandoffDelivery.ts:114` to `apps/server/src/orchestration-v2/ContextHandoffDelivery.ts:122`).
- Restart: a crash between the intent and the result leaves `pending`; the next turn needs a new native thread (comment at `apps/server/src/orchestration-v2/ContextHandoffDelivery.ts:19`).
- Explicit or implicit: Explicit for delivery (a write-ahead intent with a check); the outer `status` field is written in several places that I did not read.
- Gaps:
  - No gap proven. Pin for the delivery phases: `apps/server/src/orchestration-v2/ContextHandoffBudget.test.ts:531` (Run 4, exit 0).

### A-M13. Attachment claims

- Owner: upstream
- Stored in: files in the attachments directory. The state is in the file name: `<name>.part` (partial upload), `pending-<uuid>` (uploaded, not sent), `<thread segment>-<uuid>` (claimed), plus `.txt` sidecars.
- States: partial, pending, claimed, removed.
- Transitions:
  - pending -> claimed: copy, not move (`apps/server/src/orchestration-v2/AttachmentClaims.ts:141`); the pending file stays for a retry.
  - claimed -> removed on a failed or refused dispatch: `releaseClaimedAttachments` (`apps/server/src/orchestration-v2/AttachmentClaims.ts:45`), called from `apps/server/src/orchestration-v2/ThreadMessageIntake.ts:53`, `apps/server/src/orchestration-v2/ThreadMessageIntake.ts:120`, `apps/server/src/orchestration-v2/ThreadMessageIntake.ts:151`.
  - pending -> removed after 24 hours, partial -> removed after 1 hour: `sweepStalePendingAttachments` (`apps/server/src/attachmentStore.ts:263`, ages at `apps/server/src/attachmentStore.ts:30` and `apps/server/src/attachmentStore.ts:31`).
  - claimed -> removed at thread deletion: `attachment.cleanup` effect (`apps/server/src/orchestration-v2/ThreadDeletion.ts:230`, `apps/server/src/orchestration-v2/ResourceCleanupService.ts:104`).
- Restart: files stay. The sweep handles only partial and pending files (`apps/server/src/attachmentStore.ts:281` to `apps/server/src/attachmentStore.ts:286`).
- Explicit or implicit: Implicit. The file name prefix is the state; no record lists the claims.
- Gaps:
  - **A-G13.1** [state lost on a crash] A crash after the claim copy and before the message commit leaves a claimed file that no message refers to; no sweep covers claimed files. **Verdict:** confirmed. Tracked: t3code-227.
    - Evidence: `PROBES/AuditAttachmentOrphan.probe.test.ts`. Command: `vp test run src/orchestration-v2/AuditAttachmentOrphan.probe.test.ts`. Exit code 0 (1 passed). Test: "G13.1 a claimed attachment whose message never committed survives the startup sweep and the thread's deletion plan".
    - What the probe shows: the real `claimPendingAttachments` copies the upload to `<thread>-<uuid>.png`. No message commits and no release runs. `sweepStalePendingAttachments` with a clock ten years later deletes the pending source (`deleted = 1`) and keeps the claimed copy. `getThreadAttachmentIds` returns `[]`, and the real `planThreadDeletion` plans no `attachment.cleanup` effect.
    - Limit of the proof: the crash is modelled by not running the rollback (`Effect.onError` in `apps/server/src/orchestration-v2/AttachmentClaims.ts`). That the startup sweep (`apps/server/src/config.ts:207`) is the only directory sweeper rests on `grep`.
    - Owner: upstream. Size: S (sweep claimed files that no message row names, or record the claim before the copy).
    - Effect on the user: one attachment file per such crash stays on disk for good; no data is lost and nothing shows in the client.
    - First pass: Tried: code reading; `apps/server/src/orchestration-v2/AttachmentClaims.test.ts:202` and `apps/server/src/orchestration-v2/AttachmentClaims.test.ts:248` (Run 4, exit 0) pin the rollback on interrupt, not a process crash. I wrote no probe.

### Area A: other points

- **A-P1** lost information: when the command that records a failed answer delivery fails, the worker only logs "Failed to record answer delivery failure", `apps/server/src/orchestration-v2/EffectWorker.ts:455`. The request then stays `resolved` with no error item. **Verdict:** confirmed. Tracked: t3code-228.
  - Evidence: `PROBES/AuditAnswerRecord.probe.test.ts` (a copy of `apps/server/src/orchestration-v2/EffectWorker.test.ts` plus one test). Command: `vp test run src/orchestration-v2/AuditAnswerRecord.probe.test.ts -t "P1 a failed record"`. Exit code 0 (1 passed, 12 skipped). Test: "P1 a failed record of an answer delivery failure is logged only: one record attempt, no error item, and the effect fails with the delivery error".
  - What the probe shows: the last delivery attempt fails and the `runtime-request.delivery.fail` dispatch fails too. The real executor dispatches that command once and nothing else. The effect fails with the delivery error only; the record failure reaches no caller (`apps/server/src/orchestration-v2/EffectWorker.ts:454` to `:459` logs it).
  - Limit of the proof: the probe runs the real `EffectWorker.layerExecutor` with mocked `RuntimeRequestService` and `ThreadManagementService`. It does not read the projection, so "the request stays `resolved` with no error item" follows from "no other command is dispatched", not from a read of the stored request. A recovery of that request at the next start was not checked.
  - Owner: upstream (`cd2b681e1a`, ancestor of `origin/main`). Size: S (retry the record, or fail the effect in a way that a later pass records).
  - Effect on the user: the timeline shows the answer as sent and no "Answer delivery not confirmed" item, although the provider did not get the answer; this is the state the comment at `apps/server/src/orchestration-v2/Orchestrator.ts:10510` says the item must prevent.
- **A-P2** lost information: failures of the run-update reaction are only logged, `apps/server/src/orchestration-v2/Orchestrator.ts:15002`, `apps/server/src/orchestration-v2/Orchestrator.ts:15031`, `apps/server/src/orchestration-v2/Orchestrator.ts:15046`, and `apps/server/src/orchestration-v2/Orchestrator.ts:3028` at startup. Nothing retries them before the next run event or restart. **Verdict:** confirmed for the failed-reaction variant (both ids; P2 is the same code path). The crash variant is not a separate gap: see the limit. Evidence: see A-G5.1. Tracked: t3code-226.
- **A-P3** wait without limit: `session.value.respondToRuntimeRequest` has no time limit in this area, `apps/server/src/orchestration-v2/RuntimeRequestService.ts:118`. With G1.1 a hang there blocks the thread. **Verdict:** confirmed for the outbox side by the G1.1 probe; no verdict for the session side (Area B). Tracked: t3code-162.
- **A-P4** wait without limit: `awaitRestartContinuation` waits for the continuation effect to settle with no limit, `apps/server/src/orchestration-v2/Orchestrator.ts:15445`. With G1.1 the waiter (Area C) waits as long as the thread is blocked. **Verdict:** refuted as a gap. The statement about the method is true, but its only caller bounds the wait.
  - Evidence 1: `PROBES/AuditAwaitContinuation.probe.test.ts`. Command: `vp test run src/orchestration-v2/AuditAwaitContinuation.probe.test.ts`. Exit code 0 (1 passed). Test: "P4 awaitRestartContinuation has no limit of its own: it waits 30 days on a continuation effect that stays running".
  - Evidence 2: `PROBES/AuditAwaitContinuationCaller.probe.test.ts` (a copy of `apps/server/src/orchestration-v2/ThreadManagementService.test.ts` plus one test). Command: `vp test run src/orchestration-v2/AuditAwaitContinuationCaller.probe.test.ts -t "P4 waitForThread ends"`. Exit code 0 (1 passed, 27 skipped). Test: "P4 waitForThread ends at its timeoutMs while awaitRestartContinuation never returns".
  - What the probes show: the bare method waits for 30 days on the `TestClock` while the effect is `running`, and returns when the effect settles. `waitForThread` with `timeoutMs: 60_000` is still waiting at 59 s and returns `timedOut: true` at 60 s (`Effect.timeoutOption` at `apps/server/src/orchestration-v2/ThreadManagementService.ts:1093`).
  - Limit of the proof: "only caller" rests on `grep` (`apps/server/src/orchestration-v2/ThreadManagementService.ts:1083` is the single call site outside tests). Which values callers pass as `timeoutMs` belongs to Area C and was not checked. Evidence 2 mocks the orchestrator.
- **A-P5** untested state (fork): no test covers a crash or a Stop between a rate-limited run's failure and its scheduled retry (G7.1, G7.2). Evidence: `grep -n -i -E` for `rate.limit|back.off|backs off` in the test titles of `apps/server/src/orchestration-v2/*.test.ts` returns only `apps/server/src/orchestration-v2/RestartContinuation.test.ts:959`, `:1021`, `:1066` and `apps/server/src/orchestration-v2/runtimeLayer.test.ts:5263`. **Verdict:** no verdict of its own; see the gap it names. Tracked: t3code-225.
- **A-P6** untested state: no test covers the outbox state `running` with a worker that never returns, other than the pin that later effects stay blocked (`apps/server/src/orchestration-v2/FoundationPersistence.test.ts:2646`). Evidence: G1.1 probe. **Verdict:** no verdict of its own; see the gap it names. Tracked: t3code-162.
- **A-P7** lost information: a `failed` outbox effect is terminal, is never retried and is never pruned (`apps/server/src/orchestration-v2/EffectOutbox.ts:713`; pin `apps/server/src/orchestration-v2/FoundationPersistence.test.ts:2717`, Run 1, exit 0). For cleanup effects of a deleted thread (`apps/server/src/orchestration-v2/ThreadDeletion.ts:212` to `apps/server/src/orchestration-v2/ThreadDeletion.ts:238`) this means the resource stays. **Verdict:** confirmed. Tracked: t3code-229.
  - Evidence: `PROBES/AuditCleanupFailed.probe.test.ts`. Command: `vp test run src/orchestration-v2/AuditCleanupFailed.probe.test.ts`. Exit code 0 (1 passed). Test: "P7 a deleted thread's cleanup effect that fails five times stays failed for good and its resource stays".
  - What the probe shows: the real `planThreadDeletion` effects go into the real outbox and the real worker runs them. `terminal.cleanup` fails on each attempt. After 5 attempts the effect is `failed`. After 30 days, a `pruneSettled`, a `reconcileAfterProcessLoss` and more worker passes, the attempt count is still 5 and the resource is still there. A second enqueue of the same effect id changes nothing. The control effect `attachment.cleanup` of the same deletion succeeds.
  - Limit of the proof: the executor is a stub that fails `terminal.cleanup` and tracks resources in a `Ref`; the real `ResourceCleanupService` did not run. Whether another path frees the real resource later (for example the end of the server process for a terminal) was not checked. The retention of `failed` rows is by design (first pass, pin `apps/server/src/orchestration-v2/FoundationPersistence.test.ts:2717`).
  - Owner: upstream. Size: S to M (retry failed cleanup effects of deleted threads at start, or sweep resources whose thread is deleted).
  - Effect on the user: when a cleanup of a deleted thread fails five times (about 1.5 s of back-off in total), its terminal, device claim, preview, scheduled tasks or attachment files stay with no further attempt.
  - First pass: by design for the retention (the test asserts that the failed row is kept); no verdict for the leaked resource (not probed).

## Area B: Provider sessions and the Claude adapter

### Area B: evidence conventions

Checked at HEAD `22b65998f3` (= `origin/fork`). `origin/main` is `95cb068c10`.

Conventions used below:

- Probe directory = `<archive>/probes/B/` (written `PROBES/` below).
- Every probe and test command ran from `apps/server`.
- A probe file is a copy of the existing test file with probe cases added. The harness helpers of the
  big test files are not exported, so a probe cannot import them. Each probe ran beside the code and
  then moved to `PROBES/`.
- Probe commands (all exit 0 unless stated):
  - B1, B1b, B2, B3, B4: `vp test run src/orchestration-v2/ProviderSessionManager.probe.test.ts -t "PROBE-B"`
    -> exit 0, "Tests 5 passed | 68 skipped (73)". File: `PROBES/ProviderSessionManager.probe.test.ts`. Log: `PROBES/run4.log`.
  - B5: `vp test run src/provider/resetCreditCoordinator.probe.test.ts` -> exit 0, "Tests 2 passed (2)".
    File: `PROBES/resetCreditCoordinator.probe.test.ts`. Log: `PROBES/run5.log`.
  - B6: `vp test run src/orchestration-v2/Adapters/ClaudeAdapterV2.probe.test.ts -t "PROBE-B6"` -> exit 0,
    "Tests 1 passed | 407 skipped (408)". File: `PROBES/ClaudeAdapterV2.b6.probe.test.ts` (case at line 12213). Log: `PROBES/run6.log`.
  - B7: `vp test run src/orchestration-v2/Adapters/ClaudeAdapterV2.probe.test.ts -t "PROBE-B7"` -> exit 0,
    "Tests 1 passed | 407 skipped (408)". File: `PROBES/ClaudeAdapterV2.b7.probe.test.ts` (case at line 14573). Log: `PROBES/run7.log`.
- Existing test files that I ran in full, all exit 0 (logs `PROBES/existing-*.log`):
  `src/orchestration-v2/ProviderSessionManager.test.ts` (68 passed),
  `src/orchestration-v2/ProviderRuntimeRecoveryService.test.ts` (18),
  `src/orchestration-v2/ProviderSessionTransitionPolicy.test.ts` (5),
  `src/orchestration-v2/ProviderSwitchService.test.ts` (8),
  `src/orchestration-v2/ProviderTurnControlService.test.ts` (1),
  `src/orchestration-v2/ProviderContinuationService.test.ts` (12),
  `src/orchestration-v2/ProviderCommitBatch.test.ts` (18),
  `src/orchestration-v2/UsageLimitRecoveryWorker.test.ts` (5),
  `src/provider/resetCreditCoordinator.test.ts` (5),
  `src/provider/claudeResetCredits.test.ts` (9),
  `src/provider/providerStatusCache.test.ts` (4),
  `src/provider/providerMaintenanceRunner.test.ts` (37),
  `src/provider/ProviderInstallationGate.test.ts` (1),
  `src/provider/ModelManifest.test.ts` (15),
  `src/provider/ProviderAuthService.test.ts` (21).
  From `src/orchestration-v2/Adapters/ClaudeAdapterV2.test.ts` I ran two cases only, with `-t`, each exit 0:
  "bounds an unacknowledged native Stop and settles its turn once" (line 12150) and
  "fails a turn whose Claude query ends before its first frame" (line 12645).

Second pass:

Date: 2026-11-14. HEAD `22b65998f3`. All commands ran from `apps/server`. Each probe ran beside the code and then moved to `PROBES/`. To run a probe again, copy it back to the path in its command.
New probe files in `PROBES/`:

- `AuditBStalledTurn.probe.test.ts` (copy of `src/orchestration-v2/BackgroundWorkStop.integration.test.ts` plus PROBE-B8, B9a, B9b, B14). Log: `run-B8-B9-B14.log`.
- `AuditBContinuation.probe.test.ts` (copy of `src/orchestration-v2/ProviderContinuationService.test.ts` plus PROBE-B10). Log: `run-B10.log`.
- `AuditBClaude.probe.test.ts` (copy of `src/orchestration-v2/Adapters/ClaudeAdapterV2.test.ts` plus PROBE-B11, B12, B13a, B13b). Log: `run-B11-B13.log`.
- `AuditBSessionManager.probe.test.ts` (first-pass `ProviderSessionManager.probe.test.ts` plus PROBE-B15, B15c). Log: `run-B15.log`.
- `AuditBTextDeltaCoalescer.probe.test.ts` (new file, PROBE-B16a to B16e). Log: `run-B16.log`.
- Logs of existing tests: `existing-BackgroundWorkStop-stalled.log`, `existing-Claude-second-pass.log`, `existing-ProviderContinuation-second-pass.log`.
  Order: the gaps that can harm a user most come first.

### B-M1. Provider session lifecycle (live entry in the session manager)

- Owner: both (upstream machine; the fork added the idle budget, `hasUndeliveredWake` and the probe-failure flag).
- Stored in: memory, `sessions` Ref of `LiveSessionEntry` (`apps/server/src/orchestration-v2/ProviderSessionManager.ts:269-292`, `apps/server/src/orchestration-v2/ProviderSessionManager.ts:494`). The projection keeps a copy: `providerSessions.status` (SQLite projection, area A owns the store).
- States: absent; opening; live and idle (idle timer armed); live and busy (`busyTurns` not empty); live, idle and pinned (background work or an undelivered child keeps it); releasing (scope close in progress); released (projection status `stopped` or `error`, `apps/server/src/orchestration-v2/ProviderSessionManager.ts:315-319`); released with the release record still unwritten (in-memory retry).
- Transitions:
  - absent -> opening -> live and idle: `open`. Enforced at `apps/server/src/orchestration-v2/ProviderSessionManager.ts:2784`.
  - idle -> busy: `markBusy` on turn start. Enforced at `apps/server/src/orchestration-v2/ProviderSessionManager.ts:1683`. A failed `markBusy` write is logged and treated as marked (`apps/server/src/orchestration-v2/ProviderSessionManager.ts:2300-2305`).
  - busy -> idle: `markIdle` when the event pump sees `turn.terminal`. Enforced at `apps/server/src/orchestration-v2/ProviderSessionManager.ts:1712`, called at `apps/server/src/orchestration-v2/ProviderSessionManager.ts:2625-2630`. A failed or stopped start clears its turn (`apps/server/src/orchestration-v2/ProviderSessionManager.ts:2285`).
  - idle -> pinned -> idle: `releaseIfStillIdle` probes the adapter; pending work re-arms the timer until `DEFAULT_MAX_IDLE_PIN_MS` (4 h). Enforced at `apps/server/src/orchestration-v2/ProviderSessionManager.ts:1288-1319`, constant at `apps/server/src/orchestration-v2/ProviderSessionManager.ts:67`.
  - idle -> releasing: idle timeout (`DEFAULT_IDLE_TIMEOUT_MS`, 30 min, `apps/server/src/orchestration-v2/ProviderSessionManager.ts:66`) through `releaseIfStillIdle` (`apps/server/src/orchestration-v2/ProviderSessionManager.ts:1271`), guarded by `busyTurns` and `idleGeneration` (`apps/server/src/orchestration-v2/ProviderSessionManager.ts:1279-1285`, `apps/server/src/orchestration-v2/ProviderSessionManager.ts:1338-1343`); or the idle budget (M3); or `close`, `closeInstance`, `releaseUnlessBusy`, `detach`, `release` (`apps/server/src/orchestration-v2/ProviderSessionManager.ts:2993`, `apps/server/src/orchestration-v2/ProviderSessionManager.ts:3003`, `apps/server/src/orchestration-v2/ProviderSessionManager.ts:3037`, `apps/server/src/orchestration-v2/ProviderSessionManager.ts:3071`, `apps/server/src/orchestration-v2/ProviderSessionManager.ts:3036`); or the provider event stream ends (`apps/server/src/orchestration-v2/ProviderSessionManager.ts:2714`); or server shutdown (`apps/server/src/orchestration-v2/ProviderSessionManager.ts:2757`).
  - releasing -> released: `releaseEntry` (`apps/server/src/orchestration-v2/ProviderSessionManager.ts:1135`) removes the entry (`apps/server/src/orchestration-v2/ProviderSessionManager.ts:1045`), closes the scope within `RELEASE_SCOPE_CLOSE_TIMEOUT_MS` (30 s, `apps/server/src/orchestration-v2/ProviderSessionManager.ts:72`, `apps/server/src/orchestration-v2/ProviderSessionManager.ts:1101`) and writes the release record.
  - released, record unwritten -> released: `retryReleaseRecords` repeats the write in memory (`apps/server/src/orchestration-v2/ProviderSessionManager.ts:995`).
  - interrupt request: bounded by `PROVIDER_INTERRUPT_TIMEOUT_MS` (15 s, `apps/server/src/orchestration-v2/ProviderSessionManager.ts:74`) in `decorateRuntime` (`apps/server/src/orchestration-v2/ProviderSessionManager.ts:2339`).
- Restart: every live entry is lost. At start, `ProviderRuntimeRecoveryService` sets each projected session that is not `stopped` or `error` to `stopped` (`apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts:794-814`), sets `active` provider threads to `idle` and clears `pendingBackgroundTasks` (`:760-793`). The Claude CLI process ends with the server (`backgroundTasksEndWithProcess: true`, `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts:13006`).
- Explicit or implicit: implicit. No type names the states; they follow from `busyTurns`, `idleGeneration`, `pinnedSinceMs`, the idle fiber and the map membership.
- Gaps:
  - **B-G1.1** [state with no exit] The busy state has no time limit in the session manager. A turn that started and never sends `turn.terminal` keeps the session live and busy until someone stops it or the provider stream ends. The retry-stall watch (M5) covers a provider API retry only. **Verdict:** confirmed (run-level part). Tracked: t3code-240.
    - Question: does a run-level limit or watchdog end a turn that never gets `turn.terminal`?
    - Answer: no. Nothing in `apps/server/src/orchestration-v2/` ends such a turn.
    - Evidence 1: PROBE-B8 "a run whose provider never sends turn.terminal is still running after 7 days" passes while it asserts the wrong behaviour. After `TestClock.adjust("7 days")`, a worker drain and `orchestrator.resumeQueuedRuns`, the run, the attempt, the provider turn and the root node are all `running`. The adapter received 0 interrupts. The session is still live. The turn was started 1 time.
      Command: `vp test run src/orchestration-v2/AuditBStalledTurn.probe.test.ts -t "PROBE-B" --reporter=verbose` -> exit 0 (4 passed, 12 skipped).
    - Evidence 2 (search): `grep -rnE "^(export )?const [A-Z_]+(_MS|_TIMEOUT|_DEADLINE|_INTERVAL)[A-Z_]* ="` over the non-test files of `src/orchestration-v2` (without `Adapters/`) lists no limit for a running turn. The nearest limits have other scopes: `ThreadSettlementService.ts:46-47` (a queued start, 2 minutes), `EffectWorker.ts:637` (stop of delegated tasks), `EffectWorker.ts:945` (liveness poll), `ProviderSessionManager.ts:81` (provider retry stall, 15 minutes), `ProviderSessionManager.ts:66` (idle sessions only). The word "watchdog" occurs only in a comment at `RestartBackgroundNote.ts:160`.
    - Limit of the proof: the probe uses the replay harness with a fake adapter, not the Claude adapter. The harness does not run the production-only workers of `runtimeLayer.ts:390-421` (for example `UsageLimitRecoveryWorker`, `ProviderRuntimeRecoveryService`); for those I have the search only. The adapters' own exits (a closed provider stream, the 15 minute retry stall watch, the Claude wake-turn deadline) are not part of the probe. They cover a CLI that exits or announces a retry, not a CLI that stays open and silent.
    - Owner: upstream (`origin/main` and `origin/fork` have the same orchestration base; `git diff origin/main...origin/fork` changes `ProviderSessionManager.ts` only in the idle budget).
    - Size: M.
    - Effect on the user: a thread whose CLI hangs without an end of turn shows as working until the user presses Stop, and an unattended or delegated run waits without end.
    - First pass: confirmed for the session manager. No verdict for the whole run path: a run-level watchdog, if one exists, is in area A and I did not read it. Evidence: PROBE-B4 "a turn with no terminal event keeps its session busy with no time limit" (`idleTimeoutMs` 1 s, `maxIdleSessions` 0, `TestClock.adjust("7 days")`; the session is still live and `closeCount` is 0). The probe passes while it asserts the unwanted behaviour. Size (confirmed only): M. Effect on the user: a thread whose CLI hangs without ending the turn shows as working, and holds a CLI process, until the user presses Stop; an unattended run waits forever.
  - **B-G1.2** [unguarded transition] A failed background-work probe has opposite meanings in two release paths. The idle timeout treats a failed probe as "no work" (`apps/server/src/orchestration-v2/ProviderSessionManager.ts:1289`, flag `false`) and releases the session, which kills its background work. The idle budget treats it as "work" (`apps/server/src/orchestration-v2/ProviderSessionManager.ts:1451`, flag `true`) and keeps the session. The adapter contract has no typed failure (`packages/provider-core/src/server/ProviderAdapter.ts:669`), so only a defect in the probe reaches this branch. No document or comment states which meaning is intended. **Verdict:** confirmed (the two paths disagree). Tracked: t3code-188.
    - Evidence: PROBE-B2 "idle release treats a failed background-work probe as no work" (probe dies; after 2 s the session is `stopped`, `closeCount` 1) and PROBE-B3 "the idle budget keeps a session whose background-work probe fails" (same probe; after 10 min both sessions live, `closeCount` 0). Both pass.
    - Size (confirmed only): S. Effect on the user: when the Claude adapter's pending-work check throws, a background command or subagent of an idle thread is killed at the 30 min idle timeout with no message.
  - **B-G1.3** [state lost on a crash or restart] All live-session state is in memory; a restart stops every session and cancels its process-bound background work. **Verdict:** by design.
    - Evidence: `apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.test.ts:135` ("preserves a replayable waiting run while cancelling its process-bound background work"), `:667` ("cancels the complete in-flight subtree and stops its persisted session without reopening it"), `:919` ("clears persisted pendingBackgroundTasks and terminalizes stale background items on settled runs"). Command: `vp test run src/orchestration-v2/ProviderRuntimeRecoveryService.test.ts`, exit 0.
  - **B-G1.4** [state lost on a crash or restart] A release record that failed to persist is retried only in memory. A crash during the retry leaves the projection saying the session is live until the start-up reconcile sets it to `stopped`. **Verdict:** by design.
    - Evidence: `apps/server/src/orchestration-v2/ProviderSessionManager.test.ts:3630` ("retries release records that failed to persist"); the reconcile is pinned by `ProviderRuntimeRecoveryService.test.ts:667`. Commands as above, exit 0.
  - **B-G1.5** [state with no exit] A provider that never answers an interrupt could block Stop. **Verdict:** refuted.
    - Evidence: `apps/server/src/orchestration-v2/ProviderSessionManager.test.ts:1661` ("gives up on a provider that never confirms a Stop"). Command: `vp test run src/orchestration-v2/ProviderSessionManager.test.ts`, exit 0. The manager bounds the call at 15 s (`apps/server/src/orchestration-v2/ProviderSessionManager.ts:74`, `apps/server/src/orchestration-v2/ProviderSessionManager.ts:2339`).
  - **B-G1.6** [two writers] A session could turn busy while the idle release checks pending work. **Verdict:** refuted.
    - Evidence: `apps/server/src/orchestration-v2/ProviderSessionManager.test.ts:3357` ("does not idle-release a session that turns busy during the pending-work check"), same command, exit 0. The guard is `onlyIfIdleGeneration` (`apps/server/src/orchestration-v2/ProviderSessionManager.ts:1342`).

### B-M2. Session transition policy and provider switch plan

- Owner: upstream.
- Stored in: no state of its own. Input is the thread projection (`thread.modelSelection`, `providerSessions`, `providerThreads`).
- States (decisions): reject; reuse; switch_model_in_session; restart_and_resume; create_with_handoff.
- Transitions:
  - any -> reject: target unavailable, or the adapter did not classify a selection change. Enforced at `apps/server/src/orchestration-v2/ProviderSessionTransitionPolicy.ts:37-39`, `:63-67`.
  - none -> create_with_handoff: no current session, or the continuation identity differs. Enforced at `:40-42`, `:46-51`.
  - same instance, selection changed: the adapter's plan decides. Enforced at `:59-62`, `:79-82`.
  - instance, runtime or workspace changed -> restart_and_resume. Enforced at `:73-75`.
  - else -> reuse. Enforced at `:87`.
  - The plan picks which sessions to release at `apps/server/src/orchestration-v2/ProviderSwitchService.ts:162-174`.
  - A model change for a running turn is best effort (`apps/server/src/orchestration-v2/ProviderTurnControlService.ts:203-222`; contract comment at `:74`).
- Restart: nothing to lose. The plan is computed again from the projection.
- Explicit or implicit: explicit. One pure function returns every decision and its test covers each branch.
- Gaps:
  - **B-G2.1** [one state kept in two places] The plan reads "live" from the projection status (`ProviderSwitchService.ts:51-53`), while the truth is the manager's memory. A dead session that the projection still calls live could be chosen. **Verdict:** refuted (for the part that had no verdict).
    - Claim: a crash between a release and its record leaves a dead session that the projection calls live; the switch plan could choose it.
    - Evidence: PROBE-B14 "a turn starts on a live session when the projection calls a dead session live" passes. The session is released (projected `error`), then a stale `provider-session.updated` event sets the row back to `ready` while the manager holds no such session. A new `message.dispatch` then starts a second turn (`turnStarts` 2). The plan reuses the same session id, the manager opens a new runtime under that id (`secondSessionLiveInMemory` true), and the new run is `running`.
      Command: `vp test run src/orchestration-v2/AuditBStalledTurn.probe.test.ts -t "PROBE-B" --reporter=verbose` -> exit 0.
    - Limit of the proof: the probe makes the stale row by a direct `EventSink.write`, and it uses a fake adapter. The start-up reconcile that sets such rows to `stopped` (`ProviderRuntimeRecoveryService.ts:794-814`) was not probed; a real process crash always passes through it. A plan that selects `switch_model_in_session` for the stale row was not probed, only `reuse`.
    - First pass: refuted for the cases the tests cover; no verdict for a crash between a release and its record (see G1.4). Evidence: `apps/server/src/orchestration-v2/ProviderSwitchService.test.ts:107`, `:136`, `:197`, `:255`; `apps/server/src/orchestration-v2/ProviderSessionTransitionPolicy.test.ts:66` ("preserves handoff and missing-classification outcomes across workspace changes"). Commands: `vp test run src/orchestration-v2/ProviderSwitchService.test.ts` and `vp test run src/orchestration-v2/ProviderSessionTransitionPolicy.test.ts`, both exit 0.

### B-M3. Idle-session budget trim

- Owner: fork (commits `68af7b3c78`, `c8c682e41d`, merge `d7ea240410`).
- Stored in: memory. `idleTrimRetryPending` flag, `lastActiveMs` and `idleGeneration` per entry.
- States: under budget; over budget and waiting for the 60 s grace; over budget with a retry scheduled; over budget with no retry scheduled (the defect state).
- Transitions:
  - trigger: `markIdle` (`apps/server/src/orchestration-v2/ProviderSessionManager.ts:1736`) and `open` (`apps/server/src/orchestration-v2/ProviderSessionManager.ts:2965`) fork a trim (`apps/server/src/orchestration-v2/ProviderSessionManager.ts:1475-1478`).
  - over budget -> release of the least recently active idle session: `apps/server/src/orchestration-v2/ProviderSessionManager.ts:1448-1462`. Sessions active in the last 60 s end the pass (`apps/server/src/orchestration-v2/ProviderSessionManager.ts:1449`, `IDLE_TRIM_GRACE_MS` at `apps/server/src/orchestration-v2/ProviderSessionManager.ts:71`).
  - session held by pending work or an undelivered child: skipped, the excess is not reduced (`apps/server/src/orchestration-v2/ProviderSessionManager.ts:1450-1454`).
  - session kept by `keepIf: hasUnfinishedRecords` or by a generation mismatch: `releaseEntry` returns without a release, but the excess is still reduced (`apps/server/src/orchestration-v2/ProviderSessionManager.ts:1456-1462`).
  - over budget -> retry in 60 s: only when `excess > 0` after the pass (`apps/server/src/orchestration-v2/ProviderSessionManager.ts:1465-1471`).
- Restart: nothing to keep. The budget is computed from the live map.
- Explicit or implicit: implicit. The "over budget" state is a local counter in one loop.
- Gaps:
  - **B-G3.1** [state with no exit] A session that the trim keeps (`keepIf`, or its generation changed) still counts as released (`apps/server/src/orchestration-v2/ProviderSessionManager.ts:1462`). A later releasable session then stays, and no 60 s retry is scheduled, because `excess` reached 0 (`apps/server/src/orchestration-v2/ProviderSessionManager.ts:1465`). The document says: "While the count stays over the budget, the check repeats each minute." (`docs/internals/performance-regressions.md:148`). **Verdict:** confirmed. Tracked: t3code-187.
    - Evidence: PROBE-B1 "trim counts a kept session as released and leaves the budget exceeded" (`maxIdleSessions` 1; session A has an unfinished background record, B and C are plain; after 12 min the live flags are `[true, false, true]` and `closeCount` is 1). The probe passes while it asserts the wrong behaviour: budget 1, two idle sessions remain, releasable C is never trimmed. Contrast PROBE-B1b "trim does not count a session held by the background-work probe" (the held session does not use up the excess; `closeCount` 2).
    - Size (confirmed only): S. Effect on the user: more warm idle Claude processes than the memory budget allows, until the next turn end, the next open or the 30 min idle timeout.
  - **B-G3.2** [unguarded transition] Probe failure keeps the session in the trim; see G1.2. **Verdict:** confirmed (see G1.2). Tracked: t3code-188.
    - Evidence: PROBE-B3.

### B-M4. Idle thread unload inside a session

- Owner: both.
- Stored in: memory, `idleThreadUnloads` per live entry (`apps/server/src/orchestration-v2/ProviderSessionManager.ts:291`).
- States: thread loaded; unload scheduled (generation + fiber); unloaded; child archive waiting for delivery (`awaiting_delivery`).
- Transitions:
  - loaded -> unload scheduled, and scheduled -> cancelled: the map update at `apps/server/src/orchestration-v2/ProviderSessionManager.ts:1758-1764`.
  - scheduled -> unloaded: `unloadIdleThread` (`apps/server/src/orchestration-v2/ProviderSessionManager.ts:1857`), guarded by the generation (`apps/server/src/orchestration-v2/ProviderSessionManager.ts:1899`), bounded by `UNLOAD_THREAD_TIMEOUT_MS` (10 s, `apps/server/src/orchestration-v2/ProviderSessionManager.ts:79`).
  - a delegated child that waits for delivery holds the session: `holdsUndeliveredChild` (`apps/server/src/orchestration-v2/ProviderSessionManager.ts:1264-1269`), state read by `delegatedChildArchive` (`apps/server/src/orchestration-v2/ProviderSessionManager.ts:1828`).
  - session idle release archives delivered children first (`apps/server/src/orchestration-v2/ProviderSessionManager.ts:1326-1336`).
  - `detach` removes the thread's entry (`apps/server/src/orchestration-v2/ProviderSessionManager.ts:3145-3160`).
- Restart: lost with the live entry (M1).
- Explicit or implicit: implicit. A generation number and a fiber stand for the state.
- Gaps:
  - none proven. I read the code and wrote no probe for this machine.

### B-M5. Provider retry stall watch

- Owner: upstream.
- Stored in: memory, per live entry (`apps/server/src/orchestration-v2/ProviderSessionManager.ts:2404`).
- States: no retry; provider retrying (timer of `PROVIDER_RETRY_STALL_TIMEOUT`, 15 min, `apps/server/src/orchestration-v2/ProviderSessionManager.ts:81`); stalled (the manager emits a synthetic failed `turn.terminal`, `apps/server/src/orchestration-v2/ProviderSessionManager.ts:2535`).
- Transitions: built in `makeRetryStallWatch` (`apps/server/src/orchestration-v2/ProviderSessionManager.ts:2404-2575`); a real `turn.terminal` passes through and clears the watch (`apps/server/src/orchestration-v2/ProviderSessionManager.ts:2522`).
- Restart: lost. After a restart the turn is settled by the recovery service (area A boundary).
- Explicit or implicit: implicit, but in one function.
- Gaps:
  - none proven. Pinned by `apps/server/src/orchestration-v2/ProviderSessionManager.test.ts:2198` ("fails a turn whose provider retry never resumes"), exit 0.

### B-M6. Claude live query and CLI process

- Owner: upstream (the fork changed the scheduling priority only, `apps/server/src/orchestration-v2/Adapters/agentProcessPriority.ts`).
- Stored in: memory (`queryContext`, `openedNativeThreads`, `closed` Deferred per query). The resume id is the native thread id in the projection (`providerThreads.nativeThreadRef`).
- States: no query; opening (waits for the installation gate, then boot, `CLAUDE_BOOT_TIMEOUT` 5 min, `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts:353`); live; stopping; closed.
- Transitions:
  - no query -> opening -> live: `openQuery` (`apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts:11920`). An existing query is closed first (`apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts:12013-12022`). The open runs inside the installation gate (`apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts:12092`).
  - resume or fresh: `shouldResume` = rollback head, or `openedNativeThreads`, or a persisted provider turn (`apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts:12024-12029`).
  - live -> stopping -> closed: `interruptTurn` (`apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts:12655-12668`), `closeSession` (`apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts:12905`), `closeLiveQueryForNativeThread` (`apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts:12924`).
- Restart: the process and all memory are lost. The next turn resumes by the persisted native thread id (`apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts:12026-12029`).
- Explicit or implicit: implicit. Liveness is "the Ref holds a query and its Deferred is not done".
- Gaps:
  - **B-G6.1** [state lost on a crash or restart] `openedNativeThreads` is lost on an idle release or restart. A first turn whose CLI created the native session but persisted no provider turn would reopen without resume. **Verdict:** refuted.
    - Claim: after an idle release or a restart, a first turn whose CLI created the native session but persisted no provider turn reopens without resume.
    - Evidence 1 (existing test): "resumes an imported native session on its first T3 turn" (`src/orchestration-v2/Adapters/ClaudeAdapterV2.test.ts`, describe "ClaudeAdapterV2 native session identity"). A new adapter instance, `providerTurnOrdinal` 1, `nativeThreadHasTurns` false, and a transcript on disk: the query opens with `resume` and without `sessionId`.
      Command: `vp test run src/orchestration-v2/Adapters/ClaudeAdapterV2.test.ts -t "resumes an imported native session on its first T3 turn|offers a later wake after an earlier wake's continuation dispatch failed|starts the wake run when Claude opens the wake turn, before its output" --reporter=verbose` -> exit 0 (3 passed, 404 skipped).
    - Evidence 2: PROBE-B13a "a saved transcript with no provider turn reopens with resume" passes (`resume` is the native id, `sessionId` is undefined). PROBE-B13b "no transcript and no provider turn reopens as a fresh session id" passes (`sessionId` is the native id, `resume` is undefined); this is correct, because the CLI holds no session then.
      Command: `vp test run src/orchestration-v2/Adapters/AuditBClaude.probe.test.ts -t "PROBE-B1|resumes an imported native session on its first T3 turn|offers a later wake after an earlier wake's continuation dispatch failed" --reporter=verbose` -> exit 0 (6 passed, 405 skipped).
    - Why: `resumeThread` does not trust `openedNativeThreads` alone. It reads the CLI transcript from disk (`apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts:12957`, `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts:13093-13117`) and marks the native thread as opened when the transcript holds a conversation. The first pass missed this writer.
    - Limit of the proof: the probes test the adapter only. That the reopen path calls `resumeThread` for a thread with a native ref (`ProviderTurnStartService.ts:1354`, `apps/server/src/orchestration-v2/ProviderSessionManager.ts:2181-2225`) is from reading. A transcript file that exists but holds no conversation line makes `resumeThread` fail with "has no conversation to resume" (`apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts:13106-13111`); I did not probe what the turn start does next. The real CLI answer "already in use" is not modelled by any harness.
  - **B-G6.2** [unguarded transition] A provider update could replace the CLI while a turn opens. **Verdict:** by design (only the open waits; a running turn is not interrupted).
    - Evidence: comment at `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts:12088`; `apps/server/src/provider/ProviderInstallationGate.test.ts:11` ("queues work that starts while an update waits for in-flight work"), `vp test run src/provider/ProviderInstallationGate.test.ts`, exit 0; `apps/server/src/orchestration-v2/ProviderSessionManager.test.ts:1218`.
  - **B-G6.3** [state with no exit] A query that ends before its first frame could leave the turn open. **Verdict:** refuted.
    - Evidence: `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.test.ts:12645`, command `vp test run src/orchestration-v2/Adapters/ClaudeAdapterV2.test.ts -t "fails a turn whose Claude query ends before its first frame"`, exit 0.

### B-M7. Claude turn (start, streaming, interrupt, end)

- Owner: upstream.
- Stored in: memory (`activeTurn` Ref, `interruptedTurns` set). The projection keeps `providerTurn.status`.
- States: no active turn; running; interrupt requested; terminal (completed, failed, interrupted).
- Transitions:
  - none -> running: `startTurn` (`apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts:12248`); refused with `previous_turn_active` while a turn is active (`apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts:12273-12280`).
  - running -> interrupt requested: `interruptTurn` adds the turn to `interruptedTurns` (`apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts:12649-12653`), calls the SDK interrupt with a 10 s limit (`apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts:12655-12656`), then closes the query (`apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts:12664`).
  - interrupt requested -> terminal: the query closes within `CLAUDE_STOP_CONFIRM_TIMEOUT_MS` (10 s, `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts:365`, `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts:12666-12671`).
  - interrupt requested -> running (stays): the CLI does not confirm; the adapter fails with `ProviderAdapterInterruptTimeoutError` and leaves the turn open (`apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts:12672-12684`).
  - running -> terminal: `finalizeActiveTurn` (`apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts:8615`).
- Restart: the active turn is lost. The projection turn is settled by the recovery service (area A boundary).
- Explicit or implicit: implicit. Two Refs and a set stand for the state.
- Gaps:
  - **B-G7.1** [state with no exit] When the CLI does not confirm a Stop, the adapter leaves the turn running with no terminal event, and refuses the next turn (`previous_turn_active`). Nothing in the adapter ends it later. The exit is the user's Force stop, which area A handles (`apps/server/src/orchestration-v2/ProviderTurnControlService.ts:266-276` marks the error `unresponsive`; `apps/server/src/orchestration-v2/EffectWorker.ts:200-220` turns it into `thread.interrupt.unresponsive`). **Verdict:** by design.
    - Evidence: comment at `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts:12672-12673` ("The turn stays open: the CLI may still be working, and the user decides whether to Force stop it."). PROBE-B6 "a Stop the CLI never confirms leaves the turn active with no terminal event" passes: the error tag is `ProviderAdapterInterruptTimeoutError`, there are 0 terminal events, the next `startTurn` fails with `previous_turn_active`, and after 7 more days there are still 0 terminal events.
  - **B-G7.2** [state with no exit] `existing.query.close` at `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts:12664` has no time limit of its own. **Verdict:** refuted (the session manager bounds the whole interrupt at 15 s).
    - Evidence: `apps/server/src/orchestration-v2/ProviderSessionManager.test.ts:1661`, exit 0; and `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.test.ts:12150`, exit 0, for the confirmed-close path.
  - **B-G7.3** [one state kept in two places] Stop or restart against a session that is no longer live returns success and leaves the projected turn `running` "until recovery/finalization" (`apps/server/src/orchestration-v2/ProviderTurnControlService.ts:169-191`). **Verdict:** refuted.
    - Claim: Stop against a session that is no longer live returns success and leaves the projected turn `running`.
    - Evidence 1 (existing test): "Stop recovers a stalled run after missing-session-terminal without changing a newer attempt" (`src/orchestration-v2/BackgroundWorkStop.integration.test.ts:1057`).
      Command: `vp test run src/orchestration-v2/BackgroundWorkStop.integration.test.ts -t "Stop recovers a stalled run" --reporter=verbose` -> exit 0 (3 passed, 9 skipped).
    - Evidence 2: PROBE-B9a "Stop with no live session settles a turn the projection still calls running" passes. The session is released, stale events put run, attempt, provider turn and node back to `running`, then `thread.stop` runs. All four end as `interrupted`. The adapter gets no new interrupt. The warning of `ProviderTurnControlService.ts:169-191` appears 0 times, because the Orchestrator sees at decision time that no session is live and settles the run itself.
    - Evidence 3: PROBE-B9b "a session lost between Stop and its interrupt effect still settles the turn" passes. Stop is committed while the session is live; the session is released before the effect runs. The warning "Provider interrupt/restart found no live session; treating as already stopped" appears 1 time. All four records end as `interrupted`, because the effect worker dispatches `thread.background-work.settle` after the interrupt returns (`EffectWorker.ts:174-235`).
      Command for 2 and 3: `vp test run src/orchestration-v2/AuditBStalledTurn.probe.test.ts -t "PROBE-B" --reporter=verbose` -> exit 0.
    - More facts from the probe: a release of a session with a running turn fails the run at once (run `failed`, attempt `failed`, provider turn `interrupted`, node `failed`). The single `interruptTurn` call in the probe comes from that release, not from Stop.
    - Limit of the proof: the probe makes the stale `running` projection by a direct `EventSink.write`. The `restart` operation of the same branch (`ProviderTurnControlService.ts:174`, `:317`) was not probed.

### B-M8. Claude background wake: buffer, continuation latch and continuation request queue

- Owner: both (upstream machine; fork commits `aa79418128`, `1df5404dfe`, `64eabd40c4` changed it; `hasUndeliveredWake` at `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts:13038-13045` and `packages/provider-core/src/server/ProviderAdapter.ts:671` is fork).
- Stored in: memory only. `wakeBuffers` and `requestedContinuations` in the adapter; an unbounded in-memory queue (`packages/provider-core/src/server/ProviderContinuationRequests.ts:48`); `retryAttempts` in the continuation service (`apps/server/src/orchestration-v2/ProviderContinuationService.ts:65`).
- States: no wake; wake buffered and continuation offered (latch `retired: null`); latch retired `unopened`; latch retired `opened`; wake run started and Claude's wake turn not yet open; wake turn open; settled.
- Transitions:
  - frame after turn end -> buffered: `bufferWakeMessage` (`apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts:9222`).
  - buffered -> offered: `offerWakeContinuation` (`apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts:9410`); with no route the wake is not offered and only a warning is logged (`apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts:9412-9418`).
  - offered -> retired: `retireOfferedWake` (`apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts:9463`), `setRetiredLatch` (`apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts:9526`).
  - offered -> dispatched: the continuation service takes the request and dispatches a `provider`-sourced message (`ProviderContinuationService.ts:131`, command id at `:243`). A run that ends without starting retires the latch (`:84`).
  - dispatch failure: delegated completions retry with backoff; other requests are cleared with a log (`ProviderContinuationService.ts:298`, `:334`).
  - wake run started, turn never opened -> settled as `completed` after `CLAUDE_WAKE_TURN_START_DEADLINE` (2 min, `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts:356`, `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts:12566-12593`).
  - session kept alive while a wake waits: `hasUndeliveredWake` (`apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts:13038`), read by the manager's pending-work probe (`apps/server/src/orchestration-v2/ProviderSessionManager.ts:1248-1261`).
- Restart: every buffer, latch and queued request is lost. The start-up reconcile cancels queued runs of buffered provider notifications (`apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts:364-366`, `:425-428`) and writes a background-work-cancelled note (`:815-834`). The restart continuation itself is area A.
- Explicit or implicit: implicit. The latch has a named field (`retired`), but the full state is spread over three Refs, a queue and the projection.
- Gaps:
  - **B-G8.1** [state lost on a crash or restart] A wake that waits in memory is lost on a restart. **Verdict:** by design.
    - Evidence: `apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.test.ts:135` and `:919`, exit 0.
  - **B-G8.2** [state with no exit] A wake run whose wake turn Claude never opens. **Verdict:** refuted (it has an exit), and the exit is by design: the run ends `completed` with no output after 2 minutes.
    - Evidence: comment at `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts:354-355`; upstream commit `4b1426f5ec` ("a Claude wake run settles when Claude never opens the wake turn"). PROBE-B7 "a wake turn Claude never opens ends as completed after two minutes" passes: 1 terminal event at 119 s, 2 at 121 s, last status `completed`, `hasUndeliveredWake` true before and false after.
  - **B-G8.3** [lost information] A wake with no route is dropped with only a warning (`apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts:9412-9418`). **Verdict:** refuted for the reachable path; the drop branch itself is not verified.
    - Claim: a wake with no route is dropped with only a warning (`apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts:9412-9418`).
    - Evidence: PROBE-B12 "a wake after a turn carries that turn's route and logs no unroutable warning" passes. The continuation request carries the thread id and the provider thread id of the last turn. A captured logger sees 0 lines with `claude-wake-turn-unroutable`.
      Command: the `AuditBClaude.probe.test.ts` command under G6.1 -> exit 0. The existing test "starts the wake run when Claude opens the wake turn, before its output" passes in the `ClaudeAdapterV2.test.ts` command under G6.1 -> exit 0.
    - What I tried for the branch: no input of the adapter reaches it. `lastTurnRouteByNativeThread` has one writer (`apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts:12281-12288`, in `startTurn`) and no delete. The only caller of `queryRunner.open` (`apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts:12083`, through `openQuery` at `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts:12339`) runs after that writer in the same `startTurn`. Every `bufferWakeMessage` call site (`apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts:9862`, `:9939`, `:9983`, `:11347`) passes the native thread id of that live query. So a wake frame cannot arrive for a native thread with no route.
    - Limit of the proof: the statement "the branch cannot be entered" rests on this reading, not on a probe. A probe of the drop needs a test seam that opens a query without `startTurn` or removes a route; the code has none. If a later change adds a second query opener or deletes routes, the gap opens.
  - **B-G8.4** [lost information] A failed dispatch of a non-delegated wake clears the request with a log only (`ProviderContinuationService.ts:334-336`). **Verdict:** by design.
    - Claim: a failed dispatch of a non-delegated wake clears the request with a log only.
    - Stated intent:
      - `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts:9461-9462`: "Drops what the unstarted continuation would have shown."
      - `src/orchestration-v2/Adapters/ClaudeAdapterV2.test.ts:14216`: "A failed dispatch never attaches the wake turn; clearIfCurrent is the only release."
      - Test name at `src/orchestration-v2/ProviderContinuationService.test.ts:424`: "clears a sticky continuation offer when a non-delegated wake dispatch fails generically".
      - Upstream commit `7315c60b95`: "a failed Claude wake dispatch no longer drops every later wake (#28173)".
    - Behaviour, service side: PROBE-B10 "a failed non-delegated wake dispatch is tried once and never again" passes. One dispatch attempt, one `clearIfCurrent` call, and no further attempt after `TestClock.adjust("7 days")`.
      Command: `vp test run src/orchestration-v2/AuditBContinuation.probe.test.ts -t "PROBE-B10|fails generically" --reporter=verbose` -> exit 0 (2 passed, 11 skipped).
    - Behaviour, adapter side: PROBE-B11 "a wake whose continuation dispatch failed never shows its output" passes. After `clearIfCurrent`, the adapter emits only two `provider_thread.updated` events, no `message.updated` with the wake text, and no second terminal event. The existing test "offers a later wake after an earlier wake's continuation dispatch failed" passes too, so later wakes still work.
      Command: the `AuditBClaude.probe.test.ts` command under G6.1 -> exit 0.
    - Existing test: `vp test run src/orchestration-v2/ProviderContinuationService.test.ts -t "non-delegated wake dispatch fails generically" --reporter=verbose` -> exit 0 (1 passed, 11 skipped).
    - Limit of the proof: the probe fails the dispatch with a made `OrchestratorDispatchError`. I did not probe whether a later user turn shows the dropped text; the native Claude session still holds it. The design covers a refused dispatch and a failed one the same way: a short failure (for example a locked database) loses the wake output, while a delegated completion is retried with backoff (`ProviderContinuationService.ts:303-333`). Whether a short failure should be retried is a design question for upstream, not a defect by this rule.
    - Effect on the user (for the design question): Claude's reply to a finished background task does not appear in the thread when the one dispatch attempt fails.

### B-M9. Usage-limit recovery

- Owner: upstream.
- Stored in: SQLite projection (`thread.limitRecovery`, the run's `usageLimitResetAt`; area A owns the store). The worker keeps only a wake-time hint in memory.
- States: no limit; limit hit and not armed; armed for a reset time; resume dispatched; expired (more than 24 h overdue, never armed).
- Transitions: one pure function, `limitRecoveryCommand` (`apps/server/src/orchestration-v2/UsageLimitRecoveryWorker.ts:17-79`): overdue guard (`:43`, `MAX_OVERDUE_ARM_MS` at `:15`), arm command with id `limit-arm:<identity>` (`:47`), resume message with id `limit-resume:<identity>` (`:66-67`). The sweep retries a failed dispatch on the next tick (`:134-143`).
- Restart: survives. State is in the projection, and the command ids are idempotent.
- Explicit or implicit: explicit decision function; the orchestrator (area A) applies the commands.
- Gaps:
  - none proven. Pinned by `apps/server/src/orchestration-v2/UsageLimitRecoveryWorker.test.ts:19`, `:96`, `:102`, `:108`, `:114`, exit 0. The fork commit `1950d3e388` (retry of delegated runs after a short rate limit) changes no file of area B (`git show --stat 1950d3e388`); it is in areas A and C.

### B-M10. Claude reset-credit redemption and usage caches

- Owner: upstream for the coordinator; fork for the credits cache (`apps/server/src/provider/claudeResetCredits.ts`).
- Stored in: memory. `pendingKey` per login directory (`apps/server/src/provider/resetCreditCoordinator.ts:12-15`, `:32`); a credits cache of capacity 1 (`claudeResetCredits.ts:243-262`); a capabilities probe cache (`apps/server/src/provider/Drivers/ClaudeDriver.ts:218-227`).
- States (redemption): no pending request; request sent and unanswered (key kept); settled.
- States (cache): empty; fresh (5 min, only for a successful read with `requested: true`, `claudeResetCredits.ts:237`, `:251`); invalidated.
- Transitions:
  - none -> unanswered: `redeem` creates or reuses the key (`resetCreditCoordinator.ts:57-59`).
  - unanswered -> none: a settled error (`:61-63`) or an outcome (`:65`). `requestFailed` and `unconfirmed` are not settled (`claudeResetCredits.ts:95-98`).
  - the driver calls `redeem` with the login directory as the key and the chosen `grantId` (`ClaudeDriver.ts:327-338`).
  - cache -> invalidated: `invalidate` (`claudeResetCredits.ts:260`), called through `invalidateUsageCaches` (`ClaudeDriver.ts:234-237`).
- Restart: the pending key and both caches are lost.
- Explicit or implicit: implicit. A nullable Ref is the whole machine.
- Gaps:
  - **B-G10.1** [unguarded transition] The unanswered request id belongs to the login directory, not to the grant, and never expires. A later redemption of a different grant is sent with the old id. **Verdict:** confirmed (local behaviour). The effect at Anthropic's server is not verified: I cannot call it. Tracked: t3code-189.
    - Evidence: PROBE-B5 case 1 "a different grant, 30 days later, is sent with the old unanswered request id" passes while it asserts the wrong behaviour (both consume calls receive the same key).
    - Size (confirmed only): S. Effect on the user: after a redemption that timed out, a later redemption of another credit may be answered as a repeat of the old request, so the wrong credit, or none, is used.
  - **B-G10.2** [state lost on a crash or restart] A restart forgets the unanswered request id. The retry goes out as a new claim. **Verdict:** confirmed (local behaviour); the same limit on the server effect applies. The intent to keep the key is stated at `resetCreditCoordinator.ts:20` and pinned by `apps/server/src/provider/resetCreditCoordinator.test.ts:11` (`vp test run src/provider/resetCreditCoordinator.test.ts`, exit 0). Tracked: t3code-189.
    - Evidence: PROBE-B5 case 2 "a server restart forgets the unanswered request id" passes (two coordinators give two different keys for the same unanswered claim).
    - Size (confirmed only): S. Effect on the user: a redemption that timed out, followed by a server restart and a retry, can spend two credits if the first request did reach the server.

### B-M11. Provider status cache on disk

- Owner: upstream.
- Stored in: file `<cacheDir>/<instanceId>.json` (`apps/server/src/provider/providerStatusCache.ts:98-106`).
- States: no file; valid and correlated; unparsable (ignored with a warning, `:122-131`); not correlated or `enabled` differs (ignored, `:68-77`).
- Transitions: write is atomic and strips `updateState` (`:135-144`); hydrate keeps settings-derived models and takes status, version, auth and `checkedAt` from the cache (`:79-90`).
- Restart: survives. The cached status is shown until the next probe; `updateState` is never restored.
- Explicit or implicit: implicit, small.
- Gaps:
  - none proven. Pinned by `apps/server/src/provider/providerStatusCache.test.ts:35`, `:96`, `:125`, `:148`, exit 0.

### B-M12. Provider update (maintenance) state, command coordinator and installation gate

- Owner: upstream.
- Stored in: memory. `updateState` in the provider snapshot; `runningTargetsRef` and a keyed lock (`apps/server/src/provider/providerMaintenanceCommandCoordinator.ts:17-18`); turnstile and room permits (`apps/server/src/provider/ProviderInstallationGate.ts:47-70`).
- States: idle; queued; running; succeeded; unchanged; failed.
- Transitions (in `apps/server/src/provider/providerMaintenanceRunner.ts`):
  - idle -> queued: `:454-461`. A second request for the same target fails as already running (`providerMaintenanceCommandCoordinator.ts:45-48`).
  - queued -> running: `:477-486`, inside the command lock (`:691`).
  - running -> failed: `:495-502`, `:535-545`, `:605-613`, `:675-681`; a command that passes `UPDATE_TIMEOUT_MS` (`:48`, `:206`).
  - running -> succeeded or unchanged: `:571-580`, `:652-666`.
  - any -> failed on interrupt: `:699-712` ("Update stopped before it finished.").
  - the update drains in-flight opens and blocks new opens: `ProviderInstallationGate.ts:56-70`.
- Restart: lost. The status cache strips `updateState` (M11), so the state is idle after a restart.
- Explicit or implicit: implicit. The status values are named, but no single function owns the moves.
- Gaps:
  - **B-G12.1** [state with no exit] A dropped request could leave the state `running`. **Verdict:** refuted.
    - Evidence: comment at `providerMaintenanceRunner.ts:698`; `apps/server/src/provider/providerMaintenanceRunner.test.ts:907` ("an interrupted update ends failed instead of running forever"), `:933`, and `:1153` ("releases the running-provider marker when interrupted after queuing but before the lock run starts"). Command: `vp test run src/provider/providerMaintenanceRunner.test.ts`, exit 0.

### B-M13. Provider commit batch

- Owner: upstream.
- Stored in: memory. A bounded queue, a `closed` flag and an owner token per consumer (`apps/server/src/orchestration-v2/ProviderCommitBatch.ts:92-99`).
- States: open and empty; collecting (up to `MAX_EVENTS` 64 or `MAX_BYTES` 1 MiB, `:12-13`); committing; owner failed (its other jobs are cancelled, `:167`, `:183`, `:189`); closed (`barrier` interrupts, `:218`).
- Transitions: `enqueue` (`:102-160`), worker (`:161-216`), `barrier` (`:217-232`), `consume` (`:233-299`), `shutdown` (`:95-99`).
- Restart: snapshot events that are queued and not yet committed are lost. Controls flush the snapshots before them.
- Explicit or implicit: implicit, in one module with a full test file.
- Gaps:
  - none proven. Pinned by `apps/server/src/orchestration-v2/ProviderCommitBatch.test.ts:70`, `:110`, `:302`, `:464`, exit 0. I wrote no crash probe.

### B-M14. Provider text delta coalescer

- Owner: upstream.
- Stored in: memory. `buffered` text, a `flushScheduled` flag and a flush lock (`apps/server/src/orchestration-v2/Adapters/ProviderTextDeltaCoalescer.ts:45-47`). The Claude adapter uses it for reasoning deltas (`apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts:8487`).
- States: empty; buffered with a flush scheduled; flushing; completed.
- Transitions: `append` schedules one flush after the interval (`:100-130`); `drain` and `flushDirty` reset the flag in `ensuring` (`:50-97`); `complete` and `flushTurn` flush at once (`:131-153`).
- Restart: text newer than the last flush is lost.
- Explicit or implicit: implicit, small.
- Gaps:
  - none proven. See P4.

### B-M15. Model manifest cache

- Owner: upstream.
- Stored in: memory (`manifest`, `fetchedAtMs`, `lastAttemptMs`, `apps/server/src/provider/ModelManifest.ts:206-208`) and file `<stateDir>/model-manifest.json` (`:205`).
- States: bundled; loaded from disk; fetched; fetch failed and backing off (5 min, `:34`, `:237`).
- Transitions: disk load once, rejected when older than the bundle (`:212-225`); refresh when older than 1 h, or 5 min on demand (`:28`, `:31`, `:236`); fetch with a 10 s limit (`:36`, `:249`); a remote copy older than the current one is rejected (`:253`); update checks disabled stops the fetch (`:242`).
- Restart: the disk copy survives; `lastAttemptMs` does not.
- Explicit or implicit: implicit, small.
- Gaps:
  - none proven. Pinned by `apps/server/src/provider/ModelManifest.test.ts:269`, `:288`, `:312`, `:339`, `:367`, `:403`, exit 0. Note: the fetch URL is the upstream repository's `main` branch (`ModelManifest.ts:26`), so the fork takes its model list from upstream whenever upstream's copy is newer than the bundled one.

### B-M16. Provider sign-in changes and session invalidation

- Owner: upstream.
- Stored in: memory (`credentialChanges` semaphore, `apps/server/src/provider/ProviderAuthService.ts:74`; each driver's auth controller, not read) and the server secret store under `provider-auth-<hash>` (`apps/server/src/provider/ProviderCredentialStore.ts:13-16`).
- States: signed in; change in progress (one at a time per server; another instance that shares the binding is refused); sessions being stopped; signed out.
- Transitions: `start`, `importProfile`, `removeMethod`, `logout` run under the semaphore (`ProviderAuthService.ts:211-286`); `checkSharedBinding` refuses an overlapping change (`:174-198`); `stopSessions` releases every live session on the binding before the change (`:94-172`).
- Restart: an in-progress flow is lost; stored credentials survive.
- Explicit or implicit: implicit; the driver controllers hold the real flow state.
- Gaps:
  - none proven. Pinned by `apps/server/src/provider/ProviderAuthService.test.ts:420`, `:601`, `:669`, `:682`, exit 0. I did not read the Claude auth controller.

### Area B: other points

- **B-P1** untested state: the idle budget's `keepIf: hasUnfinishedRecords` branch has no test, `apps/server/src/orchestration-v2/ProviderSessionManager.ts:1460`. **Verdict:** confirmed. Tracked: t3code-187.
  - Evidence: `grep -cE "keepIf|hasUnfinishedRecords" src/orchestration-v2/ProviderSessionManager.test.ts` returns 0; PROBE-B1 is the first case that reaches it, and it shows G3.1.
- **B-P2** untested state: the Claude Stop-not-confirmed branch has no test, `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts:12672-12684`. **Verdict:** confirmed. Tracked: t3code-190.
  - Evidence: `grep -cE "InterruptTimeout|interrupt-timeout|STOP_CONFIRM" src/orchestration-v2/Adapters/ClaudeAdapterV2.test.ts` returns 0; PROBE-B6 covers it and passes.
- **B-P3** untested state: the wake-turn deadline has no test at HEAD, `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts:12566-12593`. **Verdict:** confirmed. Tracked: t3code-190.
  - Evidence: upstream added its tests in `4b1426f5ec` and deleted them in `05696c636e` ("test: delete 11k low-signal tests"), shown by `git log --oneline -S"settles a subagent wake run" -- apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.test.ts` (prints `05696c636e` and `4b1426f5ec`); `grep -cE "WAKE_TURN_START|wake-turn-never-opened|startSubagentWakeWithoutWakeTurn"` on the test file returns 0; PROBE-B7 covers it and passes.
- **B-P4** untested state: the text delta coalescer has no test file of its own, `apps/server/src/orchestration-v2/Adapters/ProviderTextDeltaCoalescer.ts:1`. **Verdict:** behaviour refuted; the missing test stays confirmed. Tracked: t3code-242.
  - Claim: the text delta coalescer has no test of its own, and its behaviour had no verdict.
  - Evidence for the behaviour (new probe file, 5 cases, all pass):
    - PROBE-B16a "deltas inside one interval leave as one update, and the schedule re-arms": empty -> buffered -> flushed. Nothing leaves before the interval; one update per item leaves at the interval; a clean buffer is not sent again; a new delta arms a new flush that carries the whole text.
    - PROBE-B16b "complete sends the final text once and a pending flush adds nothing": `complete` returns and emits the buffered text, `finalText` replaces it, `emitEmpty: false` emits nothing for empty text, and the pending flush emits no second copy.
    - PROBE-B16c "flushTurn completes every buffer of its turn only, dirty or clean": the other turn's buffer stays and leaves at its own flush.
    - PROBE-B16d "a delta after complete starts a new buffer that holds only the late text": after `complete` ("Hello"), a late delta "!" leaves as `{ text: "!", completed: false }` for the same item.
    - PROBE-B16e "closing the scope before the flush drops the buffered text": 0 updates leave.
      Command: `vp test run src/orchestration-v2/Adapters/AuditBTextDeltaCoalescer.probe.test.ts --reporter=verbose` -> exit 0 (5 passed).
  - Evidence for the missing test: `ls src/orchestration-v2/Adapters/ProviderTextDeltaCoalescer.test.ts` -> "No such file or directory"; `grep -c "TextDeltaCoalescer\|flushIntervalMs\|coalesc"` gives 8 in `CodexAdapterV2.test.ts` and 0 in `ClaudeAdapterV2.test.ts`.
  - Limit of the proof: B16d and B16e show two edges of the machine. I did not check whether a caller can reach them. The callers end a turn with `flushTurn` (`CodexAdapterV2.ts:6551-6553`, `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts:8627`), which empties the buffers before a scope closes in the normal order. I give no verdict on these two edges. The probe uses a synchronous `emit`; a slow or interrupted `emit` was not probed.
  - Owner: upstream (no change in `git diff origin/main...origin/fork` for this file). Size: S (move the five cases into a test file).
  - Effect on the user: none proven; a regression in streamed reasoning or message text would have no direct test.
  - First pass: Evidence: `src/orchestration-v2/Adapters/ProviderTextDeltaCoalescer.test.ts` does not exist; `grep -rln TextDeltaCoalescer src --include=*.test.ts` lists only `CodexAdapterV2.test.ts`. I wrote no probe.
- **B-P5** lost information: a failed read of the unfinished records keeps the session (returns `true`) with no log seen by the user, `apps/server/src/orchestration-v2/ProviderSessionManager.ts:1434`. **Verdict:** confirmed. Tracked: t3code-241.
  - Claim: a failed read of the unfinished records keeps the session and writes no log (`apps/server/src/orchestration-v2/ProviderSessionManager.ts:1412-1437`, `Effect.orElseSucceed(() => true)`).
  - Evidence: PROBE-B15 "a failed read of unfinished records keeps idle sessions over the budget and logs nothing" passes while it asserts the wrong behaviour. Budget `maxIdleSessions` 1, three plain idle sessions, the manager's `getThreadRecords(["runtimeRequests","providerThreads"])` fails. Result: all three sessions are live, `closeCount` 0, 2 failed reads, 0 log lines from the manager. After 50 more minutes the count of failed reads is still 2, so no later trim tried again.
    Control: PROBE-B15c "control: with a working read the budget releases the two oldest idle sessions" passes (live `[false,false,true]`, `closeCount` 2).
    Command: `vp test run src/orchestration-v2/AuditBSessionManager.probe.test.ts -t "PROBE-B15" --reporter=verbose` -> exit 0 (2 passed, 73 skipped).
  - Limit of the proof: the probe injects the failure by wrapping the projection store of the manager only. I did not produce a real SQLite failure. The ordinary idle-timeout release does not use `keepIf` (`keepIf` occurs only at `apps/server/src/orchestration-v2/ProviderSessionManager.ts:1460` and `apps/server/src/orchestration-v2/ProviderSessionManager.ts:2072`), so that release still ends the hold after the idle timeout (default 30 minutes, `apps/server/src/orchestration-v2/ProviderSessionManager.ts:66`); this bound is from reading, not from the probe. The probe checked up to 52 minutes with a 60 minute timeout. The second user of the read (`apps/server/src/orchestration-v2/ProviderSessionManager.ts:2072`, linked environments changed) was not probed.
  - Owner: fork (commit `c8c682e41d`, "the idle-session budget rechecks each minute and keeps sessions with a pending request", only on `origin/fork`).
  - Size: S (log the failure; do not count a kept session as released).
  - Effect on the user: while the projection read fails, the idle budget releases nothing, so each idle session keeps a provider process tree of a few hundred MiB until its idle timeout, and no log line says why.
- **B-P6** wait without limit: see G1.1 (busy session, PROBE-B4) and G7.1 (unconfirmed Stop, PROBE-B6). Both waits end only by a user action. **Verdict:** no verdict of its own; see the gap it names.
- **B-P7** lost information: a wake with no route, and a failed dispatch of a buffered wake, are dropped with a log only. See G8.3 and G8.4; no verdict. **Verdict:** no verdict of its own; see the gap it names.

## Area C: MCP tools, delegation and scheduled tasks

### Area C: evidence conventions

Checked at HEAD `22b65998f3` (branch `chore/audit-state-machines`). Merge base with `origin/main`: `b68aedfdb7`.

Conventions in this report:

- All `path:line` values are repo-relative. Paths that start with `src/` in a command are relative to `apps/server`.
- `P/` means the probe directory `<archive>/probes/C/`.
- Each probe ran beside the code it tests, from `apps/server`, and was then moved to `P/`. The commands below show the path the probe had when it ran.
- Every probe in this report is a test that PASSES while it asserts the wrong behaviour.
- Owner was decided with `git blame` on the cited lines, then `git merge-base --is-ancestor <commit> origin/main`.

Commands that were run, with results (all from `apps/server`):

- C1: `vp test run src/mcp/OrchestratorMcpService.audit.probe.test.ts --reporter=verbose` -> 2 passed, exit 0.
- C2: `vp test run src/orchestration-v2/runtimeLayer.settle.probe.test.ts src/mcp/McpSessionRegistry.restart.probe.test.ts --reporter=verbose` -> 2 passed, exit 0.
- C3: `vp test run src/scheduledTasks/ScheduledTaskService.restart.probe.test.ts --reporter=verbose` -> 1 passed, exit 0.
- C4: `vp test run src/orchestration-v2/ThreadLaunchService.noRun.probe.test.ts --reporter=verbose` -> 1 passed, exit 0.
- C5: `vp test run src/mcp/McpSessionRegistry.test.ts src/scheduledTasks/ScheduledTaskService.test.ts src/mcp/McpHttpServer.test.ts src/mcp/OrchestratorMcpService.test.ts src/orchestration-v2/ThreadManagementService.test.ts` -> 5 files, 167 tests passed, exit 0.
- C6: `vp test run src/orchestration-v2/ProviderRuntimeRecoveryService.test.ts` -> 18 passed, exit 0.
- C7: `vp test run src/scheduledTasks/ScheduledTaskService.webhook.test.ts` -> 57 passed, exit 0.
- C8: `vp test run src/background/ src/mcp/PreviewAutomationBroker.test.ts src/htmlRender/HtmlRender.test.ts` -> 4 files, 49 passed, 3 skipped, exit 0.
- C9: `vp test run src/orchestration-v2/runtimeLayer.test.ts -t "settles a thread its own agent settled once the turn completes"` -> 1 passed, 158 skipped, exit 0.

Second pass:

Scope: verdicts for ten gaps of the first pass. No new area was read. No tracked file was changed.
Conventions:

- `P/` is `<archive>/probes/C/`.
- Each probe ran beside the code under the path that its command names. After the run I moved it to `P/`. To run a probe again, copy it back to that path.
- All commands ran from `apps/server` at HEAD `22b65998f3`.
- Owner: `git blame` on the cited lines, then `git merge-base --is-ancestor <commit> origin/main`. All confirmed gaps are upstream code.
- "Injected" means that the probe forces a failure through a mock or a wrapper. The probe then proves the consequence of the failure, not that the failure occurs in production.

### C-M1. Delegated task lifecycle as the MCP tools see it (`delegate_task`, `task_status`, `task_cancel`)

- Owner: both (upstream code; fork commit `1950d3e388` added the `retryAt` and `waiting` logic at `apps/server/src/mcp/OrchestratorMcpService.ts:1549-1552` and `1565-1566`)
- Stored in: event stream and projections (area A): the parent's `subagents` record (`status`, `result`, `completionWake`, `completionDelivery.state`, `cancelledRunId`) and the child thread's runs. The status that a tool returns is not stored. `readTask` computes it on each call (`apps/server/src/mcp/OrchestratorMcpService.ts:1472`).
- States:
  - Tool status: `queued`, `running`, `waiting`, `completed`, `failed`, `cancelled`, `interrupted` (`apps/server/src/mcp/OrchestratorMcpService.ts:442-465` maps a run status to it; run statuses `preparing`, `starting`, `running` and "no run" all read `running`).
  - Wake policy: `completionWake` = `always` | `settled_only`.
  - Delivery: `completionDelivery.state` = `pending` | `claimed` | `acknowledged` | `delivered` | `disposed` (owned by area A).
- Transitions:
  - (none) -> recorded: `delegate_task` dispatches the task record. `completionWake` is `settled_only` for `mode: wait`, else `always`. Enforced at `apps/server/src/mcp/OrchestratorMcpService.ts:2550`.
  - recorded -> child run `preparing` -> released: for a worktree child, `threadLaunch.prepareRun` schedules the workspace preparation. Enforced at `apps/server/src/mcp/OrchestratorMcpService.ts:2577-2587` and `apps/server/src/orchestration-v2/ThreadLaunchService.ts:1258-1276`.
  - failed child run with a scheduled retry -> reads `waiting` (fork). Enforced at `apps/server/src/mcp/OrchestratorMcpService.ts:1549-1552`, `1565-1566`.
  - cancelled task whose turn then finished -> reads `interrupted`. Enforced at `apps/server/src/mcp/OrchestratorMcpService.ts:1568-1571`.
  - terminal result read by a tool -> delivery `acknowledged`: `readTask` dispatches the acknowledge with a random request key. Enforced at `apps/server/src/mcp/OrchestratorMcpService.ts:1660-1693`.
  - `settled_only` -> `always`: a `mode: wait` call that ends without a terminal result (time limit, question, interrupted call) upgrades the wake. Enforced at `apps/server/src/mcp/OrchestratorMcpService.ts:1711-1722` (command) and `1745-1749` (finalizer).
  - active -> cancelled: `task_cancel`. A task that cannot be cancelled returns `task_not_cancellable` (`apps/server/src/mcp/OrchestratorMcpService.ts:2696`, `2795`).
  - child question -> parent wake: see M12.
- Restart:
  - A child thread is recovered as its own thread (area A). Existing test: `apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.test.ts:1394` (C6, exit 0).
  - A `settled_only` task whose parent run was cut is upgraded to `always` by area A (`apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts:668-690`).
  - A child cut by a restart reads `running` (work state `working`) until its continuation settles. Existing test: `apps/server/src/mcp/OrchestratorMcpService.test.ts:252` (C5, exit 0).
- Explicit or implicit: implicit on my side; the tool status is derived on each read from several stored fields by one long expression (`apps/server/src/mcp/OrchestratorMcpService.ts:1543-1575`), and the stored transitions are decided in area A.
- Gaps:
  - **C-G1.1** [state lost on a crash or restart] A `mode: wait` call that is interrupted during the wait could leave the task `settled_only`, so a later result would not wake the live parent. **Verdict:** refuted.
    - Evidence: existing test `apps/server/src/mcp/OrchestratorMcpService.test.ts:2367` ("a blocking %s delegation cancelled mid-wait wakes its parent like an async task", local and remote), command C5, exit 0. The finalizer is at `apps/server/src/mcp/OrchestratorMcpService.ts:1745-1749`.
  - **C-G1.2** [unguarded transition] The upgrade finalizer covers only `waitForTask`. An interrupt between the record dispatch (`apps/server/src/mcp/OrchestratorMcpService.ts:2550`) and the start of `awaitTask` (`2589-2591`) leaves the task `settled_only`. The window is `prepareRun`, which only reads records and forks the preparation. **Verdict:** confirmed for the `prepareRun` window. Refuted for the record dispatch window. Tracked: t3code-237.
    - Evidence: `P/OrchestratorMcpService.verdictsC.probe.test.ts`. Command: `vp test run src/mcp/OrchestratorMcpService.verdictsC.probe.test.ts --reporter=verbose`. Exit code 0, 5 passed.
      - Test "PROBE G1.2b: a blocking worktree delegation interrupted during prepareRun stays settled_only". It asserts `task.status === "running"` and `task.completionWake === "settled_only"` after the interrupt. This is the wrong behaviour.
      - Test "PROBE G1.2a: a blocking delegation interrupted inside its record dispatch (shared isolation)". Output: `call interrupted | task: none`. An interrupt inside the dispatch commits no task. This is correct behaviour.
    - Code: the record is written with `settled_only` at `apps/server/src/mcp/OrchestratorMcpService.ts:2550`. The upgrade to `always` runs only in the `awaitTask` finalizer (`:1745-1749`). `prepareRun` (`:2577-2587`) runs between the two with no finalizer.
    - Limit of the proof: `prepareRun` is a mock that blocks, so the real preparation did not run. The probe used worktree isolation only. The probe does not show when the result reaches the parent later. `apps/server/src/orchestration-v2/Orchestrator.ts:1829` delivers a `settled_only` result once the parent's run is not live; I read that line and did not probe it.
    - Owner: upstream (`889bb95f7e`, `303903acd9`). Size: S.
    - Effect on the user: the parent agent gets no wake for the child's result while its current turn runs.
    - First pass: Evidence: code reading only. I wrote no probe, because the window has no step that a test can block without a change to the source.
  - **C-G1.3** [lost information] When the wake upgrade command fails, the failure is only logged (`apps/server/src/mcp/OrchestratorMcpService.ts:1724-1740`). The task then stays `settled_only` and the tool call still returns normally. **Verdict:** confirmed (injected failure). Tracked: t3code-237.
    - Evidence: same file and command, exit code 0. Test "PROBE G1.3: a failed wake upgrade leaves the task settled_only and the tool still promises a wake". The probe makes the `delegated_task.wake-policy` dispatch fail. It asserts `result.status === "running"`, `waitTimedOut === true`, `result.next === ORCHESTRATOR_MCP_RUNNING_TASK_NEXT` ("Completion wakes this thread, so end your turn. Do not wait on it or poll it.") and `task.completionWake === "settled_only"`.
    - Code: `apps/server/src/mcp/OrchestratorMcpService.ts:1724-1740` catches the failure and logs it.
    - Limit of the proof: the failure is injected. I found no real cause for it other than a store error or a task that already has the policy `always`. The later delivery after the parent's turn ends was not probed (same limit as G1.2). If the agent obeys the reply and ends its turn, the code reading says the result is then delivered.
    - Owner: upstream (`303903acd9`). Size: S.
    - Effect on the user: the tool reply promises a wake, and the wake does not come while the agent's turn still runs.
    - First pass: Evidence: code reading only. I did not find a way to make `delegated_task.wake-policy` fail in the real orchestrator, and a mock that fails proves only the log line.
  - **C-G1.4** [lost information] `readTask` acknowledges the delivery before the tool reply reaches the agent (`apps/server/src/mcp/OrchestratorMcpService.ts:1660-1693`). For `mode: wait`, a reply that is lost after the acknowledge leaves the agent without the task id. **Verdict:** confirmed, with limits. Tracked: t3code-238.
    - Evidence: `P/OrchestratorMcpService.verdictsC.probe.test.ts`, same command, exit code 0.
      - Test "PROBE G1.4b: a blocking call whose reply is dropped leaves the result acknowledged with no wake". It asserts `completionDelivery.state === "acknowledged"`, `completionWake === "settled_only"`, one parent message and one parent run (no wake). This is the wrong behaviour.
      - Control in the same test: a retry with the same `clientRequestId` under the same credential returns `status: "completed"`, the summary and the same `taskId`.
      - Test "PROBE G1.4a: a blocking call interrupted inside the acknowledge dispatch commits no acknowledge". Output: `call interrupted | delivery: claimed | wake: always | parent messages: 1 | parent runs: starting`. An interrupt inside the acknowledge dispatch is safe.
    - Supporting test: `apps/server/src/orchestration-v2/DelegatedCompletionDelivery.test.ts:1126` "acknowledging a queued wake's results rewrites it, then cancels it". Command: `vp test run src/orchestration-v2/DelegatedCompletionDelivery.test.ts -t "acknowledging a queued wake's results rewrites it, then cancels it" --reporter=verbose`. Exit code 0. An acknowledge removes the result from a queued wake.
    - Limit of the proof: the probe models the lost reply by discarding the return value of the call. No transport dropped a reply. The probe ran the remote placement path (`readRemoteTask`, `apps/server/src/mcp/OrchestratorMcpService.ts:1776-1803`). The local path (`:1660-1693`) has the same shape and did not run. No comment states that this order is intended. A retry under a new credential is first-pass gap G3.1 and was not repeated here.
    - Owner: upstream (`36d0dcbf55`, `594f1ce2eb`). Size: S.
    - Effect on the user: when a tool reply is lost after the acknowledge, the parent agent gets no wake for that result and sees it only if it retries or calls `task_status`.
    - First pass: Evidence: code reading only. The existing test `apps/server/src/mcp/OrchestratorMcpService.test.ts:84` ("retries terminal acknowledgement with a fresh command id", C5, exit 0) pins only the retry of a failed acknowledge. I did not probe a lost reply.
  - **C-G1.5** [lost information] `task_cancel` only logs a failed dispose of the pending delivery (`apps/server/src/mcp/OrchestratorMcpService.ts:2802`). **Verdict:** by design.
    - Intent: the test name at `apps/server/src/mcp/OrchestratorMcpService.test.ts:759`, "returns cancel requested when post-stop disposal fails".
    - Evidence: command `vp test run src/mcp/OrchestratorMcpService.test.ts -t "returns cancel requested when post-stop disposal fails" --reporter=verbose`. Exit code 0, 1 passed, 79 skipped. The test asserts `cancel_requested` and the dispatched commands `thread.stop` then `delegated_task.completion-delivery.dispose`.
    - Code: `apps/server/src/mcp/OrchestratorMcpService.ts:2800-2807`.
    - Limit of the proof: the test does not show what the delivery that stays undisposed does later. A later wake for the cancelled task is possible and was not probed.
    - First pass: Evidence: code reading only; not probed.
  - **C-G1.6** [state lost on a crash or restart] The restart upgrade of `settled_only` tasks (area A, `apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts:668-690`) has no test in `ProviderRuntimeRecoveryService.test.ts`. **Verdict:** refuted. A test exists and it passes.
    - Evidence: existing test `apps/server/src/orchestration-v2/RestartContinuation.test.ts:300` "lets a cut blocking delegate_task wake its parent like an async task". Command: `vp test run src/orchestration-v2/RestartContinuation.test.ts -t "lets a cut blocking delegate_task wake its parent like an async task" --reporter=verbose`. Exit code 0, 1 passed, 51 skipped.
    - The test calls `ProviderRuntimeRecovery` `reconcile("startup")`. It asserts that only the task of the cut run changes to `always`. The code under test is `apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts:668-690`.
    - Limit of the proof: the test covers one cut run with one waited task. I wrote no new probe.
    - First pass: Evidence: `grep -n completionWake apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.test.ts` returned no line. `apps/server/src/orchestration-v2/RestartContinuation.test.ts:303-319` uses `settled_only` tasks; I did not read or run that file (area A).

### C-M2. Blocking waits and their time limits

- Owner: upstream
- Stored in: memory (the fiber of the tool call)
- States: waiting; returned with a terminal result; returned for a question or approval; returned at the time limit
- Transitions:
  - waiting -> returned: `endsTaskWait` (`apps/server/src/mcp/OrchestratorMcpService.ts:510-516`) for `mode: wait`; `waitForThread` in `apps/server/src/orchestration-v2/ThreadManagementService.ts:966-1101` for `t3_thread_wait`.
  - waiting -> time limit: `mode: wait` and `t3_thread_wait` default 10 min, maximum 60 min, minimum 1 ms (`apps/server/src/mcp/OrchestratorMcpService.ts:134-135`, `1707-1710`).
  - `request_secret`: default 10 min, range 1 s to 60 min, enforced by the contract (`packages/contracts/src/orchestratorMcp.ts:865-867`); poll interval 500 ms (`apps/server/src/mcp/OrchestratorMcpService.ts:143`).
  - `t3_background_wait` does not block. It marks the background tasks as awaited (`apps/server/src/mcp/toolkits/orchestrator/handlers.ts:64-84`; the service call has a 15 s limit, `apps/server/src/orchestration-v2/ThreadManagementService.ts:1489-1536`).
  - Other limits in the area: `stopWorkflow` 15 s (`apps/server/src/orchestration-v2/ThreadManagementService.ts:1403-1487`); force-stop release 10 s (`:589`); settle after run 24 h, used twice (`:587`, `:1103-1186`); scheduled run outcome follower 24 h (`apps/server/src/scheduledTasks/ScheduledTaskService.ts:310`, `892`); MCP credential liveness 24 h (`apps/server/src/mcp/McpSessionRegistry.ts:73`); preview request 15 s, or 660 s for `open` on a preferred host, plus 1 s grace (`apps/server/src/mcp/PreviewAutomationBroker.ts:569`, `44`).
- Restart: every wait is lost with its fiber. For `mode: wait`, see M1 Restart. For the 24 h followers, see G8.1 and G9.1.
- Explicit or implicit: implicit; each wait has its own limit constant and its own end condition.
- Gaps:
  - none proved here. I found no wait without a time limit in the files that I read. A thread with no run makes `t3_thread_wait` return at once (`apps/server/src/orchestration-v2/ThreadManagementService.ts:991-993`); I judge that correct and did not probe it.

### C-M3. MCP credential (session) lifecycle and the idempotency key that depends on it

- Owner: upstream
- Stored in: memory (`SynchronizedRef` at `apps/server/src/mcp/McpSessionRegistry.ts:98`; tokens are kept hashed). The command receipts that the idempotency key points to are in SQLite (area A).
- States: issued (live); expired (idle longer than 24 h); revoked or unknown (removed)
- Transitions:
  - (none) -> issued: `issue` creates a random credential id and uses it as `requestNamespace`. Enforced at `apps/server/src/mcp/McpSessionRegistry.ts:121-164` (`124`, `130`).
  - issued -> expired: `resolve` finds the record idle beyond the window. Enforced at `apps/server/src/mcp/McpSessionRegistry.ts:166-184`.
  - expired -> issued: only `touch`, called by the server for a live run (`apps/server/src/mcp/McpSessionRegistry.ts:186-199`; caller in area A, `apps/server/src/orchestration-v2/RunExecutionService.ts:1842`).
  - issued or expired -> revoked: `revokeProviderSession`, `revokeThread`, `revokeAll` (`apps/server/src/mcp/McpSessionRegistry.ts:201-218`).
  - reuse or replace: area B reuses a credential only when it still resolves with the same thread, instance and capabilities; otherwise it revokes and issues a new one (`apps/server/src/orchestration-v2/ProviderSessionManager.ts:572-592`).
  - HTTP side: a token that does not resolve gets 401 (`apps/server/src/mcp/McpHttpServer.ts:233-285`).
- Restart: every credential is lost. A provider process that outlives the server gets 401. The next session gets a new credential id.
- Explicit or implicit: explicit for the credential (one module owns all transitions, with tests); implicit for the idempotency key, which silently depends on the credential id.
- Gaps:
  - **C-G3.1** [state lost on a crash or restart] The retry key of the MCP tools is `command:mcp:<requestNamespace>:<operation>:<clientRequestId>` (`apps/server/src/mcp/OrchestratorMcpService.ts:699-715`). `requestNamespace` is the credential id (`apps/server/src/mcp/McpSessionRegistry.ts:130`), which changes after a server restart or a credential replacement. A retry with the same `clientRequestId` then creates a second thread. The tool text promises the opposite: "After an error or lost reply, retry with the same `clientRequestId`." (`apps/server/src/mcp/toolkits/project/tools.ts:127`). **Verdict:** confirmed. Tracked: t3code-165.
    - Evidence: `P/OrchestratorMcpService.audit.probe.test.ts`, test "PROBE G1" (command C1, passed, exit 0): two `create_threads` calls with the same `clientRequestId` and scopes that differ only in the credential id return different thread ids, and the project holds 2 created threads; a replay under one credential returns the same id (control). `P/McpSessionRegistry.restart.probe.test.ts`, test "PROBE G4" (command C2, passed, exit 0): a second registry does not resolve the old token, and a credential issued again for the same thread has a different `requestNamespace`.
    - Limits of the proof: only `create_threads` ran in a probe. `delegate_task` and `t3_thread_launch` build their key from the same namespace (`apps/server/src/mcp/OrchestratorMcpService.ts:2449-2452`, `apps/server/src/mcp/toolkits/project/handlers.ts:121-123`) but did not run in a probe. The restart itself was modelled by a second registry instance.
    - Size (confirmed only): M. Effect on the user: an agent that retries a launch or delegation after a restart or a new session, as the tool text tells it to, starts the same work twice.
  - **C-G3.2** [state with no exit] An expired credential stays in memory until an explicit revoke. **Verdict:** by design.
    - Evidence: comment at `apps/server/src/mcp/McpSessionRegistry.ts:68-72` ("Keep expired records until explicit revocation"); existing tests `apps/server/src/mcp/McpSessionRegistry.test.ts:132` and `:200` (command C5, exit 0).

### C-M4. Tool exposure and deferred tool loading

- Owner: upstream
- Stored in: memory (`loaded` map per session, `apps/server/src/mcp/McpToolExposure.ts:51`)
- States (per session and tool): direct (always listed: `apps/server/src/mcp/McpToolExposure.ts:7-12`); not listed; loaded by `tool_search`
- Transitions:
  - not listed -> loaded: `search` returns at most 10 tools and announces `list_changed`. Enforced at `apps/server/src/mcp/McpToolExposure.ts:63-83`, notification at `apps/server/src/mcp/McpHttpServer.ts:1406-1416`.
  - loaded -> not listed: the session falls out of the newest 256 sessions (`apps/server/src/mcp/McpToolExposure.ts:16`, `52-61`).
  - Calls are not gated by this state (`apps/server/src/mcp/McpHttpServer.ts:1418-1422`).
- Restart: the loaded set is lost; a deferring client lists only the direct tools until it searches again.
- Explicit or implicit: explicit; one small module owns the state.
- Gaps:
  - **C-G4.1** [state lost on a crash or restart] The loaded set is lost on restart and after 256 newer sessions. **Verdict:** by design.
    - Evidence: comments at `apps/server/src/mcp/McpToolExposure.ts:15` and `apps/server/src/mcp/McpHttpServer.ts:1418-1422` ("Calls are never gated"); existing test `apps/server/src/mcp/McpHttpServer.test.ts:1686` (command C5, exit 0).

### C-M5. `request_secret` flow

- Owner: upstream
- Stored in: a `secret_request` turn item in the event stream (`secretStatus`), the secret store (outside my files, `apps/server/src/secrets/SecretRequests.ts`), and the waiting fiber in memory
- States: `pending`; `saved`; `cancelled`; `timed_out`
- Transitions:
  - (none) -> pending: `requestSecret` records the card (`apps/server/src/mcp/OrchestratorMcpService.ts:2162-2312`).
  - pending -> saved | cancelled: found by the polling loop (`apps/server/src/mcp/OrchestratorMcpService.ts:2240-2268`).
  - pending -> timed_out: time limit (`apps/server/src/mcp/OrchestratorMcpService.ts:2270-2274`); the card is closed (`2234-2238`).
- Restart: the waiting fiber is lost. Recovery in area A sets a pending card to `cancelled` (`apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts:158-159`). The secret store sweeps expired requests and files at startup (`apps/server/src/secrets/SecretRequests.ts:346-385`).
- Explicit or implicit: implicit; the card status, the store and the waiting fiber are three places that one polling loop keeps in step.
- Gaps:
  - **C-G5.1** [state lost on a crash or restart] A card could stay `pending` for ever after a restart, with no tool call waiting on it. **Verdict:** refuted.
    - Evidence: existing test `apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.test.ts:421` ("recovery closes a secret card's form but leaves a link card open"), command C6, exit 0.
  - **C-G5.2** [unguarded transition] A `timeoutMs` of zero or less could end the wait at once. **Verdict:** refuted.
    - Evidence: the contract limits the value to 1 s through 60 min (`packages/contracts/src/orchestratorMcp.ts:865-867`). This is a schema reading, not a run.

### C-M6. Thread launch and workspace preparation

- Owner: upstream
- Stored in: event stream (thread, run status `preparing`, `workspacePreparation`), command receipts in SQLite, and memory (`scheduledLaunches` and `preparationScope`, `apps/server/src/orchestration-v2/ThreadLaunchService.ts:942-955`)
- States: claimed (thread exists); run `preparing`; preparation reserved (memory); released (run starts); failed; cancelled
- Transitions:
  - (none) -> claimed: `thread.create`, or `thread.metadata.update` with `expectedEmpty` for a reused thread. Enforced at `apps/server/src/orchestration-v2/ThreadLaunchService.ts:1093-1130`.
  - claimed -> run `preparing`: the initial message is dispatched with `defer_start`. Enforced at `apps/server/src/orchestration-v2/ThreadLaunchService.ts:1140-1197`; a message without a durable run fails the launch (`1190-1196`).
  - `preparing` -> reserved: `reservePreparation` allows one preparation per command id (`apps/server/src/orchestration-v2/ThreadLaunchService.ts:942-948`); `shouldSchedule` at `1205`.
  - reserved -> released: `prepared-run.release` (`apps/server/src/orchestration-v2/ThreadLaunchService.ts:823-840`).
  - reserved -> failed: `failPreparedRun` dispatches `prepared-run.fail` when a run exists (`apps/server/src/orchestration-v2/ThreadLaunchService.ts:906-940`); with no run it only logs (`912-917`).
  - reserved -> cancelled: the run becomes `interrupted` or `cancelled` while preparation runs (`apps/server/src/orchestration-v2/ThreadLaunchService.ts:973-986`); a created worktree is removed (`857-861`).
  - failed -> `preparing`: `prepared-run.retry` then `prepareRun` (`apps/server/src/orchestration-v2/ThreadLaunchService.ts:1278-1289`; caller `apps/server/src/ws.ts:1928`, area E).
- Restart: the reservation and the preparation fiber are lost. Area A recovery moves a `preparing` run to `queued` (held) or `cancelled`. A launch with no run has nothing to recover (G6.1).
- Explicit or implicit: implicit; the durable run status and the in-memory reservation together decide who prepares, and the no-run path has no durable state at all.
- Gaps:
  - **C-G6.1** [lost information] A launch with a worktree strategy and no initial message returns success before the workspace exists. The preparation runs in a forked fiber. When it fails, the only trace is a warning log (`apps/server/src/orchestration-v2/ThreadLaunchService.ts:912-917`). The thread stays with no worktree, no run and no error item. A retry of the same launch is a replay (`shouldSchedule` at `apps/server/src/orchestration-v2/ThreadLaunchService.ts:1205` is false once the receipt exists) and prepares nothing. Both the client RPC (`apps/server/src/ws.ts:2123`, area E) and the MCP launch tool accept a launch with no message. **Verdict:** confirmed. Tracked: t3code-166.
    - Evidence: `P/ThreadLaunchService.noRun.probe.test.ts`, test "PROBE G6" (command C4, passed, exit 0). The probe waits for the log line "Thread workspace preparation failed", then asserts `worktreePath` null, 0 runs, 0 turn items, and that the retry reports `resumed: true` with no new fetch.
    - Limits of the proof: the "retry prepares nothing" assertion is checked after one `Effect.yieldNow`, so the code reading at line 1205 carries that part. The same path loses the preparation on a restart; I did not simulate the restart.
    - Size (confirmed only): S. Effect on the user: a new thread that should work in its own worktree appears normally, has no worktree, and nothing in the thread says that the setup failed.
  - **C-G6.2** [state lost on a crash or restart] A run left in `preparing` by a crash could stay there, because nothing calls `prepareRun` at startup. **Verdict:** refuted.
    - Evidence: existing test `apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.test.ts:504` ("recovers $0 work after restart", scenario `preparing`), command C6, exit 0. It asserts that the run becomes `queued` or `cancelled`. Boundary: a worktree half-created on disk before the crash belongs to area D; I did not check it.

### C-M7. `create_threads` batch

- Owner: upstream
- Stored in: event stream and command receipts (one receipt per thread and per message)
- States (per batch entry): not started; thread created; message dispatched; recorded on the parent
- Transitions:
  - Each entry runs in order with `concurrency: 1` (`apps/server/src/mcp/OrchestratorMcpService.ts:2830`, `2984`): target resolution (`2851-2862`), `thread.create` (`2879-2904`), optional `message.dispatch` (`2909-2943`), `thread.created.record` (`2946-2968`).
  - Replay: the entry key is `stableCommandId` with the entry index (`apps/server/src/mcp/OrchestratorMcpService.ts:2834-2839`); without a `clientRequestId` the key is random (`2829`).
  - An entry without a prompt returns `runId: null` and `status: "idle"` (`apps/server/src/mcp/OrchestratorMcpService.ts:2975-2976`).
- Restart: completed entries are durable; the batch position is not stored. A retry depends on the replay key (see G3.1).
- Explicit or implicit: implicit; a batch is a loop of independent commands with no batch record.
- Gaps:
  - **C-G7.1** [unguarded transition] Each entry's target is resolved inside the loop, after earlier entries were created. A batch that fails at entry N leaves entries 0..N-1 created, returns only the error, and names none of the created thread ids. Without a `clientRequestId`, a retry creates the first entries again. **Verdict:** confirmed. Tracked: t3code-167.
    - Evidence: `P/OrchestratorMcpService.audit.probe.test.ts`, test "PROBE G2" (command C1, passed, exit 0). The batch `[First, Second (unknown provider instance)]` fails with `provider_unavailable | Provider instance no-such-instance is not registered.`; one thread "First" exists; the error text does not hold its id; a retry gives two threads titled "First". The replay with a `clientRequestId` in one session is pinned by the existing test whose title is at `apps/server/src/mcp/OrchestratorMcpService.test.ts:2199` ("replays accepted creation on the $name without authorizing new disabled work"; command C5, exit 0).
    - Size (confirmed only): S. Effect on the user: one bad entry in a batch leaves threads that the calling agent does not know about, and its retry duplicates them.

### C-M8. Thread organise: settle, snooze and their reverse

- Owner: upstream
- Stored in: event stream and thread projection (`settledOverride`, `settledAt`, `snoozedUntil`, `pinnedAt`); for "settle after the run", memory only
- States: active; settled; snoozed until a time; settle promised for the end of the turn (memory)
- Transitions:
  - `t3_thread_organize` maps each action to one command with a new command id (`apps/server/src/mcp/toolkits/thread/handlers.ts:335-368`): settle `339-343`, snooze needs `snoozedUntil` `346-354`, `unsnooze` and `unsettle` `355-358`, `mark_unread` `359-361`.
  - settle by another caller -> settled: dispatched at once (`apps/server/src/orchestration-v2/ThreadManagementService.ts:1188-1206`).
  - settle by the thread's own agent during its turn -> promised: a fiber is forked in the layer scope and the call returns `{ settlesWhenTurnEnds: true }` (`apps/server/src/orchestration-v2/ThreadManagementService.ts:1197-1198`).
  - promised -> settled: `settleAfterRun` waits for the run to end, up to 24 h twice (`apps/server/src/orchestration-v2/ThreadManagementService.ts:1103-1186`, limit at `587`).
  - snoozed -> active: no timer; the read compares `snoozedUntil` with the current time (area A, `apps/server/src/orchestration-v2/ProjectionStore.ts:4347-4348`).
- Restart: settled and snoozed are durable. A promised settle is lost.
- Explicit or implicit: implicit for the promised settle (a state that exists only as a waiting fiber); the stored transitions are decided in area A.
- Gaps:
  - **C-G8.1** [state lost on a crash or restart] A settle that the thread's own agent asks for during its turn writes no event and no command receipt. The promise is one in-memory fiber. A server restart before the turn ends drops it, after the tool told the agent that the thread settles when the turn ends. **Verdict:** confirmed. Tracked: t3code-168.
    - Evidence: `P/runtimeLayer.settle.probe.test.ts`, test "PROBE G3" (command C2, passed, exit 0): after `settleThread({ byOwnAgent: true })` the result is `{ settlesWhenTurnEnds: true }`, the thread event sequence is unchanged, `hasReceipt(commandId)` is false, `settledOverride` is null and no stored event type contains "settle". The path without a restart is pinned by `apps/server/src/orchestration-v2/runtimeLayer.test.ts:6207` (command C9, exit 0) and `apps/server/src/orchestration-v2/ThreadManagementService.test.ts:573` (command C5, exit 0).
    - Limits of the proof: the restart was not simulated. The proof is that nothing durable exists to resume from. `grep -rn settlesWhenTurnEnds --include=*.test.ts apps/server/src` finds only `runtimeLayer.test.ts:6252`, so no test covers a restart.
    - Size (confirmed only): S. Effect on the user: a thread whose agent settled it stays in the active list after a restart, and nothing reports the dropped settle.

### C-M9. Scheduled task run lifecycle

- Owner: upstream
- Stored in: SQLite `scheduled_tasks` (`last_run_status`, `last_run_at`, `last_run_error`, `next_run_at`, `enabled`, `run_count`); memory (`activeRuns` reservation, `apps/server/src/scheduledTasks/ScheduledTaskService.ts:502`; the outcome follower fiber)
- States: `never`; `running`; `succeeded`; `failed`. `succeeded` means "the message was accepted", not "the run ended well" (`apps/server/src/scheduledTasks/ScheduledTaskService.ts:1100`).
- Transitions:
  - due -> `running`: the 5 s scheduler tick or `runNow` calls `runTask`; `markRunning` at `apps/server/src/scheduledTasks/ScheduledTaskService.ts:754-771`, called at `996-1010`. A task already reserved is refused (`1187-1208`). The due query skips `running` rows (`428-435`).
  - `running` -> `succeeded` | `failed`: `markCompleted` updates only a row that is still `running` with the same start time (`apps/server/src/scheduledTasks/ScheduledTaskService.ts:773-797`, guard `789-790`).
  - `succeeded` -> `failed`: the follower waits up to 24 h for the run and downgrades a run that failed or was interrupted (`apps/server/src/scheduledTasks/ScheduledTaskService.ts:877-919`; forked in the service scope at `1167-1177`).
  - `running` -> released: an error or interrupt inside `runTask` calls `releaseStuckRun` (`apps/server/src/scheduledTasks/ScheduledTaskService.ts:802-836`, hook `1181-1183`).
  - missed while the server was down: an interval task is moved to its next time (`1211-1240`); a fixed-time task is marked failed with "Missed a scheduled run because the server was not running at that time." (`1276-1282`).
  - `runNow`: refused for webhook tasks (`apps/server/src/scheduledTasks/ScheduledTaskService.ts:1692-1708`).
  - delete while running: the row is removed; the finishing run cannot write it back because of the `markCompleted` guard.
- Restart: a row left `running` is set to `failed` with "Run was interrupted by a server restart." (`apps/server/src/scheduledTasks/ScheduledTaskService.ts:1293-1344`). The reservation and the follower are lost.
- Explicit or implicit: implicit; the status column, the in-memory reservation and the follower fiber are three writers that SQL guards keep in step.
- Gaps:
  - **C-G9.1** [state lost on a crash or restart] After a restart nobody follows a run that was already dispatched. Its row reads `succeeded` for ever, even when the run later fails or is cut by that same restart. Startup recovery handles only `running` rows. **Verdict:** confirmed. Tracked: t3code-169.
    - Evidence: `P/ScheduledTaskService.restart.probe.test.ts`, test "PROBE G5" (command C3, passed, exit 0). Two builds of `ScheduledTaskService.layer` share one SQLite database. In the first, `runNow` returns `lastRunStatus: "succeeded"` and one follower starts on a run that never ends. In the second (the restarted server), the task still reads `succeeded` with no error, and the follower count stays 1. The follower itself is pinned by `apps/server/src/scheduledTasks/ScheduledTaskService.test.ts:422` (command C5, exit 0). `waitForThread` appears in no other scheduled-task test file (grep count: 1 in `ScheduledTaskService.test.ts`, 0 in the webhook, interval and schedule test files).
    - Size (confirmed only): M. Effect on the user: a scheduled run that failed after a server restart shows as succeeded in the task list.
  - **C-G9.2** [state lost on a crash or restart] A row left `running` by a crash could block the task for ever. **Verdict:** refuted.
    - Evidence: existing test `apps/server/src/scheduledTasks/ScheduledTaskService.test.ts:171` ("releases interrupted runs on startup and still executes due tasks, skipping corrupt rows"), command C5, exit 0.
  - **C-G9.3** [one state kept in two places that can disagree] The in-memory reservation and the `running` column could disagree after an interrupt. **Verdict:** refuted.
    - Evidence: existing test `apps/server/src/scheduledTasks/ScheduledTaskService.test.ts:940` ("a run interrupted right after it reserves the task does not block the next run"), command C5, exit 0.
  - **C-G9.4** [two writers] A run that finishes after its task was deleted could write the task back. **Verdict:** refuted.
    - Evidence: existing test `apps/server/src/scheduledTasks/ScheduledTaskService.test.ts:351` ("thread cleanup notifies subscribers and a finishing run cannot recreate the task"), command C5, exit 0.

### C-M10. Webhook pending deliveries

- Owner: upstream
- Stored in: SQLite `scheduled_task_webhook_pending.state` and `scheduled_task_webhook_deliveries.outcome`; memory (`pendingInFlight` set, a permit per task)
- States: `pending`; `dispatching`; `running`; `completed`; `failed`
- Transitions:
  - `pending` -> `dispatching`: the window is due (`apps/server/src/scheduledTasks/ScheduledTaskService.ts:2504`).
  - `dispatching` -> `running` -> `completed` | `failed`: one worker per task drains the rows in order (`apps/server/src/scheduledTasks/ScheduledTaskService.ts:2520-2581`); a start failure sets `failed` only from `running` (`2055-2056`).
  - `completed` | `failed` -> removed: the same loop deletes the row and, for `failed`, releases the replay key (`apps/server/src/scheduledTasks/ScheduledTaskService.ts:2533-2540`).
- Restart: rows are durable; a `running` row is retried with the prompt it was sent with (`apps/server/src/scheduledTasks/ScheduledTaskService.ts:2542-2543`).
- Explicit or implicit: implicit; the states are string literals inside SQL statements in several functions.
- Gaps:
  - none proved. I read only lines 2030-2075 and 2495-2631 of this path. Restart behaviour is pinned by existing tests that I ran: `apps/server/src/scheduledTasks/ScheduledTaskService.webhook.test.ts:1136` ("recovers a persisted coalescing window after restarting the service"), `:1318` ("restarting after a coalesced launch before pending deletion does not launch or count it twice"), `:1721` ("recovery finishes failed-window claim cleanup without counting the attempt twice"), `:916` (replay keys persisted, expire after seven days); command C7, exit 0.
  - Delivery proof (`apps/server/src/scheduledTasks/RelayDeliveryProof.ts:1-82`, read fully) holds no state: it verifies a signed proof no older than 25 hours (`:20`) and falls back to "direct request" on any failure (`:77`).

### C-M11. Scheduler tick and due hint

- Owner: upstream
- Stored in: memory
- States: source registered; source running (permit held); idle. Due hint: fresh; stale (older than 10 min or version changed)
- Transitions:
  - register -> run once after startup recovery: `apps/server/src/scheduling/Scheduler.ts:23-53` (`forkParked` at `52`).
  - tick every 5 s: `apps/server/src/scheduling/Scheduler.ts:54-57`; a source that still runs is skipped (`37`).
  - failure of a source: only logged; the next tick runs it again (`apps/server/src/scheduling/Scheduler.ts:32-36`).
  - due hint: `apps/server/src/scheduling/DueHint.ts:4` (10 min), `12-29`.
- Restart: nothing to keep; sources register again at startup.
- Explicit or implicit: explicit; both files are small and own their state.
- Gaps:
  - none found. Both files were read fully. No probe was written.

### C-M12. Delegated task question reactor (child question -> parent wake)

- Owner: upstream
- Stored in: the wake is a queued message in the event stream; the reactor's position in the event stream is in memory
- States: no question; question pending and parent woken; question delivered by a blocking wait; wake cancelled
- Transitions:
  - child `runtime-request.updated` -> parent wake (queued after the active run): `apps/server/src/orchestration-v2/DelegatedTaskQuestionReactor.ts:176-217`, wake at `34-61` with command id `server:delegated-task-question:<parentThreadId>:<requestId>` (`47`).
  - skipped when a blocking wait delivers the question: `apps/server/src/orchestration-v2/DelegatedTaskQuestionReactor.ts:206-216`.
  - catch-up when the parent run ends, only for `settled_only` tasks: `apps/server/src/orchestration-v2/DelegatedTaskQuestionReactor.ts:97-135` (`105`).
  - child terminal -> queued wakes cancelled: `apps/server/src/orchestration-v2/DelegatedTaskQuestionReactor.ts:136-175`; a failed cancel is only logged (`83-89`).
  - every failure in the handler is only logged (`219-227`).
- Restart: the reactor reads a live stream with no stored cursor (`apps/server/src/orchestration-v2/DelegatedTaskQuestionReactor.ts:230-237`). An event committed just before a crash is not replayed to it.
- Explicit or implicit: implicit; the reactor rebuilds "was the parent told" from the command id and from the wake policy.
- Gaps:
  - **C-G12.1** [state lost on a crash or restart] A child question whose event is committed just before a crash gets no parent wake, because the reactor has no cursor. **Verdict:** confirmed. Tracked: t3code-235.
    - Evidence: `P/DelegatedTaskQuestionReactor.restart.probe.test.ts`, test "PROBE G12.1: a child question committed before the reactor subscribes never wakes the parent". Command: `vp test run src/orchestration-v2/DelegatedTaskQuestionReactor.restart.probe.test.ts --reporter=verbose`. Exit code 0, 1 passed.
      - Output: `handled events: ...probe-question-rename...,event:probe-seen-question | parent wakes: message:delegated-task-question:thread:probe-question-parent:request:probe-seen`.
      - The probe commits a pending `message` question of a child whose task has `completionWake: "always"`. It then starts the subscription. The subscription never yields that event. The parent has no wake for it, and the question stays `pending`.
      - Control in the same test: a second question, committed after the subscription started, wakes the parent.
      - The probe then applies a `run.updated` (completed) event of the parent's run. The catch-up path adds no wake, because it covers only `settled_only` tasks with `live` questions (`apps/server/src/orchestration-v2/DelegatedTaskQuestionReactor.ts:97-135`).
    - Supporting test: `apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.test.ts:85` "preserves async questions across startup and shutdown". Command: `vp test run src/orchestration-v2/ProviderRuntimeRecoveryService.test.ts -t "preserves async questions across startup and shutdown" --reporter=verbose`. Exit code 0. Startup recovery keeps such a question pending and does not wake the parent.
    - Code: `streamDomainEvents` starts at the latest sequence (`apps/server/src/orchestration-v2/Orchestrator.ts:15640-15644`, comment "Start at the latest sequence; awareness needs no historical replay."). The reactor subscribes to it (`DelegatedTaskQuestionReactor.ts:230-237`).
    - Limit of the proof: the crash is modelled. The probe commits the event and does not call `reactor.handle` for it. The subscription in the probe is a copy of the body of `start` over the real stream, not a call of `start`, because `start` gives no signal per handled event. No real process restart ran. The same loss applies to a failed wake dispatch, which `handle` only logs (`:219-227`); that case was not probed.
    - Owner: upstream (`fdacb3a380`, `de34391427`). Size: M (a startup catch-up for pending child questions without a wake).
    - Effect on the user: after a restart at that moment the parent agent never learns of the question, so the question waits until the user opens the child thread.
    - First pass: Evidence: code reading only. Area A recovery changes pending requests at startup (tests at `apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.test.ts:28` and `:85` ran in C6, exit 0), but I did not check that they cover this case, and I wrote no probe because the reactor needs the full runtime layer.

### C-M13. Preview automation broker

- Owner: upstream
- Stored in: memory (`clients`, `assignments`, `pending`; `apps/server/src/mcp/PreviewAutomationBroker.ts:121-123`, state at `363-366`)
- States: host connected; host replaced; provider session assigned to a host; request pending; request answered or timed out
- Transitions:
  - connect, replace and disconnect of a host stream: `apps/server/src/mcp/PreviewAutomationBroker.ts:371-462`; a disconnect removes the host's assignments (`134-139`).
  - request -> pending -> answered | timed out: `invoke` at `apps/server/src/mcp/PreviewAutomationBroker.ts:516`; limit at `569`; wait at `660`.
- Restart: all state is lost; clients connect again.
- Explicit or implicit: explicit; one module owns the state, with 22 test definitions.
- Gaps:
  - none found. I read an outline and the cited ranges, not the whole file. Existing tests ran in C8 (exit 0), among them `apps/server/src/mcp/PreviewAutomationBroker.test.ts:426`, `:840` and `:983`.

### C-M14. Background policy leases and host power state

- Owner: upstream
- Stored in: memory (`leasesRef`, `apps/server/src/background/BackgroundPolicy.ts:198`; latest power snapshot, `apps/server/src/background/HostPowerMonitor.ts:55`)
- States: client lease active | expired (TTL 45 s default, 120 s maximum, `apps/server/src/background/BackgroundPolicy.ts:42-43`); host constrained | free | stale
- Transitions:
  - client report -> lease active: `apps/server/src/background/BackgroundPolicy.ts:215-235`.
  - lease expired -> removed: sweep every 15 s (`apps/server/src/background/BackgroundPolicy.ts:269-286`); a closed connection removes its leases (`242`).
  - power report -> snapshot: an older report is ignored (`apps/server/src/background/HostPowerMonitor.ts:58-75`).
  - host constrained: suspended, locked, thermal pressure, low power, on battery (`apps/server/src/background/BackgroundPolicy.ts:125-139`).
- Restart: all state is lost; the power state starts as unknown and stale (`apps/server/src/background/HostPowerMonitor.ts:22-36`).
- Explicit or implicit: explicit; pure functions decide from one snapshot.
- Gaps:
  - **C-G14.1** [state with no exit] A `suspended` report that is never followed by another report could hold all background work for ever. **Verdict:** refuted.
    - Evidence: the policy ignores a stale snapshot (`apps/server/src/background/BackgroundPolicy.ts:129`); existing test `apps/server/src/background/BackgroundPolicy.test.ts:225` ("does not gate work on stale host power values"), command C8, exit 0. The code that marks a snapshot stale is outside my files (`apps/server/src/resourceTelemetry/DesktopTelemetryReceiver.ts:639-658`); I did not run its tests.

### C-M15. HTML render publish

- Owner: upstream
- Stored in: a file `<attachmentsDir>/<attachmentId>.html` and a reference in `McpProviderSessions` (package `@t3tools/provider-core`, outside my files)
- States: file written; reference recorded; both removed on error
- Transitions:
  - publish: write the file, measure, record the reference (`apps/server/src/htmlRender/HtmlRender.ts:501-548`).
  - error or interrupt: remove the file and take the reference back, both with errors ignored (`apps/server/src/htmlRender/HtmlRender.ts:549-558`).
- Restart: the file stays on disk; the reference store is not in my files.
- Explicit or implicit: implicit; a two-step write with a manual undo.
- Gaps:
  - none proved. `HtmlRender` has no session state of its own. I read lines 501-602 and an outline only. Existing tests ran in C8 (exit 0).

### Area C: other points

- **C-P1** lost information: the scheduled-task outcome follower logs its own errors and drops them (`apps/server/src/scheduledTasks/ScheduledTaskService.ts:1169-1174`), and a failed startup recovery of `running` rows is only logged (`:1341-1343`). **Verdict:** confirmed for both halves (injected failures). Tracked: t3code-236.
  - Evidence: `P/ScheduledTaskService.dropped.probe.test.ts`. Command: `vp test run src/scheduledTasks/ScheduledTaskService.dropped.probe.test.ts --reporter=verbose`. Exit code 0, 2 passed.
    - Test "PROBE P1a: a follower that fails leaves a failed scheduled run recorded as succeeded". The run has status `failed`. `waitForThread` fails. Output: `warnings: ["Could not record scheduled run outcome"] | task: succeeded null`. The task keeps `lastRunStatus: "succeeded"` and no error text.
    - Test "PROBE P1b: a failed startup reset leaves a scheduled task running, and its schedule never fires in that process". A SQLite trigger refuses the reset write. Output: `after 65 seconds: {"last_run_status":"running","next_run_at":"1970-01-01T00:01:00.000Z"} | sends: 0`. The task is due at 00:01:00, the clock passes it, and nothing is dispatched. The only warning is "Could not reset interrupted schedule task runs".
    - Controls in P1b: a manual `runNow` is accepted and replaces the status; 65 seconds later the schedule fires (`sends: 2`). After the trigger is dropped, the next service start sets the row to `failed`.
  - Code: `apps/server/src/scheduledTasks/ScheduledTaskService.ts:1168-1174` and `:1341-1343`. The due filter skips `running` rows (`:1249`). The comment at `:1293` says that the reset exists because the filter "would otherwise skip [them] forever".
  - Limit of the proof: both failures are injected (a failing mock and a trigger). P1b proves 65 seconds past the due time, not "forever"; the SQL filter is the reason it continues. `listRows` and the UI were not probed. `runNow` does not refuse such a row; my first draft of the probe assumed a refusal and failed on it.
  - Owner: upstream (`5c0eb5124e` for the follower, `de34391427` for the reset). Size: S.
  - Effect on the user: a scheduled run that failed can stay shown as succeeded, and a task can stay "running" and skip its schedule until a manual run or the next restart.
  - First pass: Evidence: code reading only; not probed.
- **C-P2** lost information: `stopDelegatedTasks` returns only the first failure when several children fail to stop (`apps/server/src/orchestration-v2/ThreadManagementService.ts:1538-1607`). **Verdict:** confirmed as described. The harm is low, because each failure is logged. Tracked: t3code-239.
  - Evidence: `P/ThreadStop.firstFailure.probe.test.ts`, test "PROBE P2: with two delegated tasks that cannot be stopped, the walk returns the first failure only and logs both". Command: `vp test run src/orchestration-v2/ThreadStop.firstFailure.probe.test.ts --reporter=verbose`. Exit code 0, 1 passed. Output: `returned names a: true | names b: false | stop warnings: 2`. The stoppable sibling ends `interrupted`.
  - Related intent: `apps/server/src/orchestration-v2/ThreadStop.test.ts:1269` "a delegated task that cannot be stopped fails the walk after its siblings stop". Command: `vp test run src/orchestration-v2/ThreadStop.test.ts -t "a delegated task that cannot be stopped fails the walk after its siblings stop" --reporter=verbose`. Exit code 0. This name states that the walk continues and then fails. It does not state that one error is enough.
  - Code: `apps/server/src/orchestration-v2/ThreadManagementService.ts:1606`.
  - Limit of the proof: both failures are children whose threads do not exist. The remote branch (`:1552-1580`) did not run. What the callers do with the one error (`EffectWorker.ts:613-630`, `OrchestratorMcpService.ts:2686` and `:3292`) was not probed.
  - Owner: upstream (`312a12d726` on the cited line). Size: S.
  - Effect on the user: none seen in the probe; the returned error names one child, and the log names each child.
  - First pass: Evidence: code reading only; not probed.
- **C-P3** lost information: thread launch cleanup ignores a failed `:cancel-workspace` update and only logs a failed worktree removal (`apps/server/src/orchestration-v2/ThreadLaunchService.ts:881-898`). **Verdict:** confirmed for the ignored update (injected failure). By design for the failed worktree removal. Tracked: t3code-239.
  - Evidence: `P/ThreadLaunchService.cancelWorkspace.probe.test.ts`. Command: `vp test run src/orchestration-v2/ThreadLaunchService.cancelWorkspace.probe.test.ts --reporter=verbose`. Exit code 0, 2 passed.
    - Test "PROBE P3: a cancelled launch removes its worktree, and a failed cancel-workspace update leaves the thread on the removed path". Output: `thread after cancel: /repo-worktrees/feature t3/<id> | run: failed | turn items: user_message,command_execution,error`. The probe asserts that `removeWorktree` got the thread's path, that the dispatch `launch:probe-p3:cancel-workspace` failed, and that the thread keeps `worktreePath` and `branch`. This is the wrong behaviour.
    - Test "PROBE P3b: a failed worktree removal keeps the thread on its worktree and sends no cancel-workspace update". The removal fails. No branch delete runs and no update is sent. The thread keeps its path. The intent is the comment at `apps/server/src/orchestration-v2/ThreadLaunchService.ts:865`: "Forget worktrees only after removal succeeds; failed removals must not reuse partially written checkouts."
  - Control: existing test `apps/server/src/orchestration-v2/ThreadLaunchService.test.ts:2292` "cancels tracked setup before provider work is released". Command: `vp test run src/orchestration-v2/ThreadLaunchService.test.ts -t "cancels tracked setup before provider work is released" --reporter=verbose`. Exit code 0. With a working update the thread's `worktreePath` becomes null.
  - Code: `apps/server/src/orchestration-v2/ThreadLaunchService.ts:881-889` (`Effect.ignore` on the update).
  - Limit of the proof: the update failure is injected by a wrapper that fails each dispatch whose command id ends with `:cancel-workspace`. I found no real cause other than a store error or a rejected command. The probe does not show what a later run in that thread does. The harness mock counts a `deleteLocalBranch` call when the pipeline is built, so the P3 assertion on that count is weak; P3b records the run itself.
  - Owner: upstream (`737993303d`, `c3c15f7d36`). Size: S.
  - Effect on the user: after such a failure the thread still names a worktree path and a branch that the cleanup removed.
  - First pass: Evidence: code reading only; not probed.
- **C-P4** untested state: a restart with a dispatched scheduled run (G9.1), a restart with a promised settle (G8.1), a failed preparation of a launch with no run (G6.1), and a retry key across two credentials (G3.1) have no test. **Verdict:** confirmed for the absence of a test that would fail. Tracked: t3code-165, t3code-166, t3code-168 and t3code-169.
  - Evidence: the four probes pass on HEAD while they assert the wrong behaviour (commands C1 to C4), and the greps named under G8.1 and G9.1; `grep -rn "Thread workspace preparation failed" --include=*.ts apps/server/src` finds only `ThreadLaunchService.ts:913`.
- **C-P5** wait without limit: none found in the files that I read. The longest limits are 24 h (settle after run, twice; scheduled run follower; MCP credential liveness). See M2. **Verdict:** no verdict of its own; see the gap it names.
- **C-P6** `thread` CLI: the fork changed `apps/server/src/cli/thread.ts` (81 lines). I read the diff. The command is a client of the MCP tools and holds no server state. **Verdict:** no verdict of its own; see the gap it names.
- **C-P7** Thread organise commands use a new command id on each call (`apps/server/src/mcp/toolkits/thread/handlers.ts:335-368`), so a retried call is a second command. **Verdict:** refuted as a harm. A repeated settle changes nothing. A repeated snooze restamps the snooze by design.
  - Evidence: `P/Orchestrator.organizeRepeat.probe.test.ts`, test "PROBE P7: a repeated settle changes nothing, and a repeated snooze keeps the wake time and restamps snoozedAt". Command: `vp test run src/orchestration-v2/Orchestrator.organizeRepeat.probe.test.ts --reporter=verbose`. Exit code 0, 1 passed.
    - Output: `second snooze events: thread.snoozed | changed shell keys: updatedAt,snoozedAt | effects of first/second snooze: [] []`.
    - Output: `second settle events: thread.settled | changed shell keys:  | effects of first/second settle: [] []`.
    - The second settle commits one `thread.settled` event and the thread shell is equal. The second snooze commits one `thread.snoozed` event; `snoozedUntil` is equal, and only `snoozedAt` and `updatedAt` change. Neither call adds an outbox effect.
  - Intent for snooze: comment at `apps/server/src/orchestration-v2/Orchestrator.ts:4262`, "Re-snoozing acknowledges the latest wake even at the same time; commandId deduplicates retries."
  - Supporting test: `apps/server/src/orchestration-v2/Orchestrator.control-reads.test.ts:1891` "explicit settle clears snooze atomically and stays idempotent after re-snoozing". Command: `vp test run src/orchestration-v2/Orchestrator.control-reads.test.ts -t "explicit settle clears snooze atomically and stays idempotent after re-snoozing" --reporter=verbose`. Exit code 0.
  - Limit of the proof: the probe dispatches to the orchestrator. The MCP handler (`apps/server/src/mcp/toolkits/thread/handlers.ts:335-368`) and `settleThread` with `byOwnAgent` (`ThreadManagementService.ts:1188-1206`) did not run. The thread had no pull request link, no pin and no run. The other actions (`unsnooze`, `unsettle`, `pin`, `mark_unread`) were not probed. The comment says that the command id deduplicates retries; the handler makes a new id per call, so that deduplication does not apply to an MCP retry.
  - First pass: Evidence: code reading only; whether a second `settle` or `snooze` is harmless is decided in area A.

## Area D: Git, worktrees, pull requests and the fork scripts

### Area D: evidence conventions

Conventions for this report:

- HEAD is `22b65998f3a59040f83b8812d7500054b40366fd` (equal to `origin/fork`). `origin/main` is `95cb068c10a6cf0b33eed0a0cab3b298763fe852`.
- `$P` is `<archive>/probes/D`.
- `$R` is `<repo>/`.
- Each `*.probe.test.ts` ran beside the code it tests, from `$R/apps/server`, with `vp test run <path>`. The path beside the code is given with each probe. Each file was then moved to `$P`.
- Every vitest probe PASSES WHILE IT ASSERTS THE WRONG BEHAVIOUR (the assertion states the gap). The two shell probes print the states they reach and exit 0.
- The output of each existing test run is in `$P/existing-tests.log`.
- Owner `upstream` means `git diff origin/main...origin/fork` does not touch the lines.

Second pass:

Scope: a verdict for each gap that had `no verdict`. HEAD `22b65998f3`. No tracked file changed.
`$P` = `<archive>/probes/D`.
`$R` = `<repo>/`.
Every `vp test run` command ran from `$R/apps/server`. Each probe ran beside the code under the stated path and then moved to `$P`.
Owner check: `git diff origin/main...origin/fork --stat -- <file>` and `git blame` plus `git merge-base --is-ancestor <commit> origin/main`.
The entries are in order of harm to a user, worst first.

### D-M1. Pull request watch on a thread link (`watch`, `endedWatch`, `watchRecord`)

- Owner: both. Upstream owns `watch` and `endedWatch`. The fork added `watchRecord`, the end reasons and the skip reasons (`packages/contracts/src/threadPullRequest.ts:110-148`, `:163`).
- Stored in: event stream; SQLite `orchestration_v2_projection_threads.payload_json`, path `$.pullRequests[].watch`, `.endedWatch`, `.watchRecord`.
- States: not watched; watching; watching with an open skip note (`watchRecord.skipped` without `resumedAt`); ended (no `watch`; `endedWatch` kept; `watchRecord.ended.reason` is one of `merged`, `closed`, `unreadable`, `comment-limit`, `settled`, `subagent`, `archived`, `unwatched`, `unlinked`, `stopped`).
- Transitions:
  - not watched -> watching: the `watch_pull_request` tool. Enforced at `apps/server/src/mcp/toolkits/pullRequests/handlers.ts:265-304` and the start guards at `apps/server/src/orchestration-v2/Orchestrator.ts:3787-3846` (Area A).
  - watching -> watching (new facts): the reactor dispatches `thread.pull-request-watch.sync` at `apps/server/src/orchestration-v2/PullRequestWatchReactor.ts:308`. The orchestrator rejects it when the watch was replaced, or when it carries a wake for an inactive thread: `apps/server/src/orchestration-v2/Orchestrator.ts:3596`.
  - watching -> ended (`merged`, `closed`, `comment-limit`): `apps/server/src/orchestration-v2/pullRequestWatch.ts:38-211` decides; the reducer writes through `withPullRequestWatch`, `apps/server/src/orchestration-v2/Orchestrator.ts:774-793`.
  - watching -> ended (`unreadable`): `giveUp`, `apps/server/src/orchestration-v2/PullRequestWatchReactor.ts:324-339`.
  - watching -> ended (`archived`): `apps/server/src/orchestration-v2/Orchestrator.ts:4222`. Settle and stop end the watch in the same reducer (Area A).
  - ended -> watching: a new watch resumes from `endedWatch`; `apps/server/src/orchestration-v2/Orchestrator.ts:774-793`.
- Restart: every state is durable. The reactor's view of it is not (see M2).
- Explicit or implicit: explicit. One reducer in the orchestrator owns each write, and the end reason is a closed list.
- Gaps:
  - **D-G1.1** [one state kept in two places] The reader of this state decodes all threads in one `Effect.forEach` (`apps/server/src/orchestration-v2/ProjectionStore.ts:7143`). One thread row that this build cannot decode makes `getThreadsWithPullRequests()` fail for every thread. The watch sweep then reads nothing and only logs `pull request watch sweep failed` (`apps/server/src/orchestration-v2/PullRequestWatchReactor.ts:673`, `:774-777`). The fork's `watchRecord` literals make this reachable by a downgrade to a build with fewer literals, or by a corrupt row. **Verdict:** confirmed. Tracked: t3code-170.
    - Evidence: probe `$P/ProjectionStore.pullRequests.probe.test.ts`, run as `apps/server/src/orchestration-v2/ProjectionStore.pullRequests.probe.test.ts`; command `vp test run src/orchestration-v2/ProjectionStore.pullRequests.probe.test.ts`; result 1 passed, exit 0. Two threads with links; one row gets an end reason this build does not know; the unfiltered read fails as a whole, and the read filtered to the healthy thread still succeeds.
    - Size (confirmed only): M. Effect on the user: every pull request watch and pull request sync on the server stops with no message in any thread, until someone repairs the row. Owner: upstream (the reader); the fork added the literals that can differ between builds.
  - **D-G1.2** [unguarded transition] A duplicate link could reset a watch. **Verdict:** refuted.
    - Evidence: `apps/server/src/mcp/toolkits/pullRequests/handlers.test.ts:489` "treats a duplicate link as alreadyLinked rather than an error"; command `vp test run src/mcp/toolkits/pullRequests/handlers.test.ts`; 23 passed, exit 0. The reducer returns the thread unchanged at `apps/server/src/orchestration-v2/Orchestrator.ts:4442`.
  - **D-G1.3** [state with no exit] An archived thread could keep a watch that sweeps still read. **Verdict:** refuted.
    - Evidence: `apps/server/src/orchestration-v2/ProjectionSettlement.test.ts:431` "sql: lists only active threads with pull request links, oldest first"; command `vp test run src/orchestration-v2/ProjectionSettlement.test.ts -t "lists only active threads with pull request links"`; 1 passed, exit 0. The SQL filter is at `apps/server/src/orchestration-v2/ProjectionStore.ts:7138-7140`.

### D-M2. Watch reactor read state (failure count, last read, skip note)

- Owner: both. The count is upstream. The fork added the skip notes and changed `giveUp` (`git diff -U0 origin/main...origin/fork` hunks at new lines 326-337, 576, 580, 585-586).
- Stored in: memory, in `apps/server/src/orchestration-v2/PullRequestWatchReactor.ts`: `readFailures` (`:260`), `lastReads` (`:265`), `lives` (`:212`). The skip note is durable (`watchRecord.skipped`, M1).
- States (for one pull request group): never read; read (fingerprint kept); failing, n of 8; paused by rate limit; kept after a `failed` read; given up.
- Transitions:
  - any -> failing n+1: a read fails with a reason other than `rate-limited` and `failed`. Enforced at `apps/server/src/orchestration-v2/PullRequestWatchReactor.ts:583-585`.
  - failing 7 -> given up: the eighth failure (`READ_FAILURE_LIMIT = 8`, `:50`). Enforced at `:586`.
  - any -> kept: reason `failed` clears the count. Enforced at `:578-582`.
  - any -> paused: reason `rate-limited`. Enforced at `:576`.
  - failing -> read: a good read clears the count. Enforced at `:589`.
- Restart: the count, the last-read fingerprints and `lives` are lost. Each `make` starts from zero.
- Explicit or implicit: implicit. The state is three maps and a counter; no type names the states.
- Gaps:
  - **D-G2.1** [state lost on restart] The failure count lives in memory only. A restart sets it to zero, so the limit of eight reads (16 minutes at the 2-minute sweep, `:49`) starts again. **Verdict:** confirmed. Tracked: t3code-171.
    - Evidence: probe `$P/PullRequestWatchReactor.probe.test.ts`, run as `apps/server/src/orchestration-v2/PullRequestWatchReactor.probe.test.ts`; command `vp test run src/orchestration-v2/PullRequestWatchReactor.probe.test.ts`; 4 passed, exit 0. Test "a restart resets the count: fourteen not-found reads in a row end nothing" (7 sweeps, a new `make`, 7 sweeps, no give-up). Test "baseline: eight not-found reads in one boot end the watch with a wake" is the control.
    - Size (confirmed only): S. Effect on the user: a watch on a pull request that no longer exists stays "watching" for 16 more minutes after each restart, and never ends on a server that restarts more often than that. Owner: upstream.
  - **D-G2.2** [state with no exit] Reason `failed` never ends a watch. **Verdict:** by design.
    - Evidence: comment at `apps/server/src/orchestration-v2/PullRequestWatchReactor.ts:577` ("Transport and host failures can outlast the failure limit; keep the watch for recovery."). Existing test `apps/server/src/orchestration-v2/runtimeLayer.test.ts:3784` "handles repeated host read failures"; command `vp test run src/orchestration-v2/runtimeLayer.test.ts -t "handles repeated host read failures"`; 5 passed, exit 0. Probe test "reason failed never ends the watch: forty reads in one boot end nothing" in the same probe file.

### D-M3. Thread-to-pull-request link and snapshot sync

- Owner: upstream (`PullRequestSyncReactor.ts` and `ThreadPullRequestService.ts` are not in the fork diff).
- Stored in: SQLite thread payload `$.pullRequests[]` (`source`, `snapshot`, `stack`); memory in `apps/server/src/orchestration-v2/PullRequestSyncReactor.ts` (`closeCommands`, `:648`) and in `apps/server/src/orchestration-v2/ThreadPullRequestService.ts` (`pendingBackfill`, `:123`).
- States: not linked; linked without snapshot; linked with snapshot; backfill pending, attempt n of 5 (`BACKFILL_ATTEMPTS`, `apps/server/src/orchestration-v2/ThreadPullRequestService.ts:105`); unlinked.
- Transitions:
  - not linked -> linked: `link_pull_request`, `apps/server/src/mcp/toolkits/pullRequests/handlers.ts:364-396`; reducer at `apps/server/src/orchestration-v2/Orchestrator.ts:4430-4532`.
  - linked -> unlinked: `unlink_pull_request`, `apps/server/src/mcp/toolkits/pullRequests/handlers.ts:446-483`.
  - snapshot refresh: the sync sweep, `apps/server/src/orchestration-v2/PullRequestSyncReactor.ts:385-638`; on demand through `requestSync`, `:772-778`.
  - branch discovery and backfill: `synchronize`, `apps/server/src/orchestration-v2/ThreadPullRequestService.ts:142-375`.
- Restart: links and snapshots are durable. `closeCommands` and `pendingBackfill` are lost.
- Explicit or implicit: the link is explicit (one reducer). The sync and backfill progress is implicit (maps in memory).
- Gaps:
  - **D-G3.1** [state lost on restart] A restart loses `pendingBackfill`, so a backfill in progress may not continue. **Verdict:** refuted.
    - Evidence: probe `$P/ThreadPullRequestService.restartBackfill.probe.test.ts`, run as `apps/server/src/orchestration-v2/ThreadPullRequestService.restartBackfill.probe.test.ts`; command `vp test run src/orchestration-v2/ThreadPullRequestService.restartBackfill.probe.test.ts`; 1 passed, exit 0. Test "G3.1: a new process looks up a settled thread again after the old process failed its lookups". Process 1 fails one lookup and stops. Process 2 makes 5 lookups (`BACKFILL_ATTEMPTS`) and stops. Process 3 makes a new lookup for the same settled thread.
    - Existing test: `apps/server/src/orchestration-v2/ThreadPullRequestService.test.ts:344` "looks up a branch whose worktree is $worktree in $cwd" (a settled thread gets a lookup at start); command `vp test run src/orchestration-v2/ThreadPullRequestService.test.ts -t "looks up a branch whose worktree is"`; 4 passed, exit 0.
    - Reason: `start` queues a backfill sweep on every start (`ThreadPullRequestService.ts:438`), and the sweep fills the map again from the stored snapshot (`:157-165`).
    - Limit of the proof: each process is one `ThreadPullRequestService.make` on shared mocks, not a real restart. A restart resets the count to 5, so a host that stays down gets 5 more lookups for each such thread after each restart; I did not measure that cost on a large database.
    - First pass: Evidence: I read both files in full and ran their tests (`vp test run src/orchestration-v2/ThreadPullRequestService.test.ts`, 16 passed, exit 0; `vp test run src/orchestration-v2/PullRequestSyncReactor.test.ts`, 57 passed, exit 0). I wrote no probe that rebuilds the service in the middle of a backfill. I did not check whether `start` (`apps/server/src/orchestration-v2/ThreadPullRequestService.ts:432-449`) covers it.

### D-M4. Pull request read cache

- Owner: upstream.
- Stored in: memory flag `enabled` (`apps/server/src/pullRequest/PullRequestReadCache.ts:90`); a key-value store with entries and a `revisions` key.
- States: enabled; disabled. For an entry: fresh (60 s, `:126`); expired; invalidated by a scope revision.
- Transitions:
  - fresh -> invalidated: `invalidate` raises the scope revision, `:181-201`.
  - fresh -> expired: age above 60 s, checked in `get`, `:149-180`.
  - enabled -> disabled: one failed write of the revisions during `invalidate`. Enforced at `:193-196`.
  - disabled -> enabled: none.
- Restart: `enabled` is true again. I did not prove what happens to stored entries.
- Explicit or implicit: implicit. One boolean, with no way back.
- Gaps:
  - **D-G4.1** [state with no exit] After one failed revision write the cache stays off until the server restarts. Later good invalidations do not turn it on. The only trace is one warning, "PR cache disabled after clearing failed". **Verdict:** confirmed. Tracked: t3code-172.
    - Evidence: probe `$P/PullRequestReadCache.probe.test.ts`, run as `apps/server/src/pullRequest/PullRequestReadCache.probe.test.ts`; command `vp test run src/pullRequest/PullRequestReadCache.probe.test.ts`; 1 passed, exit 0. After the failed write every read calls the lookup again, also after a later good `invalidate`. Contrast: the read side recovers, `apps/server/src/pullRequest/PullRequestReadCache.test.ts:174` "resumes caching after a failed scope read" (`vp test run src/pullRequest/PullRequestReadCache.test.ts`, 12 passed, exit 0).
    - Size (confirmed only): S. Effect on the user: after one disk error every pull request read goes to the host until the next restart, which is slower and uses the host's rate limit.
  - **D-G4.2** [cache staleness] Entries written before a restart may be served for up to 60 s after it. **Verdict:** by design. A restart adds no staleness.
    - Stated intent: test name `apps/server/src/pullRequest/PullRequestReadCache.test.ts:76` "invalidates only the changed scope across restarts and coalesces its next reads"; comment `apps/server/src/pullRequest/PullRequestReadCache.ts:206` "The persisted cache drops an expired entry only when it is read again".
    - Evidence: probe `$P/PullRequestReadCache.restart.probe.test.ts`, run as `apps/server/src/pullRequest/PullRequestReadCache.restart.probe.test.ts`; command `vp test run src/pullRequest/PullRequestReadCache.restart.probe.test.ts`; 1 passed, exit 0. Test "G4.2: a restarted cache serves an entry until 60 s after its write, not 60 s after the restart". Existing test: `vp test run src/pullRequest/PullRequestReadCache.test.ts -t "invalidates only the changed scope across restarts"`; 1 passed, exit 0.
    - Correction to the first pass: the limit is 60 s after the write, not 60 s after the restart. The entry stores an absolute `expiresAt` (`PullRequestReadCache.ts:126`).
    - Limit of the proof: a restart is a second `make` on the same folder with a `TestClock`. A wall clock that jumps back between two real processes was not probed.
    - First pass: Evidence: reading only (`:126`, `:209-235`). No probe written.

### D-M5. Worktree creation and setup for a new thread

- Owner: upstream for the tracker and the runner. The fork changed `ThreadLaunchService.ts` (51 lines, Area A's file) and added `apps/server/src/vcs/defaultBaseRef.ts`.
- Stored in: memory (`apps/server/src/project/WorktreeSetupTracker.ts`; the finished entry stays 30 s, `:75`); the thread's `worktreePath` and `branch` (event stream, SQLite); the git worktree on disk; the setup terminal.
- States: reserved; fetch; checkout; workspace recorded; setup script running; done; failed; cancelled.
- Transitions:
  - reserved -> fetch -> checkout: `prepareInBackground`, `apps/server/src/orchestration-v2/ThreadLaunchService.ts:453`; the tracker starts at `:479`; `begin` is `apps/server/src/project/WorktreeSetupTracker.ts:145`.
  - checkout -> workspace recorded: `apps/server/src/orchestration-v2/ThreadLaunchService.ts:640`, after the worktree claim at `:609`.
  - workspace recorded -> setup script running: `:754`; a synchronous setup waits at `:811`.
  - setup script running -> done: `markUncancellable` at `:821`, run release from `:823`, `finish(threadId, "done")` at `:843`.
  - any -> failed or cancelled: `Effect.onError` at `:845`. The worktree is removed only when the condition at `:857-861` holds (cancelled before the run was released, or the workspace was never recorded); removal at `:866`.
  - cancel: `apps/server/src/project/WorktreeSetupTracker.ts:283`.
- Restart: the tracker is empty. The thread keeps its `worktreePath` if it was recorded. I did not prove what happens to a prepared run that was not released (Area A).
- Explicit or implicit: implicit. The stage is spread over a tracker in memory, three local booleans in one function, and the thread record.
- Gaps:
  - **D-G5.1** [state lost on restart] A server stop during preparation leaves a worktree on disk and a thread whose setup stage is unknown. **Verdict:** confirmed for the worktree. The run state is correct (the run becomes `cancelled`). Tracked: t3code-249.
    - Evidence: probe `$P/ThreadLaunchService.restart.probe.test.ts`, run as `apps/server/src/orchestration-v2/ThreadLaunchService.restart.probe.test.ts`; command `vp test run src/orchestration-v2/ThreadLaunchService.restart.probe.test.ts`; 2 passed, exit 0.
      - Test "G5.1: process loss during the setup script: the new boot cancels the run, keeps the worktree path, removes nothing, knows no setup stage, and offers no retry". The thread keeps `worktreePath`. `removeWorktree` has 0 calls in both boots. The new boot runs no setup. The setup tracker returns null. `retryPreparation` fails.
      - Test "G5.1: process loss during the checkout: the new boot cancels the run and the claimed worktree stays with no thread". `worktreePath` is null. `removeWorktree` and `deleteLocalBranch` have 0 calls.
    - Contrast, existing tests: an in-process cancel does clean up. `apps/server/src/orchestration-v2/ThreadLaunchService.test.ts:2292` "cancels tracked setup before provider work is released" and `:2334` "deletes a claimed worktree's branch when setup is cancelled before checkout returns"; command `vp test run src/orchestration-v2/ThreadLaunchService.test.ts -t "cancels tracked setup before provider work is released|deletes a claimed worktree's branch when setup is cancelled before checkout returns"`; 2 passed, exit 0. The run state after a restart: `apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.test.ts:504` "recovers preparing work after restart"; command `vp test run src/orchestration-v2/ProviderRuntimeRecoveryService.test.ts -t "recovers preparing work after restart"`; 1 passed, exit 0.
    - Cause: start-up recovery cancels a `preparing` run (`apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts:84-93`) and does nothing for its worktree. The cleanup lives only in the preparation fiber (`apps/server/src/orchestration-v2/ThreadLaunchService.ts:857-861`). The retry accepts only a `failed` run (`apps/server/src/orchestration-v2/Orchestrator.ts:11152`).
    - Limit of the proof: the probe copies the database (`VACUUM INTO`) and builds a second service graph; it does not kill a process. Git and the setup runner are mocks. The probe does not send the next message on the thread. The probe asserts only that the retry fails, not its reason.
    - Owner: upstream (the fork diff of `ThreadLaunchService.ts` is 51 lines at `:22`, `:48`, `:52`, `:221`, `:259`, `:426`, `:1335`, none in the preparation or cleanup code; `ProviderRuntimeRecoveryService.ts` has no fork diff). Size: M.
    - Effect on the user: after a server stop during worktree setup, the thread keeps a worktree whose setup script did not end, with no notice and no retry; or a half-made worktree stays on disk with no thread.
    - First pass: Evidence: I read `apps/server/src/orchestration-v2/ThreadLaunchService.ts:440-948` and both tracker files, and ran `vp test run src/project/WorktreeSetupTracker.test.ts` (5 passed, exit 0). I wrote no probe: the recovery of a prepared run is in Area A's files.
  - **D-G5.2** [state with no exit] A failed removal of an abandoned worktree is only logged (`apps/server/src/orchestration-v2/ThreadLaunchService.ts:891`). The worktree then has no thread. **Verdict:** by design (for what happens to it later).
    - Evidence: storage cleanup reports such a worktree as "No thread uses this worktree" after one hour and keeps its files (`apps/server/src/storageCleanup.ts:517`, `:533-535`). Tests `apps/server/src/storageCleanup.test.ts:1808` ("reports linked worktrees nested deeper inside a plain folder", assertion at `:1833`) and `:1784` ("reports ordinary folders with an honest reason and keeps their files") pin this; command `vp test run src/storageCleanup.test.ts`; 196 passed, 1 skipped, exit 0. I did not probe the failed removal itself.

### D-M6. Setup markers of `scripts/setup-worktree.ts`

- Owner: upstream. The fork changed only the installer command and removed the pnpm store check (`git diff origin/main...origin/fork -- scripts/setup-worktree.ts`); the marker lines are unchanged.
- Stored in: files `<worktree>/.t3/setup-running` (holds the PID), `.t3/setup-done`, `.t3/setup-failed`. Only agents read them, by the rule at `AGENTS.md:81`; no server code reads them (`grep -rn "setup-running"` finds only `AGENTS.md` and the script).
- States: no marker; running (PID); done; failed.
- Transitions:
  - any -> running: start of the script removes `done` and `failed` and writes the PID. Enforced at `scripts/setup-worktree.ts:17-20`.
  - running -> done or failed: the `exit` handler. Enforced at `scripts/setup-worktree.ts:25-29`.
  - running -> failed on SIGINT, SIGTERM or SIGHUP: `scripts/setup-worktree.ts:36-42` and `:70-75`.
- Restart: the files stay as the last writer left them.
- Explicit or implicit: implicit. Three files, written without a lock or an owner check.
- Gaps:
  - **D-G6.1** [state lost on a crash] SIGKILL (or a power loss) during the install leaves `setup-running` with a dead PID and no end marker. `AGENTS.md:81` gives a rule for a live PID and for no marker at all, and none for this state. **Verdict:** confirmed. Tracked: t3code-173.
    - Evidence: probe `$P/setup-worktree/probe.sh`; command `$P/setup-worktree/probe.sh $R "$(command -v bun)"`; exit 0. Case A prints `setup-running=present(<pid>) setup-done=absent setup-failed=absent` and "pid in setup-running alive: no". The probe copies the script into a temporary tree and puts a fake `bun` on `PATH`.
    - Size (confirmed only): S. Effect on the user: an agent that starts in that worktree finds a state its instructions do not cover, and may wait or work without `node_modules`.
  - **D-G6.2** [two writers] Two runs in one worktree share the three files. The first run to end removes `setup-running` and writes `setup-done` while the second install still writes `node_modules`. **Verdict:** confirmed. Tracked: t3code-173.
    - Evidence: same probe, Case B. While both run: `setup-running=present(<pid of run 2>)`. After run 1 ends and while run 2's installer is alive: `setup-running=absent setup-done=present()`.
    - Size (confirmed only): S. Effect on the user: an agent reads "setup done" and starts checks while an install is still in progress.
  - **D-G6.3** [state with no exit] A cancelled setup could leave no marker. **Verdict:** refuted.
    - Evidence: same probe, Case C: after SIGTERM the script exits within 0.5 s with `setup-failed` present; its text starts "Setup exited with code 1." and "Cancelled by SI" (the probe prints it cut short). The intent is the comment at `scripts/setup-worktree.ts:30-33`. Limit of the probe: the fake installer dies at once on the signal.

### D-M7. Workspace lease

- Owner: upstream.
- Stored in: memory, a module-level map keyed by the exact `cwd` string (`apps/server/src/workspace/workspaceLease.ts:4`, `:11`).
- States (for one key): free; held; held with waiters.
- Transitions:
  - free -> held, held -> free: `withWorkspaceLease`. Callers: `apps/server/src/storageCleanup.ts:1312` (key from `path.resolve`, `:990`), `apps/server/src/orchestration-v2/ProviderTurnStartService.ts:1878` (`path.resolve`), `apps/server/src/terminal/Manager.ts:2977` (`path.resolve`), `apps/server/src/git/GitWorkflowService.ts:186` (`realPath`; comment at `:182`).
- Restart: all leases are gone; nothing else holds them.
- Explicit or implicit: implicit. The key is whatever string each caller builds.
- Gaps:
  - **D-G7.1** [two writers] Callers build the key in two ways: `path.resolve` and `realPath`. For a checkout reached through a symbolic link the two keys differ, so a git workflow and a worktree removal (or a turn start) can run on the same checkout at the same time. **Verdict:** confirmed. Tracked: t3code-174.
    - Evidence: probe `$P/workspaceLease.probe.test.ts`, run as `apps/server/src/workspace/workspaceLease.probe.test.ts`; command `vp test run src/workspace/workspaceLease.probe.test.ts`; 1 passed, exit 0. The lease under the `realPath` key enters while the lease under the `path.resolve` key is held; the control with one key waits. Limit: the gap needs a path with a symbolic link. On this Mac `~/.t3` and `~/.t3/worktrees` are real directories (`ls -ld`), so the owner's default setup does not reach it. The code expects such paths elsewhere: `apps/server/src/git/GitWorkflowService.ts:182`, and the branch sync test maps `/link/worktree` to `/worktree` (`apps/server/src/orchestration-v2/WorktreeBranchSync.test.ts:20`).
    - Size (confirmed only): S. Effect on the user: with a linked T3 home, storage cleanup can remove a worktree while a commit or push runs in it.

### D-M8. Worktree branch sync

- Owner: upstream.
- Stored in: the thread's `branch` and `worktreePath` (event stream, SQLite); the checkout's HEAD on disk.
- States: thread branch equals checkout branch; they differ.
- Transitions:
  - differ -> equal: a branch change from the status broadcaster starts `reconcile` (`apps/server/src/orchestration-v2/WorktreeBranchSync.ts:19-67`). It reads the branch again before it dispatches (`:46`), and the command carries the expected branch and path (`:48-56`). A rejected command is only logged (`:58`). The listener is one parked stream (`:74`) with a catch for each item (`:77`).
- Restart: the listener starts again. I did not prove whether a branch changed while the server was stopped is reconciled.
- Explicit or implicit: implicit, but the write is guarded by expected values.
- Gaps:
  - **D-G8.1** [unguarded transition] A late event could overwrite a newer branch. **Verdict:** refuted.
    - Evidence: `apps/server/src/orchestration-v2/WorktreeBranchSync.test.ts:20` "reconciles shared worktree branches without changing root checkouts or detached HEADs, conflict=%s"; command `vp test run src/orchestration-v2/WorktreeBranchSync.test.ts`; 2 passed, exit 0.
  - **D-G8.2** [state lost on restart] A branch change made while the server is stopped. **Verdict:** refuted, with one limit.
    - Evidence: probe `$P/VcsStatusBroadcaster.firstRead.probe.test.ts`, run as `apps/server/src/vcs/VcsStatusBroadcaster.firstRead.probe.test.ts`; command `vp test run src/vcs/VcsStatusBroadcaster.firstRead.probe.test.ts`; 1 passed, exit 0. Test "G8.2: the first status read of a checkout after a start publishes its branch, with no earlier value to compare". A new broadcaster publishes nothing before a read. Its first `getStatus` publishes `{ cwd, refName }`.
    - Second half, existing test: a published branch that differs from the thread's stored branch updates the thread. `apps/server/src/orchestration-v2/WorktreeBranchSync.test.ts:20` "reconciles shared worktree branches without changing root checkouts or detached HEADs, conflict=%s"; command `vp test run src/orchestration-v2/WorktreeBranchSync.test.ts`; 2 passed, exit 0.
    - Reason: the broadcaster's `branches` map is empty at start, so the first read of a checkout is always a change (`apps/server/src/vcs/VcsStatusBroadcaster.ts:292-301`).
    - Limit of the proof: the two halves are two tests, not one end-to-end run. The correction happens only when something reads the status of that checkout. I did not prove that a start reads every thread worktree, so the stored branch of a worktree that nobody opens can stay old.
    - First pass: Evidence: I read `WorktreeBranchSync.ts` in full. I did not read `apps/server/src/vcs/VcsStatusBroadcaster.ts`, which decides what the stream emits at start. No probe written.

### D-M9. Storage cleanup of worktrees

- Owner: both. Upstream owns the sweep. The fork changed the merged check (`apps/server/src/storageCleanup.ts:270-283`) and added the "merged into the pull request's base branch" check (fork hunk at new lines 1183-1209).
- Stored in: memory (`deletedWorktreeWaits`, `keptDeletedWorktrees`, `sweptDeletions`, `apps/server/src/storageCleanup.ts:1461-1463`); the thread rows; the worktrees on disk.
- States (for one thread worktree): in use; waiting (live session, pending outbox effect, or settle grace of 60 s, `:82`); kept with a reason; removed. For a worktree with no thread: young (under 1 hour, `:84`); reported.
- Transitions:
  - any -> removed: `cleanWorktrees` under the workspace lease (`:1312`), with a second check just before removal (`blockedSinceCheck`, `:1221`; outbox at `:1236`; session at `:1290`); removal at `:1349`. The thread keeps its branch and path (comment at `:1360`).
  - young -> reported: `reportOrphanWorktrees`, `:517`, `:533-535`. It never removes.
  - sweep triggers: hourly loop (`:1584-1586`), `requestSweep` (`:1556`), and an event listener that ends after one stream failure (`:1626-1630`).
- Restart: the three memory values are lost. I did not prove that a start-up sweep rebuilds them.
- Explicit or implicit: implicit. The state of a worktree is computed again on each sweep from several tables and the disk.
- Gaps:
  - **D-G9.1** [unguarded transition] A deleted thread's worktree could be removed while its session still runs. **Verdict:** refuted.
    - Evidence: `apps/server/src/storageCleanup.test.ts:1278` "removes a deleted thread's worktree once its session stops" and `:1300`; command `vp test run src/storageCleanup.test.ts`; 196 passed, 1 skipped, exit 0.
  - **D-G9.2** [fork change] The fork's merged check could remove an unmerged worktree. **Verdict:** refuted.
    - Evidence: `apps/server/src/storageCleanup.test.ts:276`, `:280`, `:294` ("keeps a worktree with no pull request, or one that is not merged"); same command, exit 0.
  - **D-G9.3** [one state kept in two places] A worktree directory removed outside the app is skipped with no report entry (`apps/server/src/storageCleanup.ts:1033`), and the thread keeps its `worktreePath`. **Verdict:** by design.
    - Stated intent: `apps/server/src/storageCleanup.ts:1360` "Preserve branch/path so ProviderTurnStartService can recreate the checkout on resume."; `apps/server/src/vcs/GitVcsDriverCore.ts:5055` "Threads share paths and outside Git can remove worktrees; already-gone removals are no-ops."; `apps/server/src/ws.test.ts:1405` "Removed with `git worktree remove`; only the next turn start recreates it."; `docs/user/project-settings.md:248-249`.
    - Evidence of the behaviour: probe `$P/storageCleanup.missingWorktree.probe.test.ts`, run as `apps/server/src/storageCleanup.missingWorktree.probe.test.ts`; command `vp test run src/storageCleanup.missingWorktree.probe.test.ts`; 2 passed, exit 0. Tests "G9.3 control: a thread worktree that exists gets a report entry" and "G9.3: a thread worktree removed outside the app gets no report entry and no failure; git still lists it".
    - Evidence of the way back: `apps/server/src/orchestration-v2/ProviderTurnStartService.test.ts:266` "recreates a missing worktree only at the managed location"; command `vp test run src/orchestration-v2/ProviderTurnStartService.test.ts -t "recreates a missing worktree only at the managed location"`; 8 passed, exit 0.
    - Limit of the proof: no comment states the intent of the silent skip in the report itself (`storageCleanup.ts:1022-1034`). A path outside the managed folder is not recreated, and I did not probe that outcome. Git keeps the entry as `prunable` until the next prune.
    - First pass: Evidence: reading only. I found no test that names this case and wrote no probe.

### D-M10. Default base ref and the pull request lookup git state in `GitManager`

- Owner: fork. `apps/server/src/vcs/defaultBaseRef.ts` is new in the fork. The fork changed 160 lines of `apps/server/src/git/GitManager.ts` (git config reads for the pull request lookup).
- Stored in: `defaultBaseRef.ts` keeps nothing; it reads git on each call. `GitManager.ts` keeps maps in memory; the remembered git state has a 5-minute limit (`apps/server/src/git/GitManager.ts:182`, `:2522`, `:2534`).
- States: (default base ref) none. (Lookup git state) not read; remembered; expired; dropped by an epoch change.
- Transitions:
  - resolve: primary remote, then its default branch, then `main` and `master`, then the local ones, then the literal `main` (`apps/server/src/vcs/defaultBaseRef.ts:12-46`). The caller checks that the base exists (`apps/server/src/orchestration-v2/ThreadLaunchService.ts:444`).
  - remembered -> expired: age of 5 minutes, `apps/server/src/git/GitManager.ts:2534`.
- Restart: all `GitManager` maps are empty; nothing is stored on disk.
- Explicit or implicit: the default base ref has no state (the brief's "cache" does not exist at HEAD). The lookup state is implicit (several maps and an epoch).
- Gaps:
  - **D-G10.1** [cache staleness] A remembered remote could hide a repointed remote. **Verdict:** refuted.
    - Evidence: `apps/server/src/git/GitManager.test.ts:1758` "branch PR lookup does not reuse a cached PR after the remote is repointed"; command `vp test run src/git/GitManager.test.ts -t "branch PR lookup does not reuse a cached PR after the remote is repointed"`; 1 passed, exit 0. Also `:1085` "a branch PR lookup reads git config at most twice"; same form of command; 1 passed, exit 0.
  - **D-G10.2** [git operation state] A half-done merge, rebase or stash in a checkout. **Verdict:** confirmed for a cherry-pick and a rebase that the user started. Refuted for a merge. The app itself starts no half-done state. Tracked: t3code-250.
    - Evidence, confirmed part: probe `$P/GitVcsDriverCore.halfDone.probe.test.ts`, run as `apps/server/src/vcs/GitVcsDriverCore.halfDone.probe.test.ts`; command `vp test run src/vcs/GitVcsDriverCore.halfDone.probe.test.ts`; 2 passed, exit 0. Real git in temporary folders.
      - Test "G10.2: a selected-files commit during a conflicted cherry-pick succeeds and ends the cherry-pick state". After the commit `CHERRY_PICK_HEAD` is gone, the index has no unmerged entry, `git status` does not name a cherry-pick, and `git cherry-pick --continue` exits non-zero. The conflict markers stay in the file as a plain change.
      - Test "G10.2: a selected-files commit during a conflicted rebase succeeds on the detached HEAD and drops the conflict from the index". The rebase stays in progress with one more commit inside it. The index has no unmerged entry.
    - Evidence, refuted part: `apps/server/src/vcs/GitVcsDriverCore.test.ts:6330` "rejects selected-file merge commits without mutation ($location, conflict: $conflict)"; command `vp test run src/vcs/GitVcsDriverCore.test.ts -t "rejects selected-file merge commits without mutation"`; 6 passed, exit 0.
    - Cause: the selected-files commit guards only a merge (`apps/server/src/vcs/GitVcsDriverCore.ts:2491-2512`), then runs `git reset --quiet` (`:2513`). A grep of `apps/server/src` for `CHERRY_PICK`, `REBASE_HEAD`, `rebase-merge`, `rebase-apply` and `REVERT_HEAD` has no match.
    - The app starts only `pull --ff-only` (`GitVcsDriverCore.ts:2955`, `:2965`, `:2992`, `:3028`) and `merge --ff-only` (`:4773`), and no stash. This part is a code reading, not a probe.
    - Limit of the proof: the probe calls the driver, not the web client. I did not check whether a client offers a selected-files commit in these states. I did not run `git rebase --continue` after the commit. A commit of all files was not probed. A revert in progress was not probed.
    - Owner: upstream (`GitVcsDriverCore.ts` has no fork diff). Size: S (extend the merge guard to cherry-pick, revert and rebase).
    - Effect on the user: a commit of selected files during a stopped cherry-pick ends the cherry-pick without a notice, and during a stopped rebase it removes the conflict record from the index.
    - First pass: Evidence: I read only the fork diff and a grep outline of `GitManager.ts` (3502 lines) and did not read `apps/server/src/vcs/GitVcsDriverCore.ts`. No probe written.

### D-M11. Project clone tracker

- Owner: upstream.
- Stored in: memory, one `Ref` (`apps/server/src/project/ProjectCloneTracker.ts:98`). The project record itself is durable (SQLite), written before the clone runs.
- States: running; done (kept 30 s, `:70`); failed; cancelled. A running clone is marked stalled after 20 s without progress (`:74`).
- Transitions:
  - none -> running: `start`, `:281`.
  - running -> done, failed or cancelled: `finish`, `:195-213`; only `done` schedules its own removal (`:213`).
  - guard: thread commands for a project with a clone that is not `done` are rejected (`rejectCommandsDuringClone`, `:479`; the pass-through for "no clone known" is `:496`), called from `apps/server/src/orchestration-v2/ThreadLaunchService.ts:1012`.
- Restart: the tracker is empty. The project stays, with a folder that holds part of a clone or nothing.
- Explicit or implicit: implicit. The phase exists only in memory, and the durable project has no "clone not finished" field.
- Gaps:
  - **D-G11.1** [state lost on restart] After a restart during a clone, the tracker knows nothing about the project, and the guard lets a thread start in the unfinished folder. The comment at `apps/server/src/project/ProjectCloneTracker.ts:341-342` shows that upstream knows a restart forgets the clone; it handles a second clone request for that project, not the guard. **Verdict:** confirmed. Tracked: t3code-175.
    - Evidence: probe `$P/ProjectCloneTracker.probe.test.ts`, run as `apps/server/src/project/ProjectCloneTracker.probe.test.ts`; command `vp test run src/project/ProjectCloneTracker.probe.test.ts`; 1 passed, exit 0. Before the second layer build the phase is `running` and the guard fails; after it `get` returns null and the guard succeeds. Existing tests still pass: `vp test run src/project/ProjectCloneTracker.test.ts`, 11 passed, exit 0.
    - Size (confirmed only): M. Effect on the user: the project list shows a normal project whose folder is empty or half cloned, with no clone progress and no error, and an agent can be started in it.

### D-M12. Fork app update (`scripts/fork-app-update.sh`)

- Owner: fork.
- Stored in: the file system: the installed app, the backup folder `<backup root>/<stamp>-update`, the log file.
- States: preflight; waiting (75 s, `scripts/fork-app-update.sh:34`); quitting; backing up; old app moved; new app copied; reopened.
- Transitions:
  - preflight -> waiting: checks at `:66-84`.
  - waiting -> quitting -> backing up: `:109-131`. The waits have limits (`wait_free 45` and `wait_free 60`, 2 s each, `:54-60`, `:115`, `:123`).
  - backing up -> old app moved: `:151`.
  - old app moved -> new app copied: `ditto`, `:156`; on a failed copy the old app is restored (`:157-161`).
  - new app copied -> reopened: `:163`.
- Restart: the script keeps no marker of its step. A killed run leaves the files as they were at that moment.
- Explicit or implicit: implicit. The step is the position in the script.
- Gaps:
  - **D-G12.1** [state lost on a crash] When the run dies between the move of the old app (`:151`) and the end of the copy (`:156`), no app is installed and no script recovers. A new update stops ("no installed app"), rollback stops ("no backup folder at .../latest", or "has no swap.env" for the update backup), swap stops ("no Nightly app"). `docs/operations/fork.md:390-391` describes a manual move, for going back to the previous build. **Verdict:** confirmed. Tracked: t3code-176.
    - Evidence: probe `$P/fork-app/probe.sh`; command `$P/fork-app/probe.sh $R`; exit 0. Case U1: the update exits 137; the app folder is empty; the backup holds `T3 Code (Beta).app` and `statev2.sqlite`; the three scripts each exit 1 with the messages above; the `open` stub is never called. The probe uses the scripts' own `T3_UPDATE_*` and `T3_SWAP_*` overrides into a temporary folder and stubs `open`, `osascript`, `sleep` and `ditto` on `PATH`.
    - Size (confirmed only): S. Effect on the user: after a crash, a power loss or a kill at that step the Mac has no T3 Code app, and the user must find the backup folder and move the app back by hand.
  - **D-G12.2** [state with no exit] A failed copy could leave no app. **Verdict:** by design (handled).
    - Evidence: same probe, Case U2: exit 1; the log says "copy failed; restoring the old app" and "reopening the unchanged app"; the installed version is unchanged. Intent: `docs/operations/fork.md:388`.
  - **D-G12.3** [two writers] Two update runs at the same time (no lock file). **Verdict:** confirmed. Tracked: t3code-248.
    - Evidence: probe `$P/fork-app/probe-two-runs.sh`; command `$P/fork-app/probe-two-runs.sh $R`; exit 0 (exit 0 means every wrong end state was reached). The probe runs `scripts/fork-app-update.sh` twice in a temporary folder, with stubs for `open`, `osascript`, `sleep`, `date` and `ditto`, and FIFO gates for the order.
      - Case D0: the real `ditto` exits 1 when its destination moves during the copy.
      - Case T1: run B exits 0 and logs `finished; installed version 1.0.0-fork.2`. The installed app is the old version `1.0.0-fork.1`. Run B's backup holds run A's half copy, not the old app.
      - Case T2: both runs exit 1. The installed app is run A's half copy with no readable version. No copy of the old app is left in Applications or in the backups.
    - Cause: the script has no lock. The backup name comes from `date` (`scripts/fork-app-update.sh:31`). The move is at `:151`. The failure path at `:156-162` removes the app path and moves the old app back.
    - Limit of the proof: D0 depends on timing. T1 takes the `ditto` exit code 1 from D0. In T2 the exit code of run B's `ditto` is an assumption; the real `ditto` may also end 0 on a mixed folder. The order needs both runs to pass preflight before either moves the app. The build folder still holds a complete new app in every case.
    - Owner: fork (`git diff origin/main...origin/fork --stat` lists `scripts/fork-app-update.sh` with 170 added lines). Size: S (one lock at the start of the script).
    - Effect on the user: two update runs at the same time can leave the old version installed while one run reports success, or leave a half-copied app with no backup of the old app.
    - First pass: Evidence: reading only; no probe written.

### D-M13. Fork app swap and rollback (`scripts/fork-app-swap.sh`, `scripts/fork-app-rollback.sh`)

- Owner: fork.
- Stored in: the file system: `/Applications` apps, the backup folder with `swap.env`, the symbolic link `<backup root>/latest`, the state database and its copies (`statev2.sqlite.rollback`, `statev2.fork.sqlite`).
- States: Nightly installed; backup made and `latest` set; Nightly moved to the backup; fork app installed; rolled back.
- Transitions:
  - Nightly installed -> backup made: `scripts/fork-app-swap.sh:73-85` (`latest` is set at `:85`, before any move; comment at `:84`).
  - backup made -> Nightly moved -> fork installed: `scripts/fork-app-swap.sh:86-87`.
  - fork installed -> rolled back: `scripts/fork-app-rollback.sh`: checks at `:49`, `:54-57`; database restore at `:74-81` (copy to `.rollback`, move the current files to the backup, move `.rollback` into place); app moves at `:85-89`.
- Restart: no marker of the step. `latest` still points at a backup that a rollback has used.
- Explicit or implicit: implicit. The state is which files exist where.
- Gaps:
  - **D-G13.1** [state lost on a crash] When rollback dies after it moved the current database away (`scripts/fork-app-rollback.sh:76-80`) and before it moved the copy into place (`:81`), no `statev2.sqlite` exists and the fork app is still installed. A second rollback stops at `:57` with the hint to copy the backup's `statev2.sqlite`; that file is the database from before the swap, and the fork's work is in `statev2.fork.sqlite`. A stale `statev2.sqlite.rollback` stays. **Verdict:** confirmed. Tracked: t3code-177.
    - Evidence: probe `$P/fork-app/probe.sh`, Case R1 (a `mv` stub kills the script on its second call): exit 137; the state folder holds only `statev2.sqlite.rollback`; the backup holds the Nightly app, `statev2.fork.sqlite`, `statev2.sqlite` and `swap.env`; the second rollback prints "no database at .../statev2.sqlite; copy .../statev2.sqlite there" and exits 1.
    - Size (confirmed only): S. Effect on the user: the app that is still installed would start with no database, and the script's hint leads to the older database, not to the one that holds the latest work.
  - **D-G13.2** [state with no exit] A swap whose copy fails after Nightly was moved. **Verdict:** by design.
    - Evidence: same probe, Case S1: swap exits 1, `latest` points at the backup, rollback exits 0 and Nightly is back. Intent: comment at `scripts/fork-app-swap.sh:84`.
  - **D-G13.3** [unguarded transition] A second rollback from the same `latest`. **Verdict:** refuted.
    - Evidence: same probe, Case S2: the full swap and rollback work (the database goes back from migration 6 to 5); the second rollback stops with "no Nightly app in <backup>" and exit 1, and changes nothing.
  - **D-G13.4** [state with no exit] Rollback from an update backup (`<stamp>-update`) is refused. **Verdict:** by design.
    - Evidence: same probe, Case U1 (exit 1, "has no swap.env; pass the backup folder the swap printed"); `scripts/fork-app-rollback.sh:49`; the manual way is `docs/operations/fork.md:390-391`.

### Area D: other points

- **D-P1** lost information: when the give-up dispatch with a wake is rejected, the reactor ends the watch again without a wake, so the agent gets no message (fork line), `apps/server/src/orchestration-v2/PullRequestWatchReactor.ts:337`. **Verdict:** confirmed (the behaviour). Tracked: t3code-178.
  - Evidence: `$P/PullRequestWatchReactor.probe.test.ts`, test "a rejected give-up wake falls back to an end without a wake", same command as G2.1, exit 0. Caveat: the orchestrator rejects a wake only for a replaced watch or an inactive thread (`apps/server/src/orchestration-v2/Orchestrator.ts:3596`), and the end reason is still written to `watchRecord.ended`; no comment states the intent of the fallback. Size S.
- **D-P2** lost information: a failed watch sweep is only logged, with no trace in a thread, `apps/server/src/orchestration-v2/PullRequestWatchReactor.ts:774-777`. **Verdict:** confirmed through G1.1 (same probe). Tracked: t3code-170.
- **D-P3** untested state: `apps/server/src/vcs/defaultBaseRef.ts` (fork) has no test. **Verdict:** confirmed. Tracked: t3code-179.
  - Evidence: `grep -rln "resolveDefaultBaseRef\|defaultBaseRef" apps packages --include="*.test.ts" --include="*.test.tsx"` prints nothing. Its two callers are `apps/server/src/orchestration-v2/ThreadLaunchService.ts:444` and `apps/server/src/mcp/OrchestratorMcpService.ts:1895`.
- **D-P4** untested state: the three fork app scripts and the markers of `scripts/setup-worktree.ts` have no automated test. **Verdict:** confirmed for the places searched. Tracked: t3code-180.
  - Evidence: `grep -rn "fork-app-\|setup-worktree" --include="*.test.ts" --include="*.yml" --include="*.yaml" scripts .github apps/server/src` finds only a terminal id in `apps/server/src/terminal/Manager.test.ts:1357`. I did not search other packages.
- **D-P5** untested state: no test file names `removeLinkedWorktree` or `worktreeRemoval` (`grep -rln` over `apps` and `packages` test files prints nothing; `vp test run src/vcs/worktreeRemoval.test.ts` says "No test files found", exit 1). **Verdict:** refuted for the branch that runs on macOS and Linux. Confirmed as a test gap for the Windows branch (`apps/server/src/vcs/worktreeRemoval.ts:53-155`); this is missing coverage, not a wrong behaviour. Tracked: t3code-253.
  - Evidence, refuted part: the driver tests reach the module through `driver.removeWorktree` (`apps/server/src/vcs/GitVcsDriverCore.ts:5019`). Tests at `apps/server/src/vcs/GitVcsDriverCore.test.ts:5629`, `:5679` "keeps a worktree whose untracked files status is configured to hide", `:5734`, `:5772`, `:5801`; command `vp test run src/vcs/GitVcsDriverCore.test.ts -t "untracked files status is configured to hide|without deleting what its junctions|junctions of a worktree that git refuses|prunes stale registrations when removing|cleans up links left by successful worktree removal"`; 6 passed, exit 0.
  - Evidence, confirmed part: probe `$P/worktreeRemoval.windowsBranch.probe.test.ts`, run as `apps/server/src/vcs/worktreeRemoval.windowsBranch.probe.test.ts`; command `vp test run src/vcs/worktreeRemoval.windowsBranch.probe.test.ts`; 2 passed, exit 0.
    - Test "P5: on this host the removal is one `git worktree remove` call and none of the module's own checks run".
    - Test "P5: with the platform set to win32, the module's own checks run: locked and dirty refuse, clean removes". This shows the branch works on macOS with a simulated platform, so a test without a Windows host is possible.
    - No existing test sets `HostProcess.Platform` to `win32` around a removal. `GitVcsDriverCore.test.ts:7323` sets it for git config only. `apps/server/src/storageCleanup.test.ts:1596`, `:1902`, `:1935`, `:1958` set it and expect `kept` or no entry.
    - CI has no automatic Windows run: `.github/workflows/windows-tests.yml:1-3` "Manual only: nothing in the suite passes on Windows yet".
  - Limit of the proof: I did not measure coverage. The Windows cases ran on macOS, with POSIX paths and no NTFS junction. The submodule checks (`worktreeRemoval.ts:120-132`) and the failed-delete restore (`:147-152`) were not probed.
  - Owner: upstream (`worktreeRemoval.ts` has no fork diff). Size: S (three to five driver tests with the platform set to `win32`).
  - Effect on the user: a change that breaks worktree removal on Windows passes every automatic check.
- **D-P6** wait without limit: the setup script runner waits for the script's end with no time limit, `apps/server/src/project/ProjectSetupScriptRunner.ts:282`, and the shell readiness loop is at `:336-344`. **Verdict:** confirmed for the wait for the script's end (`ProjectSetupScriptRunner.ts:282`). By design for the shell readiness loop (`:336-344`). Tracked: t3code-252.
  - Evidence: probe `$P/ProjectSetupScriptRunner.noLimit.probe.test.ts`, run as `apps/server/src/project/ProjectSetupScriptRunner.noLimit.probe.test.ts`; command `vp test run src/project/ProjectSetupScriptRunner.noLimit.probe.test.ts`; 2 passed, exit 0 (27 s; the `TestClock` steps through 30 days).
    - Test "P6: a setup script that never ends keeps its completion waiting after 30 days, until the terminal exits". After 30 days the completion is still pending and still listens. A terminal `exited` event ends it with no exit code.
    - Test "P6: a shell whose start-up child stays busy gets no command after 30 days".
  - Stated intent for the readiness loop: `apps/server/src/project/ProjectSetupScriptRunner.ts:335` "A startup prompt runs as a child process, so a busy shell keeps waiting for the user." Existing test: `apps/server/src/project/ProjectSetupScriptRunner.test.ts:126` "shows a startup prompt and types only once the line editor starts"; command `vp test run src/project/ProjectSetupScriptRunner.test.ts -t "shows a startup prompt and types only once the line editor starts"`; 1 passed, exit 0.
  - Limit of the proof: no comment, document or test name states an intent for the script-end wait, in either direction. A fixed limit can break a long install, so the right fix is a product decision. The probe is at the runner level. I did not probe which launches wait for the completion (`ThreadLaunchService.ts:787-799` skips the failure for an `async` setup). A user can cancel a tracked setup (`ThreadLaunchService.test.ts:2292`, see G5.1).
  - Owner: upstream (`ProjectSetupScriptRunner.ts` has no fork diff). Size: S for a limit or a notice; the choice of the limit needs a decision.
  - Effect on the user: a setup script that never ends keeps the launch in preparation with no limit, which nobody sees on a thread that an agent or a schedule started.
  - First pass: Tried: read the file in full; `vp test run src/project/ProjectSetupScriptRunner.test.ts` (8 passed, exit 0) has no case for a script that never ends; no probe written.
- **D-P7** lost information: three event listeners end for good after one failure of the event stream, and only log it: `apps/server/src/orchestration-v2/PullRequestSyncReactor.ts:762`, `apps/server/src/orchestration-v2/ThreadPullRequestService.ts:435`, `apps/server/src/storageCleanup.ts:1626-1630`. **Verdict:** confirmed for `ThreadPullRequestService.ts:435`. Not verified for the other two sites. Tracked: t3code-251.
  - Evidence: probe `$P/ThreadPullRequestService.streamFailure.probe.test.ts`, run as `apps/server/src/orchestration-v2/ThreadPullRequestService.streamFailure.probe.test.ts`; command `vp test run src/orchestration-v2/ThreadPullRequestService.streamFailure.probe.test.ts`; 2 passed, exit 0.
    - Test "P7 control: without a stream failure, each turn end causes a fresh lookup" (2 lookups, 1 subscription, 0 unread events).
    - Test "P7: after one failure of the event stream, the listener never subscribes again and later turn ends cause no lookup". 70 minutes after the failure the service has 1 subscription, 1 lookup, and the second event is unread.
  - Limit of the proof: the probe covers one site of three. `PullRequestSyncReactor.ts:762` and `storageCleanup.ts:1626-1630` rest on reading: each wraps the same `Stream.runForEach` in one `catchCause` that logs and ends. Their per-event handlers catch their own errors (`PullRequestSyncReactor.ts:662`, `:683`, `:705`), so only a failure of the stream itself ends them. The probe uses a fake stream that fails with `OrchestratorDomainEventStreamError`. I did not make the real stream fail (`apps/server/src/orchestration-v2/Orchestrator.ts:15641-15653` maps any error of the event sink's stream). The one-minute sweeps continue.
  - Owner: upstream (blame of the three sites gives commits that are ancestors of `origin/main`). Size: S for each site.
  - Effect on the user: after one read failure of the event stream, a finished turn no longer starts a fresh pull request lookup until the server restarts; only the one-minute sweep is left, and it runs only while a client is connected.
  - First pass: Tried: reading only; a probe needs a failing `streamDomainEvents`, which is Area A's stream. The timed sweeps of the sync reactor and of storage cleanup continue.
- **D-P8** correction to an earlier note of mine: `PullRequestWatchReactor.ts` has no test file of its own, but `apps/server/src/orchestration-v2/runtimeLayer.test.ts` tests it (for example `:3784`, `:4018` "wakes once for a state it reported, across a restart and a new watch"; `vp test run src/orchestration-v2/runtimeLayer.test.ts -t "wakes once for a state it reported, across a restart and a new watch"`, 1 passed, exit 0). No existing test covers G2.1. **Verdict:** no verdict of its own; see the gap it names.

## Area E: Server shell: startup, ownership, streams, auth, relay, peers

### Area E: evidence conventions

Checkout: `<repo>/`, HEAD `22b65998f3`.
All paths below are repo-relative. Paths without a package prefix are under `apps/server/src/`.
All test commands ran from `apps/server`. Probe files are in
`<archive>/probes/E/`
(called `<probes>` below). To run a probe again, copy it back beside the code it tests.

Coverage is partial. Read the list of unread code on the board task in [Coverage](#coverage) before you rely on this area: most peripheral
directories were not read.

Second pass:

Scope: one verdict for each of eight gaps. No new area was read and no machine was added.
All commands ran from `<repo>/apps/server` at HEAD `22b65998f3`.
Each probe ran beside the code as `src/<dir>/<name>.probe.test.ts`. Each probe is now in `<archive>/probes/E/`.
Owner check: `git diff --stat origin/main...origin/fork` shows only `apps/server/src/relay/AgentAwarenessRelay.ts` changed in the fork among the files below. `git blame` puts the retry-budget lines of that file upstream. Every confirmed gap is upstream code.

### E-M1. Server ownership of the state directory (lock file and runtime record)

- Owner: upstream
- Stored in: file `server-owner.sqlite` in the state directory (exclusive SQLite transaction held by the process); file at `config.serverRuntimeStatePath` (JSON runtime record with `pid`, `ownerId`, `origin`, `startedAt`); memory (the lock identity `dev`/`ino`).
- States: unowned; lock held, no record; lock held, record published; lock file deleted or replaced (owner still runs); record stale (owner dead, record still on disk).
- Transitions:
  - unowned -> lock held: `acquireServerOwnership`. Enforced at `apps/server/src/serverOwnership.ts:224` (lock opened at `:233` through `openOwnershipLock`, `:184`).
  - lock held -> refused: a legacy record without `ownerId` whose owner is live. Enforced at `apps/server/src/serverOwnership.ts:248-254`.
  - lock held -> record published: `publish`. Enforced at `apps/server/src/serverOwnership.ts:294-295`; called from `apps/server/src/server.ts:881-906`.
  - record published -> unowned: scope close. The record is cleared only when `state.ownerId === ownerId`. Enforced at `apps/server/src/serverOwnership.ts:233-243`.
  - lock held -> lock file lost: a watcher checks the file identity each 5 seconds and only logs an error. `apps/server/src/serverOwnership.ts:260-291` (log at `:288`). Not enforced beyond the log.
  - record published -> record stale: process killed. Not enforced; readers filter with `readLiveServerRuntimeState`, `apps/server/src/serverRuntimeState.ts:201-207`, which checks PID liveness only (`isProcessAlive`, `:132-140`).
- Restart: the OS releases the lock when the process ends. After a clean stop the record is cleared. After a crash the record stays on disk and readers judge it by PID.
- Explicit or implicit: implicit; the lock, the record and the PID check are three separate mechanisms with no single type for "who owns this home".
- Gaps:
  - **E-G1.1** [unguarded transition] When the lock file is deleted or replaced, the first server keeps running and a second server can acquire ownership of the same home. **Verdict:** by design.
    - Evidence: `apps/server/src/serverRuntimeState.test.ts:200-279` (after `unlink` or `replace`, the only reaction is the log asserted at `:258-266`; a second `acquireServerOwnership` succeeds at `:269`); intent in the comment at `apps/server/src/serverOwnership.ts:179-183` ("must never be unlinked") and the log text at `:288`. Command `vp test run src/serverRuntimeState.test.ts`, exit 0, 16 passed.
  - **E-G1.2** [one state in two places that can disagree] A stale runtime record reads as a live server when its PID belongs to any live process. The record's `ownerId` and the lock are not checked. The CLI then sends a bearer token to the recorded origin (`apps/server/src/cli/thread.ts:224-246`; same reader at `apps/server/src/cli/connect.ts:346`, `apps/server/src/cli/project.ts:363`; the `cli/` directory is outside Area E). **Verdict:** confirmed. Tracked: t3code-184.
    - Evidence: probe `<probes>/serverRuntimeState.pid.probe.test.ts` (was `apps/server/src/serverRuntimeState.pid.probe.test.ts`), command `vp test run src/serverRuntimeState.pid.probe.test.ts -t "PROBE"`, exit 0, 1 passed. The test passes while it asserts the wrong behaviour: a record from 2020 with a foreign `ownerId` and the test runner's own PID is returned as live. Caveat: the probe uses the test runner's PID in place of a PID that the OS reused; I did not reproduce real PID reuse. The comment at `apps/server/src/serverRuntimeState.ts:196-200` states the purpose of the check but does not accept this case.
    - Size (confirmed only): M. Effect on the user: after a server crash, if the OS reuses the PID, `t3 thread`, `t3 project` and `t3 connect` treat the home as served and can send a full-access token to whatever process now listens on the old port.

### E-M2. Server start phases and the command readiness gate

- Owner: upstream
- Stored in: memory (`Deferred` plus a queue in `makeCommandGate`); the phases themselves are code order only.
- States: `"pending"`, `"ready"`, failed (`ServerRuntimeStartupError`). Type at `apps/server/src/serverRuntimeStartup.ts:84`.
- Transitions:
  - HTTP listener up, not serving -> serving: requests are rejected until serving. Enforced at `apps/server/src/server.ts:355` (`rejectRequestsUntilServing`).
  - pending -> ready: `signalCommandReady` at the end of the start phases. Enforced at `apps/server/src/serverRuntimeStartup.ts:134` (defined), `:660` (called).
  - pending -> failed: a start phase fails. Enforced at `apps/server/src/serverRuntimeStartup.ts:688-706` (`failCommandReady` at `:701`).
  - any -> failed: scope close. Enforced at `apps/server/src/serverRuntimeStartup.ts:457-459`.
  - request while pending: HTTP requests wait in the global middleware `layerCommandReadiness`, `apps/server/src/server.ts:779-785` (`awaitCommandReady` at `:782`). Commands wait in `enqueueCommand`, `apps/server/src/serverRuntimeStartup.ts:110-130`.
- Restart: all in memory; a new process starts at `pending`.
- Explicit or implicit: explicit for the gate (one type, one owner module); implicit for the phase order (statements in one generator, `apps/server/src/serverRuntimeStartup.ts:486-676`).
- Gaps:
  - **E-G2.1** [state with no exit] `pending` has no time limit; see P1 for the evidence. It exits only through ready, a failed phase or scope close. **Verdict:** confirmed (as a wait without limit; see P1). Tracked: t3code-185.
    - Evidence: see P1.
    - Size (confirmed only): S. Effect on the user: if one start phase hangs without failing, every HTTP request and queued command waits with no error. - Pinned behaviour, no gap: queueing and failure of queued work. `apps/server/src/serverRuntimeStartup.test.ts:262` ("queues commands until startup signals readiness") and `:279` ("enqueueCommand fails queued work when readiness fails"). Command `vp test run src/serverRuntimeStartup.test.ts`, exit 0, 8 passed.

### E-M3. Server activation (parked fibers) and launcher watch

- Owner: upstream
- Stored in: memory (`Deferred` `activation`, `apps/server/src/server.ts:863`; the launcher PID captured at import, `apps/server/src/launcherWatch.ts:8`).
- States: parked (background fibers forked, waiting for activation); activated; launcher present; launcher lost.
- Transitions:
  - parked -> activated: `activate` succeeds the Deferred. Enforced at `apps/server/src/server.ts:1185`; fibers park in `forkParkedFiber`, `apps/server/src/serverActivation.ts:12-25`.
  - no activation reference -> fiber runs at once. `apps/server/src/serverActivation.ts:16-18`.
  - launcher present -> launcher lost: `process.ppid` differs from the PID seen at start, polled each 2 seconds. Enforced at `apps/server/src/launcherWatch.ts:25-33`; the server then interrupts itself, `apps/server/src/cli/server.ts:46` (only in desktop mode with a bootstrap token; `cli/server.ts` is outside Area E).
- Restart: memory only.
- Explicit or implicit: implicit; activation is one Deferred that many services await through a context reference.
- Gaps:
  - **E-G3.1** [state with no exit] On Windows, and when the parent PID is 1 or lower, the launcher watch never fires (`Effect.never`, `apps/server/src/launcherWatch.ts:24`), so an orphan backend keeps the ownership lock. **Verdict:** by design.
    - Evidence: comment at `apps/server/src/launcherWatch.ts:10-14` states the intent and the Windows reason. The existing test `apps/server/src/launcherWatch.test.ts:17` pins only the lost-launcher path; command `vp test run src/launcherWatch.test.ts`, exit 0, 1 passed. The Windows branch itself has no test (untested state).
  - **E-G3.2** [state with no exit] A parked fiber never runs if activation never happens. I did not probe this. **Verdict:** by design.
    - Intent: `docs/internals/server-updates.md:57-62` ("park every long-running root at the activation gate before reporting `prepared` ... Only then may the child release its gates"), `:117` ("Continuation effects wait for activation"), `:139-140` ("Schedulers wait for activation so they cannot start runs that reconciliation would then cancel").
    - Code: `apps/server/src/serverActivation.ts:12-25`, `apps/server/src/server.ts:1185-1186` (`activate` succeeds the Deferred; `abort` makes it die), `apps/server/src/serverRuntimeStartup.ts:658` and `:688-706`.
    - Existing test: `apps/server/src/scheduling/Scheduler.test.ts:89` "holds due work and the clock until startup recovery activates the server".
      - Command: `vp test run src/scheduling/Scheduler.test.ts -t "holds due work and the clock until startup recovery activates the server"`. Exit code 0. 1 test passed, 3 skipped.
    - Probe: `serverActivation.parked.probe.test.ts`.
      - Command: `vp test run src/serverActivation.parked.probe.test.ts`. Exit code 0. 3 tests passed.
      - Tests:
        - "PROBE G3.2 a parked fiber does not run while activation is pending, for 24 hours"
        - "PROBE G3.2 a failed startup ends each parked fiber without running its work"
        - "PROBE G3.2 closing the scope ends a parked fiber that was never activated"
    - Shown: the parked state has three exits: activation, a startup failure, and scope close. A parked fiber does no work before one of them.
    - Limit: the probe models `abort` with `Deferred.die` directly; it does not run `server.ts`. The state has no exit only when a start phase hangs before activation. That case is P1 and G2.1 of the first pass, not this gap.
    - First pass: Tried: code reading of `apps/server/src/serverActivation.ts` and `apps/server/src/server.ts:863-1185` only.

### E-M4. Server lifecycle events (welcome, ready)

- Owner: upstream
- Stored in: memory (`Ref` with a sequence and the latest event of each type, `apps/server/src/serverLifecycleEvents.ts:30-33`; `PubSub` at `:29`).
- States: no event; welcome published; ready published.
- Transitions:
  - publish: sequence + 1, older event of the same type replaced. Enforced at `apps/server/src/serverLifecycleEvents.ts:36-48`.
  - publishers: `apps/server/src/serverRuntimeStartup.ts:647-649` (welcome), `:664-666` (ready).
  - client subscription: subscribes to the stream first, then reads the snapshot. `apps/server/src/ws.ts:3343-3362`.
- Restart: lost; the sequence starts at 0 again.
- Explicit or implicit: explicit and small.
- Gaps:
  - none claimed. I ran no probe on this machine.

### E-M5. WebSocket connection lifecycle

- Owner: upstream (the fork changed other parts of `ws.ts`, not this route)
- Stored in: memory (`connectedSessionsRef`, a map session id -> socket count, `apps/server/src/auth/SessionStore.ts:501`); the session row in SQLite decides validity.
- States: upgrade authenticating; connected; invalidated (revoked, expired, replaced); closed.
- Transitions:
  - upgrade -> connected: `authenticateWebSocketUpgrade`, `apps/server/src/auth/EnvironmentAuth.ts:1262-1314`; then `markConnected`, `apps/server/src/ws.ts:3547` (`apps/server/src/auth/SessionStore.ts:583`).
  - connected -> closed: RPC ends or `awaitInvalidation` wins the race. Enforced at `apps/server/src/ws.ts:3546-3560` (`acquireUseRelease`; `awaitInvalidation` at `:3551`).
  - closed: `markDisconnected`, `apps/server/src/ws.ts:3559` (`apps/server/src/auth/SessionStore.ts:617`).
  - scopes: fixed at connect, `apps/server/src/ws.ts:3467` (`RpcAuthorization.layer(session.scopes, ...)`).
- Restart: all sockets end; the connected counts are memory and start empty.
- Explicit or implicit: implicit; the lifecycle is one `acquireUseRelease` plus a race.
- Gaps:
  - **E-G5.1** [one state in two places that can disagree] A socket keeps the scopes it had at connect while the session row can change. **Verdict:** by design.
    - Evidence: comment at `apps/server/src/auth/SessionStore.ts:1086` ("The socket keeps its original scopes, so the renewal must still grant all of them."); `apps/server/src/auth/SessionStore.test.ts:88` (revoke, revokeAllExcept and replace close the socket), `:118` (expiry closes it), `:187`. Command `vp test run src/auth/SessionStore.test.ts`, exit 0, 22 passed.
  - **E-G5.2** [lost information] A failure to publish the connected-session update is only logged (`apps/server/src/auth/SessionStore.ts:606-613`). **Verdict:** confirmed. Tracked: t3code-222.
    - Code: `apps/server/src/auth/SessionStore.ts:583-613` (`markConnected`) and `:615-640` (`markDisconnected`); both end in `Effect.catchCause` and `logError`.
    - Probe: `SessionStore.connectedPublish.probe.test.ts`.
    - Command: `vp test run src/auth/SessionStore.connectedPublish.probe.test.ts`. Exit code 0. 2 tests passed.
    - Tests:
      - "PROBE G5.2 connect: a failed last-connected write drops the 'connected' update and reports no error"
      - "PROBE G5.2 disconnect: a failed row read drops the 'disconnected' update and reports no error"
    - Shown: the call succeeds. `listActive()` shows the true state. A `streamChanges` subscriber gets no event for that session. In the connect case `lastConnectedAt` stays `null`.
    - Limit: the fault is an injected SQL failure (a trigger, and a table renamed away and back). No document states an intent. A fresh `listActive()` or a new subscription shows the right state.
    - Owner: upstream. Size: S.
    - User effect: the authorized-clients list in Settings shows a stale connected or disconnected state for that client until the next change or a reconnect.
    - First pass: Tried: code reading only.

### E-M6. Thread stream subscription (resume, coalescing, live budget)

- Owner: upstream
- Stored in: memory per subscription (cursor, coalescer state, retained-item budget); the event store in SQLite is the source (Area A).
- States: resume plan `replay` or `snapshot` (`ThreadResumePlan`, `apps/server/src/orchestration-v2/ThreadStream.ts:91-97`); live; failed with `LiveStreamBufferError` (`apps/server/src/orchestration-v2/LiveStreamBudget.ts:13`).
- Transitions:
  - subscribe -> replay or snapshot: `decideThreadResume`. Enforced at `apps/server/src/orchestration-v2/ThreadStream.ts:100-118` (snapshot when the cursor is ahead of the store, or replay exceeds 128 events or 1 MiB; constants at `:18`, `:20`).
  - live -> failed: retained items exceed 1,000 or 8 MiB. `apps/server/src/orchestration-v2/LiveStreamBudget.ts:18-19`, budget made at `:39`.
  - live updates coalesce in a 50 ms window, at most 512 pending. `apps/server/src/orchestration-v2/ThreadLiveEventCoalescer.ts:18-19`.
  - handler: `apps/server/src/ws.ts:881-1112`.
- Restart: lost; the client resubscribes with its cursor.
- Explicit or implicit: explicit for the resume decision (one pure function with tests); implicit for the rest of the handler.
- Gaps:
  - none claimed. Pinned behaviour: `apps/server/src/orchestration-v2/ThreadStream.test.ts:119`, `:134`, `:145`. Commands `vp test run src/orchestration-v2/ThreadStream.test.ts` (exit 0, 7 passed), `vp test run src/orchestration-v2/LiveStreamBudget.test.ts` (exit 0, 9 passed), `vp test run src/orchestration-v2/ThreadLiveEventCoalescer.test.ts` (exit 0, 16 passed). I wrote no probe for this machine.

### E-M7. Shell stream subscription

- Owner: both (the handler is upstream; the fork changed `projectShellItems`, `apps/server/src/ws.ts:1200-1225`)
- Stored in: memory per subscription; shell rows in SQLite (Area A).
- States: initial snapshot; resume by replay; resume by snapshot (gap above `SHELL_RESUME_MAX_GAP = 1_000`, `apps/server/src/ws.ts:684`); live.
- Transitions:
  - handler: `apps/server/src/ws.ts:1114-1380`; live part from `liveFrom`, `:1235-1244`; item projection through the shared reads of M8, `:1204`.
- Restart: lost; the client resubscribes.
- Explicit or implicit: implicit; the resume choice is inline in the handler.
- Gaps:
  - none claimed. Pinned behaviour: `apps/server/src/ws.test.ts:459` ("shell groups read distinct threads once and keep each event's own sequence"), command `vp test run src/ws.test.ts -t "shell groups read distinct threads"`, exit 0, 1 passed, 25 skipped; `vp test run src/orchestration-v2/ShellStream.test.ts`, exit 0, 17 passed. I wrote no probe for the handler.

### E-M8. Shared shell thread reads (cache of in-flight and just-settled reads)

- Owner: fork (`apps/server/src/orchestration-v2/ShellThreadReads.ts` is new in the fork)
- Stored in: memory (`latest` map thread id -> read, `apps/server/src/orchestration-v2/ShellThreadReads.ts:48`).
- States per thread: no entry; in flight; settled and usable (kept `SETTLED_READ_KEPT_MS = 1_000`, `:28`); expired.
- Transitions:
  - no entry or not usable -> in flight: `read` forks one load for all threads that need one. Enforced at `apps/server/src/orchestration-v2/ShellThreadReads.ts:104` (fork at `:139`).
  - in flight -> settled: `load` settles each read; a failed batch read falls back to per-thread reads (`:72`), and a failed load fails every sharer (`:99`).
  - settled -> expired -> removed: the eviction loop in `read` stops at the first usable entry (`:111-114`).
- Restart: lost; no effect, the store is the source.
- Explicit or implicit: implicit; the state of an entry is derived from its fields and the clock.
- Gaps:
  - **E-G8.1** [cache staleness] Suspected: an expired entry behind an in-flight entry stays in the map and could answer a later event. **Verdict:** refuted.
    - Evidence: probe `<probes>/ShellThreadReads.eviction.probe.test.ts` (was `apps/server/src/orchestration-v2/ShellThreadReads.eviction.probe.test.ts`), command `vp test run src/orchestration-v2/ShellThreadReads.eviction.probe.test.ts -t "PROBE"`, exit 0, 1 passed, 1 skipped. The test asserts the correct behaviour and passes: the expired entry is not reused. It only stays in memory until the entry in front of it settles.
  - **E-G8.2** [lost information] One failed read fails every subscriber that shares it. **Verdict:** by design.
    - Evidence: `apps/server/src/orchestration-v2/ShellThreadReads.test.ts:92` ("a failed read is reported to its subscribers and not kept") and `:113` ("a read that dies fails its subscribers instead of leaving them waiting"). Command `vp test run src/orchestration-v2/ShellThreadReads.test.ts`, exit 0, 4 passed. - Boundary: the rows come from the shell row query in `apps/server/src/orchestration-v2/ProjectionStore.ts` (Area A).

### E-M9. Auth sessions

- Owner: upstream
- Stored in: SQLite `auth_sessions` rows (`revokedAt`, `expiresAt`, scopes); signed tokens held by clients; memory: `connectedSessionsRef` (`apps/server/src/auth/SessionStore.ts:501`), `changesPubSub` (`:502`), `latestSessionByProofKey` (`:505`).
- States: issued and active; connected (count above 0); expired; revoked; replaced by a successor; reusable dev session (never expires, web dev mode only, `apps/server/src/auth/ReusableDevAuth.ts`).
- Transitions:
  - none -> active: `issue`, `apps/server/src/auth/SessionStore.ts:644` (replace-active variant inside it).
  - active -> verified on each request: `verify`, `:752` (signature, expiry claim, row present, not revoked; scopes come from the row).
  - active -> revoked: `revoke`, `:987`; `revokeAllExcept`, `:1008`.
  - active -> expired: by clock; a connected socket is closed by `awaitInvalidation`, `:1042`.
  - WebSocket ticket: `issueWebSocketToken`, `:852`; `verifyWebSocketToken`, `:889`.
- Restart: rows survive. Connected counts and `latestSessionByProofKey` are lost; all sockets are closed by the restart, so the counts stay consistent.
- Explicit or implicit: implicit; state is derived from row columns and the clock in each method.
- Gaps:
  - **E-G9.1** [state lost on restart] `latestSessionByProofKey` is memory only and is never pruned. **Verdict:** confirmed, both parts. The impact is low. Tracked: t3code-222.
    - Code: `apps/server/src/auth/SessionStore.ts:503-505` (the map), `:712` (the only write), `:1080-1083` (the only read).
    - Probe: `SessionStore.proofKeyMap.probe.test.ts`.
    - Command: `vp test run src/auth/SessionStore.proofKeyMap.probe.test.ts`. Exit code 0. 2 tests passed.
    - Tests:
      - "PROBE G9.1 restart: a socket on a session renewed before the restart closes at minute 60, not 119"
      - "PROBE G9.1 growth: the map keeps one entry per proof key after every session is revoked and expired"
    - Shown, restart: a store built twice over one data directory forgets the renewal. The socket on the older session closes at minute 60. The in-process control is `SessionStore.test.ts:138` "closes a DPoP socket at minute 119 after a renewal for the same key".
    - Shown, growth: 200 proof keys, every session revoked, clock advanced 60 days. The map still holds 200 entries and saw zero removals.
    - Limit, growth: the map holds one small entry per distinct DPoP key per process lifetime. The bound is the count of keys, not the count of sessions. The probe reads the private map through a patch of `Map.prototype`.
    - Limit, restart: the case needs a socket that reconnects on the older session after the restart while a renewal exists. I did not check which token a client uses on reconnect, because the client code is outside this area.
    - Owner: upstream. Size: S.
    - User effect: at most one extra socket reconnect at the old session's expiry; the memory growth is negligible.
    - First pass: Tried: code reading only; no probe for growth or for a renewal after a restart. - Pinned behaviour, no gap: `apps/server/src/auth/SessionStore.test.ts:255` (reusable dev auth across restarts), `:362` (scopes from the row), `:398` (atomic replace), `:439` (previous desktop session stays valid when replacement fails), `:511` (WebSocket token rejected after the parent expires). Command as in G5.1, exit 0.

### E-M10. Pairing links and bootstrap credentials

- Owner: upstream
- Stored in: SQLite pairing link rows (`consumedAt`, `revokedAt`, `expiresAt`); memory: seeded desktop grants (`seededGrantsRef`, `apps/server/src/auth/PairingGrantStore.ts:276`) and the rotating desktop token.
- States: available; consumed; revoked; expired.
- Transitions:
  - none -> available: `issueOneTimeToken`, `apps/server/src/auth/PairingGrantStore.ts:390`.
  - available -> consumed: `consume`, `:457`; the atomic UPDATE is `consumeAvailable`, `:570` (comment at `:568`).
  - available -> revoked: `revoke`, `:374`.
  - available -> expired: by clock only; no code runs at the expiry time.
  - consumed -> session: `consume` at `apps/server/src/auth/EnvironmentAuth.ts:887`, then `issue` at `:890`; second path `consume` at `:935`, `issue` at `:979`.
- Restart: rows survive. Seeded grants and the rotating desktop token are memory only; I did not verify how they are seeded again.
- Explicit or implicit: implicit; the state is derived from three nullable columns, and the only guard is the SQL UPDATE.
- Gaps:
  - **E-G10.1** [state with no exit signal] A link that expires leaves `listActive()` and is refused by `consume`, but no `pairingLinkRemoved` change is published. **Verdict:** confirmed. Tracked: t3code-183.
    - Evidence: probe `<probes>/PairingGrantStore.expiry.probe.test.ts` (was `apps/server/src/auth/PairingGrantStore.expiry.probe.test.ts`), command `vp test run src/auth/PairingGrantStore.expiry.probe.test.ts -t "PROBE"`, exit 0, 1 passed, 7 skipped. The test passes while it asserts the wrong behaviour. The web client compensates by its own clock at `apps/web/src/components/settings/AuthorizedClientsSettings.tsx:278` (Area F). I did not check the mobile client.
    - Size (confirmed only): S. Effect on the user: a client that does not filter by its own clock keeps an expired pairing link in the list until it reloads the list.
  - **E-G10.2** [unguarded transition] The token is consumed, then the session is issued, in two steps. If `issue` fails, the one-time token is spent and no session exists. **Verdict:** confirmed. Tracked: t3code-220.
    - Code: `apps/server/src/auth/EnvironmentAuth.ts:886-901` (consume, then `sessions.issue`, browser session) and `:935`, `:979` (access token).
    - Probe: `EnvironmentAuth.consumeThenIssue.probe.test.ts`.
    - Command: `vp test run src/auth/EnvironmentAuth.consumeThenIssue.probe.test.ts`. Exit code 0. 3 tests passed.
    - Tests:
      - "PROBE G10.2 browser session: one failed issue spends the pairing token for good"
      - "PROBE G10.2 access token: one failed issue spends the pairing token for good"
      - "PROBE G10.2 control: without the fault the same token yields a session"
    - Shown: the first exchange fails with the issue error. No session exists. The pairing link is gone. A retry after the fault is gone fails with `ServerAuthInvalidCredentialError`.
    - Limit: the fault is an injected SQL insert failure on `auth_sessions`. Real causes are a database write error, a signer or secret failure, an interrupt, or a crash between the two steps. A response lost on the network after a good issue has the same effect, and one transaction does not fix that case.
    - Contrast: `EnvironmentAuth.test.ts:303` "preserves pairing grants after rejecting scopes they do not grant" shows that the scope-refusal path keeps the token.
    - Owner: upstream. Size: S.
    - User effect: after one failed pairing attempt, the pairing link or code is dead and the user must make a new one.
    - First pass: Tried: code reading of `apps/server/src/auth/EnvironmentAuth.ts:879-912` and `:963-1023` only; no probe. - Pinned behaviour, no gap: `apps/server/src/auth/PairingGrantStore.test.ts:73` ("atomically consumes a one-time token when multiple requests race"). Command `vp test run src/auth/PairingGrantStore.test.ts`, exit 0, 7 passed.

### E-M11. Auth access stream (snapshot plus live changes to clients)

- Owner: upstream
- Stored in: memory per subscription (a revision counter starting at 1); the sources are M9 and M10.
- States: snapshot loaded; live.
- Transitions:
  - subscribe: the handler loads the snapshot first (`apps/server/src/ws.ts:3366`), then builds the live stream from the two change PubSubs (`:3370`), then concatenates them. Handler at `apps/server/src/ws.ts:3363-3394`. `Stream.fromPubSub` subscribes only when the live part starts to run, which is after the snapshot item.
- Restart: lost; the client resubscribes and gets a new snapshot.
- Explicit or implicit: implicit.
- Gaps:
  - **E-G11.1** [lost information] A change published after the snapshot read and before the live subscription reaches no client. The later events carry single items, so the lost item stays missing until a new subscription. **Verdict:** confirmed. Tracked: t3code-181.
    - Evidence: probe `<probes>/ws.authAccess.probe.test.ts` (was `apps/server/src/ws.authAccess.probe.test.ts`; a copy of `ws.test.ts` plus one test), command `vp test run src/ws.authAccess.probe.test.ts -t "PROBE auth access"`, exit 0, 1 passed, 26 skipped. The test passes while it asserts the wrong behaviour: the first pairing link upsert is never delivered and the first live event is the second link with revision 2. Contrast: the config subscription subscribes before its snapshot, and its test says so (`apps/server/src/ws.test.ts:1001-1002`); the lifecycle subscription also subscribes first (`apps/server/src/ws.ts:3343-3362`).
    - Size (confirmed only): S. Effect on the user: the authorized-clients and pairing-links lists in Settings can miss a session or link that was created while the list was opening, until the client reconnects.

### E-M12. Settings file and keybindings file (server writer plus external writer)

- Owner: upstream
- Stored in: files (settings JSON, keybindings config); memory cache; secrets store for secret-valued settings.
- States: cache matches file; file changed externally and not yet reloaded; file unparsable.
- Transitions:
  - server write: `updateAndPersistSettings` reloads the file first, refuses when it cannot parse it, writes, sets the cache, emits. `apps/server/src/serverSettings.ts:1186-1260` (write lock `writeSemaphore`, `:687`).
  - external write: the file watcher revalidates and emits after a 100 ms debounce. `apps/server/src/serverSettings.ts:1272-1286`, `:1333-1336`.
  - start failure of either runtime is only logged: `apps/server/src/serverRuntimeStartup.ts:492`, `:506`.
- Restart: the file is the source; the cache is rebuilt.
- Explicit or implicit: implicit.
- Gaps:
  - **E-G12.1** [two writers] The server and an external editor both write the settings file. **Verdict:** refuted (the lost-update case is guarded).
    - Evidence: `apps/server/src/serverSettings.test.ts:450` ("keeps an external settings edit that the watcher has not reloaded yet"), `:492` ("refuses to save over a settings file it cannot parse"), `:139` (concurrent edits serialized). Command `vp test run src/serverSettings.test.ts`, exit 0, 75 passed. Keybindings: `apps/server/src/keybindings.test.ts:549`, `:590`; command `vp test run src/keybindings.test.ts`, exit 0, 21 passed.
  - **E-G12.2** [lost information] A failure to start the settings or keybindings runtime is only logged and the server continues. **Verdict:** confirmed. Tracked: t3code-223.
    - Code: `apps/server/src/serverRuntimeStartup.ts:486-515` (both starts wrapped in `Effect.catch` and `logWarning`), `apps/server/src/serverSettings.ts:1345-1363` (start runs once; the failure is kept), `apps/server/src/keybindings.ts:598-623` (same shape).
    - Probe 1: `serverRuntimeStartup.startFailure.probe.test.ts`.
      - Command: `vp test run src/serverRuntimeStartup.startFailure.probe.test.ts`. Exit code 0. 1 test passed.
      - Test: "PROBE G12.2 startup reaches ready after keybindings and settings start both fail: disabled-codex".
      - Shown: both starts ran once and failed. `awaitCommandReady` succeeds. The lifecycle events are welcome and ready. No event carries the failure text.
    - Probe 2: `serverSettings.startFailure.probe.test.ts`.
      - Command: `vp test run src/serverSettings.startFailure.probe.test.ts`. Exit code 0. 1 test passed.
      - Test: "PROBE G12.2 settings: a failed start is final; a second start does not retry after the cause is gone".
      - Shown: the first `start` fails with operation `prepare-directory`. After the cause is removed, a second `start` still fails and `ready` still fails. `getSettings` recovers and reads the file.
    - Limit: no probe runs the real keybindings service; only the startup mock covers it. The claim "the file watcher never runs after a failed start" follows from the code order and was not shown, because a real `fs.watch` needs wall-clock waits. An unparsable settings file does not make `start` fail; the trigger used is a settings directory that cannot be made. A grep found no production user of `.ready`.
    - Owner: upstream. Size: S.
    - User effect: after a rare start failure the server reports ready with no notice to the client, and it does not watch the settings or keybindings file for external edits until a restart.
    - First pass: Tried: code reading of `apps/server/src/serverRuntimeStartup.ts:488-515` only.

### E-M13. Terminal sessions

- Owner: upstream
- Stored in: memory (`managerStateRef`, `apps/server/src/terminal/Manager.ts:1643`; `closedSessionKeys`, `:1648`); history files under the logs directory.
- States: `"starting"`, `"running"`, `"exited"`, `"error"`; closed (removed from the map).
- Transitions:
  - -> starting: `startSession`, `apps/server/src/terminal/Manager.ts:2419` (status set at `:2434`).
  - starting -> running: `:2512`. starting -> error: `:2557`.
  - running -> exited: process exit, `:2266`; `stopProcess`, `:2327` (status at `:2338`).
  - any -> closed: `closeSession`, `:2592`; eviction of inactive sessions above 128, `:2178` (limit at `:112`).
  - output -> history file: `queuePersist` (`:1971`) feeds a worker that sleeps 250 ms (`:1949`, constant at `:100`) and then writes (`:1957-1968`; a write failure is only logged).
  - shutdown: the finalizer kills the processes and clears the map. `apps/server/src/terminal/Manager.ts:2815-2842`. It does not drain the persist worker.
- Restart: sessions and processes are lost; history files stay. I did not verify what happens to PTY children after a crash.
- Explicit or implicit: implicit; the status field is written at several places with no transition check.
- Gaps:
  - **E-G13.1** [state lost on restart] Output that subscribers already received is missing from the history file when the server stops inside the 250 ms debounce. **Verdict:** confirmed. Tracked: t3code-182.
    - Evidence: probe `<probes>/Manager.shutdown.probe.test.ts` (was `apps/server/src/terminal/Manager.shutdown.probe.test.ts`; the head of `Manager.test.ts` plus one test), command `vp test run src/terminal/Manager.shutdown.probe.test.ts -t "PROBE shutdown"`, exit 0, 1 passed, 79 skipped. The test passes while it asserts the wrong behaviour. Control: `apps/server/src/terminal/Manager.test.ts:1021` shows that an explicit close does persist; command `vp test run src/terminal/Manager.test.ts`, exit 0, 79 passed.
    - Size (confirmed only): S. Effect on the user: after a server stop or restart, restored terminal scrollback can lack the last output.

### E-M14. Relay agent-activity publish state

- Owner: both (upstream module; the fork added the publish-settings cache and the catch-up calls)
- Stored in: memory (`publishSettings` and `publishSettingsGeneration`, `apps/server/src/relay/AgentAwarenessRelay.ts:446-452`; `cachedRelayClient`, `:482`; `publishedRelayConfig`, `:483`; `publishConfirmDeadlines`, `:486`; `heldCompletions`, `:488`; `publishRetries`, `:490`); the relay credentials are in the secrets store, which the CLI in another process also writes.
- States: startup `waiting-for-link` | `disabled` | `enabled` (`:950-968`); catch-up loop result `published` | `unlinked` | `disabled` | `failed` (`:850-896`, `:902-928`); per thread: idle, queued, retry scheduled (attempt 1 to 5), retry budget exhausted, confirmation pending, completion held; settings cache fresh or stale.
- Transitions:
  - publish fails -> retry scheduled: `:798-808`; delays 1, 2, 4, 8, 16 s (`:199`), timer at `:833-842`.
  - retry budget exhausted: logged, the entry stays until activity or success. `:823-827`.
  - catch-up loop: after `published` it waits for a catch-up request (`:919`); otherwise it retries after 5 s, or 5 s doubling to 60 s while unlinked (`:922-926`).
  - settings cache: reused for 5 s (`PUBLISH_SETTINGS_LIFETIME_MS`, `:201`; check at `:460-465`); dropped by `forgetPublishSettings` on a publish failure (`:803`) and on `requestCatchUp` (`:992-995`); a read that started before the drop does not store its value (`:466-469`).
  - cloud unlink and rollback call `requestCatchUp`: `apps/server/src/cloud/CloudLink.ts:1348-1349` and `:1412-1413` (fork lines; file not read whole).
- Restart: all memory state is lost; `start` publishes a snapshot of active threads again after 1 second (`:969-973`).
- Explicit or implicit: implicit; many maps and flags in one closure.
- Gaps:
  - **E-G14.1** [cache staleness] After another process changes the relay link, publishes use the old settings for up to 5 seconds. **Verdict:** by design.
    - Evidence: comment at `apps/server/src/relay/AgentAwarenessRelay.ts:443-445` states the intent; `apps/server/src/relay/AgentAwarenessRelay.test.ts:528` ("republishes unchanged state with fresh credentials after relinking") pins both exits, the catch-up request and the 5 second lifetime; `:507` pins the shared read. Command `vp test run src/relay/AgentAwarenessRelay.test.ts`, exit 0, 20 passed.
  - **E-G14.2** [state with no exit] A thread whose retry budget is exhausted is not published again until new activity or a catch-up. **Verdict:** by design. Tracked: t3code-224.
    - Intent: `apps/server/src/relay/AgentAwarenessRelay.ts:824`, comment "Retain exhausted budgets until activity or success resets them; old timers must not restart retries." The budget is `:199` (`[1_000, 2_000, 4_000, 8_000, 16_000]`). `git blame` puts these lines upstream.
    - Probe: `AgentAwarenessRelay.retryBudget.probe.test.ts` (the head of `AgentAwarenessRelay.test.ts`, lines 1-335, plus one test).
    - Command: `vp test run src/relay/AgentAwarenessRelay.retryBudget.probe.test.ts -t "PROBE G14.2"`. Exit code 0. 1 test passed, 1 skipped.
    - Test: "PROBE G14.2 after six failed publishes a thread is not published again until new activity".
    - Shown: with the relay at HTTP 503, the thread publishes once and retries after 1, 2, 4, 8 and 16 seconds (six requests in 31 seconds). The relay then answers again. No request follows in the next 24 hours. A new `publishThread` call for the thread then sends request seven.
    - Limit: the comment states why the budget is kept (old timers must not restart retries). It does not say that a relay outage longer than 31 seconds may drop the last state of a thread that has no later activity. The probe did not check a full new retry budget after the new activity, and it did not run the startup catch-up path. No existing test names the exhausted budget.
    - Consequence to note, not a verdict: when the relay is down for more than 31 seconds, the final activity state of a thread (for example "completed") does not reach the relay unless the thread has new activity. A product owner may want a re-publish on relay recovery; that is a design choice.
    - First pass: Tried: code reading of `:820-848`; the comment at `:824` states it is intended, but I ran no test that pins it by name.

### E-M15. Peer link requests (cards) and peer links

- Owner: upstream
- Stored in: link request card: a turn item in the thread projection, written through the `link_request.record` command (Area A reducer). Peer link: SQLite `peer_environment_links` row plus a token in the secrets store under `secret_name`.
- States: card `pending` | `linked` | `failed` | `declined` | `cancelled` (`apps/server/src/peer/PeerLinkRequests.ts:405-421`). Link: stored and usable; `expired`; `unreachable`; `reachable` (`apps/server/src/peer/PeerLinks.ts:574-588`); removed.
- Transitions:
  - none -> pending: `request`, `apps/server/src/peer/PeerLinkRequests.ts:256-282`; a retry with the same `clientRequestId` returns the existing card (`:235-238`).
  - pending -> linked | failed | declined: `answer`, guarded by `card.linkStatus !== "pending"` at `:351` under a per-card lock (`:147`, applied at `:382`).
  - pending -> linked on a retry that names a machine linked meanwhile: `closeAsLinked`, `:153-172` (guard at `:158-165`).
  - pending -> cancelled: Stop or archive of the thread (Area A; comment at `:366-367`).
  - link stored: token written first (`apps/server/src/peer/PeerLinks.ts:528-530`), then the row (`:535-554`); on a row error the token is removed (`:556`); the previous token is removed after (`:559-561`).
  - link removed: row deleted, then token removed (`:610-616`).
  - link expired: by clock, checked at each use (`:578`, `:631`; `apps/server/src/peer/PeerLinkRequests.ts:109-114`).
- Restart: rows, tokens and cards survive. The per-card lock is memory only.
- Explicit or implicit: card states are explicit (one status field with one guard); the link's row-plus-token pair is implicit.
- Gaps:
  - **E-G15.1** [one state in two places that can disagree] A crash between the token write and the row write leaves a token that no row names. A failure of the token removal after the row delete in `unlink` leaves the same. **Verdict:** confirmed. Tracked: t3code-221.
    - Code: `apps/server/src/peer/PeerLinks.ts:523-563` (token set, then row insert; previous token removal is ignored at `:559-561`) and `:608-618` (row delete, then token removal). No sweep of `peer-link-*` secrets exists.
    - Probe: `PeerLinks.orphanToken.probe.test.ts`.
    - Command: `vp test run src/peer/PeerLinks.orphanToken.probe.test.ts`. Exit code 0. 2 tests passed.
    - Tests:
      - "PROBE G15.1 unlink: a failed token removal leaves a token that no row names, and no retry removes it"
      - "PROBE G15.1 link: an interrupt after the token lands and before the row write leaves a token with no row"
    - Shown: the token stays in the secret store while no row names it. A second unlink finds no row and removes nothing. A re-link ignores a failed removal of the previous token.
    - Limit: the removal failure is injected (`SecretStoreRemoveError`). The interrupt test stalls inside a wrapped `set` after the real write. That stands for the yield after rename at `ServerSecretStore.ts:204-205` and for a process death there. A real process crash was not run.
    - Owner: upstream. Size: S.
    - User effect: a peer access token stays on disk after the user removed the link, and nothing removes it.
    - First pass: Tried: code reading; `apps/server/src/peer/PeerLinks.test.ts:248` ("a link whose row cannot be stored keeps none of its token") pins the error path only, not a crash. No probe. - Pinned behaviour, no gap: `apps/server/src/peer/PeerLinkRequests.test.ts:685` (Stop closes the card, which then takes no answer), `:628`, `:794`, `:1031`, `:1060`. Commands `vp test run src/peer/PeerLinkRequests.test.ts` (exit 0, 20 passed), `vp test run src/peer/PeerLinks.test.ts` (exit 0, 19 passed).

### E-M16. Telemetry buffer and flush

- Owner: upstream
- Stored in: memory (`bufferRef`, `apps/server/src/telemetry/AnalyticsService.ts:150`; `deliveryRef`, `:151-157`).
- States: empty; buffered; failed batch waiting for `retryAt`; batch dropped.
- Transitions:
  - record -> buffered; the oldest event is dropped when the buffer is full. `:167-197`, `:312-328`.
  - buffered -> sent: `flush`, `:244-303`, each 10 s when due (`:353-355`, interval at `:43`).
  - send fails -> failed batch kept for up to 30 minutes (`:274-286`, limit at `:51`); a rejected status, or 30 minutes of failures -> dropped with a warning (`:288-301`).
  - shutdown: one flush with a 1 second limit, errors ignored. `:357-359` (limit at `:47`).
- Restart: buffered and failed batches are lost.
- Explicit or implicit: explicit; one `DeliveryState` record and one flush loop.
- Gaps:
  - **E-G16.1** [state lost on restart] Events still in the buffer are lost on a crash, and on a stop when the endpoint does not answer in 1 second. **Verdict:** by design.
    - Evidence: `apps/server/src/telemetry/AnalyticsService.test.ts:280` ("shutdown stops waiting for a telemetry endpoint that never answers"), `:245` ("drops a batch that keeps failing for 30 minutes"); the comment at `apps/server/src/telemetry/AnalyticsService.ts:316` calls telemetry best-effort. Command `vp test run src/telemetry/AnalyticsService.test.ts`, exit 0, 9 passed.

### Area E: other points

- **E-P1** wait without limit: an HTTP request waits for command readiness with no timeout, and a queued command does the same, `apps/server/src/server.ts:779-785` and `apps/server/src/serverRuntimeStartup.ts:133`. **Verdict:** confirmed. Tracked: t3code-185.
  - Evidence: probe `<probes>/serverRuntimeStartup.gate.probe.test.ts` (was `apps/server/src/serverRuntimeStartup.gate.probe.test.ts`), command `vp test run src/serverRuntimeStartup.gate.probe.test.ts -t "PROBE"`, exit 0, 1 passed. The test passes while it asserts the wrong behaviour: both waits are still pending after `TestClock.adjust("24 hours")`. Limits of the claim: the wait does end when a start phase fails (`apps/server/src/serverRuntimeStartup.ts:688-706`) or the scope closes (`:457-459`); it has no limit only when a phase hangs. I found no document that states an intent.
  - Owner: upstream. Size S.
- **E-P2** untested state: the `subscribeAuthAccess` handler has no test, `apps/server/src/ws.ts:3363`. **Verdict:** confirmed. Tracked: t3code-181.
  - Evidence: `grep -rn "subscribeAuthAccess" apps/server/src` finds the name only in `ws.ts:3363`, `auth/RpcAuthorization.ts:217` and `observability/RpcInstrumentation.ts:231`. This is why G11.1 went unseen.
  - Owner: upstream.
- **E-P3** untested state: the Windows and init-parent branch of the launcher watch (`apps/server/src/launcherWatch.ts:24`) has no test; `apps/server/src/launcherWatch.test.ts` holds one test (`:17`). **Verdict:** confirmed by the test list of that file (`vp test run src/launcherWatch.test.ts`, exit 0, 1 passed). Tracked: t3code-186.
  - Owner: upstream.
- **E-P4** lost information: a terminal history write failure is only logged, `apps/server/src/terminal/Manager.ts:1957-1968`. **Verdict:** confirmed. Tracked: t3code-182.
  - Code: `apps/server/src/terminal/Manager.ts:1957-1968`.
  - Probe: `Manager.historyWrite.probe.test.ts` (the head of the first-pass `Manager.shutdown.probe.test.ts` plus one test).
  - Command: `vp test run src/terminal/Manager.historyWrite.probe.test.ts -t "PROBE P4"`. Exit code 0. 1 test passed, 79 skipped.
  - Test: "PROBE P4 a failed history write is silent: close succeeds, no event reports it, the scrollback is gone".
  - Shown: `writeFileString` under the terminal log directory fails with ENOSPC. `manager.close` succeeds. The event types seen are exactly `closed`, `output`, `started`. After the fault is gone the history file does not exist, and a reopen returns history `""`.
  - Limit: the ENOSPC is injected through a wrapped `FileSystem`. No document, comment or test states an intent for this failure.
  - Owner: upstream. Size: S.
  - User effect: when the history write fails, for example on a full disk, the terminal scrollback is lost on close or restart and the user gets no notice.
  - First pass: Tried: code reading only.

## Area F: Web client and `packages/client-runtime`

### Area F: evidence conventions

Scope: `packages/client-runtime/src/**` and `apps/web/src/**` at HEAD `22b65998f3` (equal to `origin/fork`).
The fork changes 9 files in this area (`git diff origin/main...origin/fork`); none of them holds a state machine.
So every machine below has owner `upstream`.
"Restart" below means: the browser tab reloads, or the desktop app restarts.

Probe directory: `<archive>/probes/F/`.
Each probe ran beside the code, then moved to the probe directory. To run one again, copy it back to the "ran as" path.
All six probes pass while they assert the wrong (or questioned) behaviour. None fails.

| Probe file                                     | Ran as                                                                    | Command (from the package directory)                           | Result           |
| ---------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------- | ---------------- |
| `shell-defect.probe.test.ts`                   | `packages/client-runtime/src/state/shell-defect.probe.test.ts`            | `vp test run src/state/shell-defect.probe.test.ts`             | exit 0, 2 passed |
| `supervisor-offline.probe.test.ts`             | `packages/client-runtime/src/connection/supervisor-offline.probe.test.ts` | `vp test run src/connection/supervisor-offline.probe.test.ts`  | exit 0, 2 passed |
| `command-lane.probe.test.ts`                   | `packages/client-runtime/src/state/command-lane.probe.test.ts`            | `vp test run src/state/command-lane.probe.test.ts`             | exit 0, 1 passed |
| `composerDraftStore.two-tabs.probe.test.ts`    | `apps/web/src/composerDraftStore.two-tabs.probe.test.ts`                  | `vp test run src/composerDraftStore.two-tabs.probe.test.ts`    | exit 0, 1 passed |
| `composerDraftStore.send-reload.probe.test.ts` | `apps/web/src/composerDraftStore.send-reload.probe.test.ts`               | `vp test run src/composerDraftStore.send-reload.probe.test.ts` | exit 0, 1 passed |
| `storage.two-tabs.probe.test.ts`               | `apps/web/src/connection/storage.two-tabs.probe.test.ts`                  | `vp test run src/connection/storage.two-tabs.probe.test.ts`    | exit 0, 1 passed |

Existing tests that this report cites, and the runs that I made:

- From `packages/client-runtime`: `vp test run src/connection/registry.test.ts src/connection/supervisor.test.ts src/state/runtime.test.ts src/queuedRunEdit.test.ts src/state/threadCommands.test.ts src/state/shell-sync.test.ts src/state/threadHistoryController.test.ts` gave exit 0, 7 files, 211 tests passed.
- From `packages/client-runtime`: `vp test run src/operations/commands.test.ts` gave exit 0, 16 tests passed.
- From `apps/web`: `vp test run src/connection/storage.test.ts src/closedViewStore.test.ts src/reopenClosedView.test.ts src/components/chat/optimisticUserMessages.test.ts` gave exit 0, 4 files, 44 tests passed.

Second pass:

This section gives a verdict to each gap that had `no verdict`. It changes no first-pass text.
All probes are in `<archive>/probes/F/`. Each run log (`run-*.log`) is in the same directory.
Each probe ran beside the code and then moved to that directory. `git status --short` shows no file of this area.
Every owner below is upstream: each commit is an ancestor of `origin/main`, and `git diff --stat origin/main...origin/fork` shows no change to the files.

### F-M1. Connection lifecycle of one environment (supervisor)

- Owner: upstream
- Stored in: memory (`SubscriptionRef` state of the supervisor, `packages/client-runtime/src/connection/supervisor.ts`). The web client maps it to a label in `packages/client-runtime/src/connection/presentation.ts:36`.
- States: `available`, `offline`, `connecting` (stages `preparing`, `opening`, `synchronizing`), `backoff`, `connected`, `blocked` (`packages/client-runtime/src/connection/model.ts:159`).
- Transitions (one loop owns all of them, `packages/client-runtime/src/connection/supervisor.ts:1119`):
  - any -> `available`: the environment is not desired. Enforced at `packages/client-runtime/src/connection/supervisor.ts:1137`.
  - any -> `offline`: the network report is `offline` and no replacement is in progress. Enforced at `packages/client-runtime/src/connection/supervisor.ts:1145`. The loop then waits for a signal and re-enters this branch while the report stays `offline`.
  - attempt failed with a blocked error -> `blocked`: enforced at `packages/client-runtime/src/connection/supervisor.ts:1186`. It waits for a signal.
  - failed probe of a live session -> `connecting`, attempt 1: enforced at `packages/client-runtime/src/connection/supervisor.ts:1205`.
  - attempt failed with a transient error -> `backoff`: enforced at `packages/client-runtime/src/connection/supervisor.ts:1225`.
  - network status for a `PrimaryConnectionTarget` never parks: `offline` reads as `unknown`. Enforced at `packages/client-runtime/src/connection/supervisor.ts:299`.
- Restart: all states are lost. The supervisor starts again from the saved catalog entry (M2, M12).
- Explicit or implicit: explicit. One named phase type and one loop own every transition; `supervisor.test.ts` covers them (run above, exit 0).
- Gaps:
  - **F-G1.1** [state with no exit] `offline` has no time limit. It waits until the network report changes. **Verdict:** by design.
    - Evidence: `docs/internals/connection-runtime.md:16` ("Offline states and authentication failures wait for a wakeup"); test `packages/client-runtime/src/connection/supervisor.test.ts:338` passes (run above, exit 0).
  - **F-G1.2** [state with no exit] A saved bearer route to a reachable address (loopback, LAN) parks in `offline` while the browser reports offline. Explicit retry, `connect` and an app wakeup start no attempt. Only `PrimaryConnectionTarget` is exempt (`packages/client-runtime/src/connection/supervisor.ts:296`). The web network status is `navigator.onLine` (`apps/web/src/connection/platform.ts:72`). The document itself says "Offline reports are often wrong, for example for a loopback server" (`docs/internals/connection-runtime.md:20`). **Verdict:** confirmed. Tracked: t3code-191.
    - Evidence: probe `supervisor-offline.probe.test.ts`. A `BearerConnectionTarget` at `http://127.0.0.1:3774/` with network `offline`: after `retryNow`, an `application-active` wakeup, `connect` and 20 hours of `TestClock`, the phase is `offline` and `prepareCount` is 0. The control case with `online` connects with `prepareCount` 1. The probe passes while it asserts the questioned behaviour.
    - Size (confirmed only): S. Effect on the user: with no network interface up, the user cannot connect to a saved local server URL, and the Retry button does nothing.
  - **F-G1.3** [state with no exit] `blocked` waits with no time limit for an external signal. **Verdict:** by design.
    - Evidence: `docs/internals/connection-runtime.md:16`; test `packages/client-runtime/src/connection/supervisor.test.ts:493` passes (run above, exit 0).

### F-M2. Catalog entry and its compatibility flag (environment registry)

- Owner: upstream
- Stored in: memory for `unsupportedReason` and `serverUpdateRequired`, written by `setCompatibility` (`packages/client-runtime/src/connection/registry.ts:1143`); the saved catalog document for targets, profiles, credentials and the disabled list (see M12).
- States: compatible (no flag), unsupported (flag holds the message), unsupported with `serverUpdateRequired`; and separately enabled or disabled.
- Transitions:
  - compatible -> unsupported: the supervisor reaches `blocked` with reason `unsupported`. Enforced at `packages/client-runtime/src/connection/registry.ts:385`.
  - any -> set or cleared by relay discovery, only for a saved entry with exactly one relay route. Enforced at `packages/client-runtime/src/connection/layer.ts:61`.
  - unsupported -> compatible by a manual enable: only when the entry has a saved bearer route. Enforced at `packages/client-runtime/src/connection/registry.ts:1064`. Otherwise the enable fails with `unsupported`.
  - unsupported -> compatible after a host update: `packages/client-runtime/src/connection/outdatedHostUpdate.ts:92`.
  - unsupported is kept when the platform refreshes the same endpoint: `packages/client-runtime/src/connection/registry.ts:635`.
- Restart: the flag is lost. The next start tries the connection again.
- Explicit or implicit: implicit. Four call sites write the flag; no single function lists the legal changes.
- Gaps:
  - **F-G2.1** [state with no exit] An entry with no saved bearer route (relay only with no fresh discovery result, or SSH only) cannot leave `unsupported` by a manual enable. Its exits are discovery, the host update flow, or a restart. **Verdict:** split. Relay-only entry: by design; SSH-only entry: confirmed. Tracked: t3code-231.
    - Relay-only entry: by design.
      - Intent: `packages/client-runtime/src/connection/routes.ts:194` says "Learned routes alone must not make relay environments manually retryable."
      - Behaviour: the existing test at `packages/client-runtime/src/connection/registry.test.ts:929` passes for a relay-only entry and for a relay entry with a learned bearer route.
    - SSH-only entry: confirmed.
      - Probe: `registry.unsupported-ssh.probe.test.ts`. It uses the harness of `registry.test.ts` (lines 1 to 546, copied) and a `TestClock`.
      - Command, from `packages/client-runtime`: `vp test run src/connection/registry.unsupported-ssh.probe.test.ts`. Exit code 0. 1 test passed.
      - Test "probe F-8: an SSH-only entry stays unsupported after a hand update; manual enable is refused".
      - After the host accepts the protocol again, `setEnabled(true)` fails with `ConnectionBlockedError`, reason `unsupported`.
      - `retryNow`, 40 hours of test time, and off-then-on do not start a prepare. The session count stays 0.
      - Control: `setCompatibility(null)` and then `setEnabled(true)` connects. The session count becomes 1.
      - Limit of the proof: the probe injects the rejection at the harness prepare step. I did not probe the update flow (`updateOutdatedHost`), which is the exit when `serverUpdateRequired` is true.
      - Owner: upstream. Commit 9878f487fa "fix(connections): retry unsupported saved direct connections (#15107)" added the retry for saved bearer routes only. `packages/client-runtime/src/connection/layer.ts:42-45` counts SSH as a direct connection.
      - Size: S. `hasSavedBearerRoute` (`routes.ts:194-196`) must also accept an SSH route.
      - Effect on the user: after the user updates an SSH host by hand, to enable that environment fails with the old "unsupported" message until the app reloads, unless the app offers the Update button.
    - First pass: Evidence: what I tried: I read `packages/client-runtime/src/connection/registry.test.ts:929` to `:1112` and `:1817`. The refusal is pinned at `packages/client-runtime/src/connection/registry.test.ts:956`; recovery through `setCompatibility(null)` at `:960`; relaunch at `:977`; all pass (run above, exit 0). I wrote no probe for an SSH-only entry whose server was updated by hand, so I cannot say that it stays blocked.

### F-M3. RPC request and command lanes

- Owner: upstream
- Stored in: memory (`WeakMap` of lanes per atom registry, `packages/client-runtime/src/state/runtime.ts:203`).
- States (per lane key): idle, running, running with waiters. Modes: `parallel`, `singleFlight` (`packages/client-runtime/src/state/runtime.ts:233`), `serial` (`:257`), `latest` (`:276`).
- Transitions:
  - idle -> running: `schedule` runs `execute`. Enforced at `packages/client-runtime/src/state/runtime.ts:259`.
  - running -> running with waiters: a later command chains on the earlier promise. Enforced at `packages/client-runtime/src/state/runtime.ts:259`.
  - running -> idle: the promise settles and the lane entry is deleted. Enforced at `packages/client-runtime/src/state/runtime.ts:261`.
  - request -> answer: `requestInSession` awaits the RPC method with no time limit. `packages/client-runtime/src/rpc/client.ts:220`.
  - All thread commands of one thread share one serial lane: send, Stop, approval answers, user-input answers, settle, snooze, pin, archive, delete, queued-run edit. `packages/client-runtime/src/state/threadCommands.ts:77`. History paging has its own lane (`packages/client-runtime/src/state/threadCommands.ts:375`).
- Restart: all lanes and all requests in flight are lost. The server replays an accepted `commandId` from its receipt (comment at `packages/client-runtime/src/operations/commands.ts:290`); that boundary belongs to the server areas.
- Explicit or implicit: explicit for the lanes (one scheduler); implicit for the request, which has no deadline state.
- Gaps:
  - **F-G3.1** [state with no exit] A thread command that gets no answer on a live socket holds the lane for ever. Stop, approval answers and every later command of that thread are never sent. Their optimistic values stay on screen (M7). The 15 second ping (`packages/client-runtime/src/rpc/protocol.ts:12`) only drops a dead socket; it does not bound one request. **Verdict:** confirmed. Tracked: t3code-192.
    - Evidence: probe `command-lane.probe.test.ts`, built on the harness of `packages/client-runtime/src/state/threadCommands.test.ts`. `settle` is sent and gets no answer. `interruptTurn` and `pin` are then called. After 60 minutes of `TestClock`, the request queue is empty, neither promise has settled, the thread shows the optimistic pin, and the thread id is in `pendingThreadIdsAtom`. Control: after the first answer arrives, `run.interrupt` and `thread.pin` are sent in order. The probe passes while it asserts the wrong behaviour. Limit of the probe: I did not make a real server leave a request without an answer; the probe shows what the client does when that happens.
    - Size (confirmed only): M. Effect on the user: one stuck request on a thread makes Stop and approval answers on that thread do nothing until the page reloads.
  - **F-G3.2** [wait without limit] A send that loses its socket waits for a replacement session while the supervisor is in `offline` or `backoff`, with no time limit (`packages/client-runtime/src/operations/commands.ts:311`). **Verdict:** by design.
    - Evidence: comment at `packages/client-runtime/src/operations/commands.ts:290`; tests `packages/client-runtime/src/operations/commands.test.ts:370` and `:422` pass (run above, exit 0). `docs/internals/connection-runtime.md:131` states that reconnection does not replay other mutations.

### F-M4. Durable subscription (resume over sessions)

- Owner: upstream
- Stored in: memory (stream inside `subscribeDynamicMapped`, `packages/client-runtime/src/rpc/client.ts:277`).
- States: waiting for a session, subscribed, draining after a transport failure, waiting to retry after an expected failure, parked after a defect, failed (stream ended).
- Transitions:
  - subscribed -> draining: transport failure. Enforced at `packages/client-runtime/src/rpc/client.ts:364`.
  - subscribed -> waiting to retry: only expected failures and the caller gave `onExpectedFailure`. Enforced at `packages/client-runtime/src/rpc/client.ts:376`.
  - subscribed -> parked: a defect, and the caller gave `onDefect`. Enforced at `packages/client-runtime/src/rpc/client.ts:400`.
  - subscribed -> failed: a defect with no `onDefect`. Enforced at `packages/client-runtime/src/rpc/client.ts:403`. The whole subscription ends.
  - any -> subscribed: a new session or a `resubscribe` signal.
- Restart: lost. The caller subscribes again with its cached cursor (M5, M6).
- Explicit or implicit: implicit. The states are branches of one stream expression; the caller decides by the options that it passes whether `failed` can happen.
- Gaps:
  - see G5.1, which is the caller that does not pass `onDefect`.

### F-M5. Shell sync of one environment (thread list)

- Owner: upstream
- Stored in: memory (`SubscriptionRef` in `packages/client-runtime/src/state/shell.ts`); the snapshot is also cached in IndexedDB (web store `shell`, see M12).
- States: `empty`, `cached`, `synchronizing`, `live` (`packages/client-runtime/src/state/shell.ts:44`); plus an `error` field and the `awaitingCompletion` flag.
- Transitions:
  - any -> `synchronizing` at start: `packages/client-runtime/src/state/shell.ts:449`.
  - any -> disconnected form: `setDisconnected`, `packages/client-runtime/src/state/shell.ts:208`.
  - not `live` -> `synchronizing` on ready: `setReady`, `packages/client-runtime/src/state/shell.ts:223`.
  - `synchronizing` -> `live`: the `synchronized` marker (`packages/client-runtime/src/state/shell.ts:309`) or a snapshot with nothing left to wait for (`:333`).
  - items of an old session are dropped: `packages/client-runtime/src/state/shell.ts:259`.
  - `snapshot-required` -> reload request, origin cleared: `packages/client-runtime/src/state/shell.ts:342`.
  - resume with `afterSequence` and the HTTP snapshot fallback: `packages/client-runtime/src/state/shell.ts:534`.
  - Two writers of the status: the subscription fiber (`packages/client-runtime/src/state/shell.ts:450`) and the supervisor watcher (`:547`).
- Restart: `live` and `synchronizing` are lost; the cached snapshot gives `cached`, then a resume by sequence.
- Explicit or implicit: implicit. A status enum exists, but six setters and two fibers write it and no function checks a transition.
- Gaps:
  - **F-G5.1** [state with no exit] A defect on the shell stream ends the forked subscription fiber. No later session subscribes again. The status stays `synchronizing`, with no error, while the connection shows `connected`. The options at `packages/client-runtime/src/state/shell.ts:540` have no `onDefect`, and `applyItems` runs at `:545`, outside the subscription's own failure handling. The thread subscription handles the same case (`packages/client-runtime/src/state/threads.ts:1112` and `:1140`), added by upstream commit `8ab024f31a` ("a thread keeps syncing after a stream defect"); the shell did not get that change. **Verdict:** confirmed. Tracked: t3code-193.
    - Evidence: probe `shell-defect.probe.test.ts`. Control: the first session's stream fails with a transport error; after a session replace the subscriptions are `["first","second"]` and the status is `live`. Defect case: the first stream dies with `Error("decode failed")`; after the same session replace and 20 minutes of `TestClock`, the subscriptions are `["first"]`, there is no snapshot, no error, and the status is `synchronizing`. The probe passes while it asserts the wrong behaviour. Limit: the probe injects the defect; I did not find which real message makes one. Two candidates from reading: a chunk that fails schema decode, and a throw inside `applyItems`.
    - Size (confirmed only): S. Effect on the user: the thread list of that environment stops updating until the page reloads, and nothing on screen says so.
  - **F-G5.2** [untested state] `shell-sync.test.ts` has no case with a defect (`grep -n "Stream.die\|Effect.die\|defect"` finds nothing). **Verdict:** confirmed. Tracked: t3code-193.
    - Evidence: the grep above, and probe `shell-defect.probe.test.ts`.

### F-M6. Thread detail sync and history paging

- Owner: upstream
- Stored in: memory (`packages/client-runtime/src/state/threads.ts`); the thread snapshot is also cached in IndexedDB (web store `thread`).
- States: `empty`, `cached`, `synchronizing`, `live`, `deleted` (`packages/client-runtime/src/state/threadState.ts:6`); history has `loading`, `hasMoreHistory` and a cursor.
- Transitions:
  - subscribe, resume, HTTP snapshot: `followThread`, from `packages/client-runtime/src/state/threads.ts:999`.
  - any -> `deleted`: HTTP reports `missing`; then a backoff and a resubscribe. Enforced at `packages/client-runtime/src/state/threads.ts:1074`.
  - `deleted` with no miss counted parks: `packages/client-runtime/src/state/threads.ts:1009`.
  - defect on the stream -> report, back off, resubscribe: `packages/client-runtime/src/state/threads.ts:1112`.
  - defect while applying items -> resubscribe for a fresh snapshot: `packages/client-runtime/src/state/threads.ts:1140`.
  - history idle -> loading: guarded by `noop` (`packages/client-runtime/src/state/threads.ts:718`) and `busy` (`:725`).
  - history loading -> idle: a page that does not advance fails the load (`packages/client-runtime/src/state/threads.ts:799`); an interrupt clears the flag (`:852`).
  - history handler registry: only the owner of a slot can remove it (`packages/client-runtime/src/state/threadHistoryController.ts:77`); no handler gives `noop` (`:92`).
- Restart: all states are lost; the cache gives `cached`, then a resume.
- Explicit or implicit: implicit, the same shape as M5, but with handling for defects.
- Gaps:
  - none found. I wrote no probe here. The existing tests `threadHistoryController.test.ts` and `threadCommands.test.ts` pass (run above, exit 0).

### F-M7. Optimistic thread list values (settle, snooze, pin, archive and others)

- Owner: upstream
- Stored in: memory (`pendingAtom` per environment, `packages/client-runtime/src/state/threadLifecycle.ts:23`).
- States: pending (not confirmed), confirmed (has a sequence), removed.
- Transitions:
  - none -> pending: the wrapped command starts. Enforced at `packages/client-runtime/src/state/threadLifecycle.ts:84`.
  - pending -> confirmed: the command succeeds with a sequence. Enforced at `packages/client-runtime/src/state/threadLifecycle.ts:89`.
  - pending -> removed: the command fails. Enforced at `packages/client-runtime/src/state/threadLifecycle.ts:103`.
  - confirmed -> removed: the shell snapshot reaches the sequence, or becomes null. Enforced at `packages/client-runtime/src/state/threadLifecycle.ts:92`.
- Restart: lost. The server state shows.
- Explicit or implicit: explicit. One small module owns it.
- Gaps:
  - **F-G7.1** [state with no exit] A pending value has no time limit. It stays while its command waits in a lane (G3.1). **Verdict:** confirmed. Tracked: t3code-192.
    - Evidence: probe `command-lane.probe.test.ts` (the optimistic pin and the id in `pendingThreadIdsAtom` stay after 60 minutes).
    - Size (confirmed only): S (the cause is G3.1). Effect on the user: the list shows a change that the server never received.
  - **F-G7.2** [state with no exit] A confirmed value waits for the shell snapshot to reach its sequence. When the shell stream has stopped (G5.1), it stays for ever. **Verdict:** by design.
    - Intent: the comment at `packages/client-runtime/src/state/threadLifecycle.ts:51` says "Until the durable snapshot catches up, an older pending update can still replace what shows." The test name at `packages/client-runtime/src/state/threadCommands.test.ts:338` says "keeps the preview after acknowledgement until the matching shell update arrives".
    - Behaviour: probe `confirmed-pending.probe.test.ts`, test "probe F-9: an acknowledged pin stays a pending update while the shell snapshot does not advance".
    - Command, from `packages/client-runtime`: `vp test run src/state/confirmed-pending.probe.test.ts src/queuedRunEdit.test.ts`. Exit code 0. 2 files, 19 tests passed.
    - The pin is acknowledged at sequence 5. The snapshot stays at 1 for 60 hours of test time, and the thread stays pending. A snapshot at 4 keeps it. A snapshot at 5 removes it.
    - Limit of the proof:
      - The kept value equals the value that the server accepted, so the list shows no wrong value.
      - The state has no exit only when the snapshot stream stalls, which is gap G5.1.
      - One side effect: `apps/web/src/composerDraftStore.ts:4394` skips draft model reconciliation for a thread that is pending.
    - First pass: Evidence: what I tried: I read the module and the test at `packages/client-runtime/src/state/threadCommands.test.ts:338`, which pins "keeps the preview after acknowledgement until the matching shell update arrives" (run above, exit 0). I wrote no probe that joins this with G5.1.

### F-M8. Queued message edit

- Owner: upstream
- Stored in: memory (`packages/client-runtime/src/queuedRunEdit.ts:94` for the edit, `:98` for the saving flag, `:103` for the exit watch).
- States: no edit, editing (watch active), saving (watch paused), ended.
- Transitions:
  - none -> editing: `begin`, `packages/client-runtime/src/queuedRunEdit.ts:166`.
  - editing -> ended: `end` (`:184`), or the run left the queue (`:137`).
  - editing -> saving: `startSave`, refused while a save is in flight (`packages/client-runtime/src/queuedRunEdit.ts:196`).
  - saving -> ended on success, saving -> editing on failure: `packages/client-runtime/src/queuedRunEdit.ts:206` and `:211`.
- Restart: the edit text is lost.
- Explicit or implicit: explicit. One store owns every transition and `queuedRunEdit.test.ts` passes (run above, exit 0).
- Gaps:
  - **F-G8.1** [state with no exit] `saving` ends only when the save settles. The save goes through the thread's serial lane, so G3.1 can hold it for ever, and `startSave` then returns null for that thread. **Verdict:** by design.
    - Intent: the doc comment on `startSave` at `packages/client-runtime/src/queuedRunEdit.ts:191` says "The claim outlives the edit: the server orders saves by arrival, so an overlapping older save could overwrite a newer one."
    - Behaviour: the existing test at `packages/client-runtime/src/queuedRunEdit.test.ts:134`, "keeps the save claimed until it settles, even when the edit is begun again or ended".
    - Command: the same run as G7.2. Exit code 0.
    - Limit of the proof:
      - The store has no timer. A claim that never settles needs a command that never settles, which is gap G3.1.
      - The web caller `apps/web/src/components/chat/useQueuedRunEdit.ts:362-372` calls `finishSave` after `await submitQueuedRunEdit` with no `try`/`finally`. I did not probe whether `submitQueuedRunEdit` can throw.
    - First pass: Evidence: what I tried: code reading only, plus the lane probe for G3.1. I wrote no probe on this store.

### F-M9. Query cache atoms

- Owner: upstream
- Stored in: memory (atom family, `packages/client-runtime/src/state/runtime.ts:665`); some queries also persist to IndexedDB (web store `query`), which I did not read.
- States: no value, fresh, stale, failed; each depends on the supervisor phase.
- Transitions:
  - an idle atom is dropped after 5 minutes by default: `packages/client-runtime/src/state/runtime.ts:683`.
  - a value is stale after 30 seconds by default: `packages/client-runtime/src/state/runtime.ts:816`.
- Restart: memory values are lost; persisted pages are read again.
- Explicit or implicit: implicit. The staleness rules are options at each call site.
- Gaps:
  - none proved. I did not read each call site's stale time and did not read `queryPersistence.ts`.

### F-M10. Composer drafts and the send (web)

- Owner: upstream
- Stored in: `localStorage` key `t3code:composer-drafts:v1`, schema version 9 (`apps/web/src/composerDraftStore.ts:115`, version at `:116`), one key for the drafts of all threads, written whole after a 300 ms debounce (`:123`, `:129`) and at `beforeunload` (`:155`). Memory for the send flags: `backgroundSubmissionThreadKeys` (`apps/web/src/composerDraftStore.ts:459`), the per-route `sendInFlight` flag (`apps/web/src/components/chat/chatViewSend.ts:52`), and the optimistic messages (`apps/web/src/components/chat/optimisticUserMessages.ts:14`).
- States: draft with content, send in flight (draft cleared, optimistic message shown), acknowledged, failed (draft restored).
- Transitions:
  - draft -> send in flight: `sendInFlight` is set at `apps/web/src/components/chat/useComposerSend.ts:860`; the draft is cleared at `:1167`.
  - send in flight -> acknowledged or failed: after `await startPromise` at `apps/web/src/components/chat/useComposerSend.ts:1324`. On failure the draft comes back from the in-memory `sendSnapshot` (`:1399`).
  - `sendInFlight` is cleared at `apps/web/src/components/chat/useComposerSend.ts:1444`, with no `finally`.
  - optimistic message -> removed when the server acknowledges it: `apps/web/src/components/chat/optimisticUserMessages.ts:28`.
- Restart: drafts survive. A send in flight does not: the flags, the optimistic message and `sendSnapshot` are memory only.
- Explicit or implicit: implicit. The send is one long async function in a React hook; its state is spread over a module map, a zustand store and React state.
- Gaps:
  - **F-G10.1** [two writers] Two tabs write the same key with their own whole copy and do not listen for each other. The later writer erases the other tab's drafts. The store has no `storage` listener and no `BroadcastChannel`. **Verdict:** confirmed. Tracked: t3code-194.
    - Evidence: probe `composerDraftStore.two-tabs.probe.test.ts`. Two module instances over one stubbed `localStorage`. Tab A sets a prompt on thread X; storage holds it. Tab B sets a prompt on thread Y; storage holds only B's draft. A reloaded tab A has only B's draft. The probe passes while it asserts the wrong behaviour. Limit: the "tabs" are module instances, not real browser tabs. I found no document that states an intent (`grep -ri "two tabs\|multi-tab\|cross-tab" docs` finds nothing).
    - Size (confirmed only): M. Effect on the user: a prompt typed in one tab is gone after a reload when another tab was used in between.
  - **F-G10.2** [state lost on restart] The send clears the persisted draft before the server accepts the message. Until the answer arrives, the text exists only in memory. A reload in that window loses it. The window has no upper limit when the socket is down (G3.2) or the lane is held (G3.1). **Verdict:** confirmed for the store; the order of the calls in the hook is a code reading. Tracked: t3code-195.
    - Evidence: probe `composerDraftStore.send-reload.probe.test.ts`. After `setPrompt` and one second, storage holds the text. After `clearComposerContent` (the call at `apps/web/src/components/chat/useComposerSend.ts:1167`) and one second, no storage value holds the text, and a reloaded store has no prompt. The probe passes while it asserts the wrong behaviour. I could not test the hook itself: it needs a browser session, which the brief excludes, and no unit test pins the order.
    - Size (confirmed only): M. Effect on the user: a message sent while the connection is down is lost when the tab reloads before the connection returns.
  - **F-G10.3** [state with no exit] `sendInFlight` stays true when the awaited send never settles or when the function throws between lines 860 and 1444. The composer then refuses every later send on that route (`apps/web/src/components/chat/useComposerSend.ts:440`). **Verdict:** confirmed. Tracked: t3code-230.
    - Probe: `useComposerSend.sendInFlight.probe.test.tsx`. It calls the real `onSend` of the real hook.
    - Command, from `apps/web`: `vp test run src/components/chat/useComposerSend.sendInFlight.probe.test.tsx`. Exit code 0. 2 tests passed.
    - Test "probe F-7a: a send that gets no answer blocks every later send on the route".
      - `startThreadTurn` never settles. The flag stays `true` after 1 hour of fake time.
      - A second send on the same route sends nothing.
      - A new mount of the hook on the same route also sends nothing. The flag lives in a module map (`apps/web/src/components/chat/chatViewSend.ts:47-66`).
      - Control: when the answer arrives, the flag clears and the next send goes out.
    - Test "probe F-7b: a throw after the flag is set leaves the route blocked".
      - A callback throws once between `useComposerSend.ts:860` and `:1444`. `onSend` rejects.
      - The flag stays `true`. The next send is refused.
    - Limit of the proof:
      - The hook renders once through `renderToString`. Its hook dependencies are mocked.
      - The probe injects the promise that never settles. Gap G3.1 (first pass, confirmed) shows that a held command lane gives such a promise.
      - The probe injects the throw through a callback. I found no real throw site between the two lines.
    - Owner: upstream. `git blame` gives f136d5a755 and 9c3e743a45 (2026-10-21).
    - Size: S. A `try`/`finally` around the body after `:860` clears the flag.
    - Effect on the user: after one send that gets no answer, the composer on that thread refuses every later send, with no message, until the page reloads.
    - First pass: Evidence: what I tried: code reading only. The flag lives in a React hook; a probe needs a browser session.
  - **F-G10.4** [two writers] The same whole-value `persist` pattern, with no listener for other tabs, is in `apps/web/src/terminalUiStateStore.ts:583`, `apps/web/src/diffPanelStore.ts:53`, `apps/web/src/browserHistoryStore.ts:225`, `apps/web/src/closedViewStore.ts:104`, `apps/web/src/browserFaviconStore.ts:120` and `apps/web/src/rightPanelStore.ts:638`. **Verdict:** confirmed for all six stores. Tracked: t3code-232.
    - Probe: `persistStores.two-tabs.probe.test.ts`. Two module instances share one stubbed `window.localStorage`.
    - Command, from `apps/web`: `vp test run src/persistStores.two-tabs.probe.test.ts --reporter=verbose`. Exit code 0. 6 tests passed.
    - Tests "probe F-10: <store> drops tab A's value when tab B saves", for `closedViewStore`, `diffPanelStore`, `terminalUiStateStore`, `browserHistoryStore`, `browserFaviconStore` and `rightPanelStore`.
    - In each case tab A saves a value, then tab B saves another value. Storage then holds only the value of tab B. A reloaded store has only the value of tab B.
    - Limit of the proof: the tabs are module instances in one process, not two browser tabs. No comment or document states an intent for these stores.
    - Owner: upstream.
    - Size: M. The fix is the same family as G10.1 (read and merge before a write, or a `storage` listener).
    - Effect on the user: closed-view reopen entries, in-app browser history, favicons, and the panel, terminal and diff layout that one tab saved are erased when another open tab saves.
    - First pass: Evidence: what I tried: `grep -n "persist("` and a grep for `storage` listeners (found only in `themePalette.ts`, `connection/storage.ts`, `hooks/useTheme.ts`, `hooks/useLocalStorage.ts`). I probed only the composer store.

### F-M11. Draft thread promotion (web)

- Owner: upstream
- Stored in: `localStorage` (the draft thread and its `promotedTo`, inside the composer key); memory for `promotedDraftRedirects` (`apps/web/src/composerDraftStore.ts:464`).
- States: local draft, promoting (`promotedTo` set), finalized (draft removed, redirect recorded), restored after a failed send.
- Transitions:
  - local -> promoting: the reserved thread appears in the server shell. Enforced at `apps/web/src/composerDraftStore.ts:4692`, and `markDraftThreadPromoting` at `:2936`.
  - promoting -> finalized: the server owns the send (message persisted, or run started or stopped) and no background submission is pending. Enforced at `apps/web/src/composerDraftStore.ts:4614` and `:2962`.
  - promoting -> local: `restoreFailedDraftThread`, `apps/web/src/composerDraftStore.ts:4575`.
- Restart: `promotedTo` survives; the redirect map and the background flag do not.
- Explicit or implicit: implicit. One subscription drives it (`apps/web/src/composerDraftStore.ts:4638`), but three other functions also write `promotedTo`.
- Gaps:
  - none proved. I did not probe a reload during `promoting`.

### F-M12. Saved connection catalog and client caches (web)

- Owner: upstream
- Stored in: IndexedDB database `t3code:connection-runtime`, version 5 (`apps/web/src/connection/storage.ts:46`), stores for catalog, shell, thread, server config, VCS refs and queries; on desktop the catalog goes through the desktop bridge (`apps/web/src/connection/storage.ts:487`). Each tab also keeps the catalog document in memory (`apps/web/src/connection/storage.ts:534`).
- States: not loaded, loaded (memory copy equals the last value that this tab read or wrote), corrupt (quarantined and replaced by an empty document).
- Transitions:
  - not loaded -> loaded: first read. Later reads return the memory copy (`apps/web/src/connection/storage.ts:538`).
  - loaded -> loaded: `update` transforms the memory copy and writes the whole document (`apps/web/src/connection/storage.ts:578`).
  - an open handle closes when another tab upgrades the database (`apps/web/src/connection/storage.ts:196`).
- Restart: the memory copy is lost; the stored document is read again.
- Explicit or implicit: implicit. The stored document and each tab's copy are one state in several places, with no version check on write.
- Gaps:
  - **F-G12.1** [two writers] A tab writes its whole cached document. A change that another tab saved after this tab's first read is erased: a saved environment, a credential, a renewed token, the disabled list. The same write can bring back an entry that the other tab removed. Upstream knows the risk for one field: "Each grant has its own key so stale tabs and unrelated catalog saves cannot restore trust" (`apps/web/src/connection/storage.ts:602`), pinned by `apps/web/src/connection/storage.test.ts:201` (run above, exit 0). The rest of the document has no such protection. **Verdict:** confirmed. Tracked: t3code-196.
    - Evidence: probe `storage.two-tabs.probe.test.ts`. Two stores from `makeCatalogStore` over one backend, both read first. Tab A adds an id to `disabledEnvironmentIds`. Tab B adds another id. The stored document holds only B's change, and a new store reads only B's change. The probe passes while it asserts the wrong behaviour. Limit: the probe uses a shared in-memory backend, not real IndexedDB.
    - Size (confirmed only): M. Effect on the user: an environment added, removed or disabled in one tab can come back or vanish after another open tab saves anything.
  - **F-G12.2** [wait without limit] `openDatabase` listens for `upgradeneeded`, `error` and `success` only (`apps/web/src/connection/storage.ts:131`). An open that an old tab blocks would never resume. **Verdict:** confirmed. Tracked: t3code-233.
    - Probe: `storage.blocked-open.probe.test.ts`. It stubs `indexedDB.open` in the same way as `apps/web/src/connection/storage.test.ts:131`, and reads through `Persistence.EnvironmentCacheStore` from `ConnectionStorage.layer`.
    - Command, from `apps/web`: `vp test run src/connection/storage.blocked-open.probe.test.ts --reporter=verbose`. Exit code 0. 1 test passed.
    - Test "probe F-11: a blocked open never resumes and holds every later reader".
      - The request fires `blocked` and nothing else. The code registers listeners for `error`, `success` and `upgradeneeded` only.
      - After 48 hours of test time, two `loadThread` reads have no answer and no error.
      - `indexedDB.open` was called once. The second reader waits behind the one-permit semaphore of `makeDatabaseHandle` (`storage.ts:180-208`).
      - Control: when the same request fires `success`, both reads finish.
    - Limit of the proof:
      - IndexedDB is a fake. A real browser fires `success` after the old tab closes its connection, so the wait ends when that tab closes.
      - The gap is that the wait has no time limit and gives no message.
      - A current tab releases the database on `versionchange` (`storage.ts:196`, commit 9c49228f54, 2026-10-05). The blocking tab must therefore run an older build, or be frozen.
      - `DATABASE_VERSION` was last raised on 2026-11-05 (commit 0ea3c0243f). An upgrade is the only time `blocked` can fire.
      - The catalog store, the shell cache and the thread cache share this one handle (`storage.ts:714-720`). I did not check what the screen shows while the catalog read waits.
    - Owner: upstream. `git blame` gives e95b57dc26 (2026-06-18).
    - Size: S. A `blocked` listener can fail the open with a clear message, or the open can have a timeout.
    - Effect on the user: when a tab with an older build stays open across a schema upgrade, the new tab waits for its saved connections and cached threads with no message, until the old tab closes.
    - First pass: Evidence: what I tried: code reading only. The `versionchange` handler at `apps/web/src/connection/storage.ts:196` makes current tabs close their handle, so the case needs a tab with older code. I wrote no probe (it needs an IndexedDB fake).

### F-M13. Version mismatch banner and its dismissals (web)

- Owner: upstream
- Stored in: `localStorage` key `t3code:version-mismatch-dismissals:v1` (`apps/web/src/versionSkew.ts:20`); a `WeakSet` in memory for dismissed update failures (`:22`).
- States: no mismatch, mismatch shown, mismatch dismissed for one pair of versions.
- Transitions:
  - shown: the server version is behind the client. `apps/web/src/versionSkew.ts:47`.
  - shown -> dismissed: read the document, add the key, write it. `apps/web/src/versionSkew.ts:151`.
- Restart: stored dismissals survive; the `WeakSet` is lost, so a dismissed update failure shows again.
- Explicit or implicit: implicit, and small.
- Gaps:
  - **F-G13.1** [two writers] The dismissal is a read-modify-write of one key, and the list is never pruned. **Verdict:** split. Two writers: refuted; Never pruned: confirmed. Tracked: t3code-234.
    - Probe: `versionSkew.dismissals.probe.test.ts`.
    - Command, from `apps/web`: `vp test run src/versionSkew.dismissals.probe.test.ts src/threadNotifications.badge.probe.test.ts src/threadNotifications.test.ts src/versionSkew.test.ts --reporter=verbose`. Exit code 0. 4 files, 19 tests passed.
    - Two writers: refuted.
      - Test "probe F-12a: a dismissal in tab B keeps the dismissal of tab A".
      - `dismissVersionMismatch` (`apps/web/src/versionSkew.ts:151`) reads the stored list again before each write. It holds no copy in memory.
      - Tab A, tab B and tab A dismiss in turn. Storage holds all three keys, and each tab sees the dismissals of the other.
      - Limit of the proof: the read and the write are one synchronous step. A probe cannot place a write of another tab between them. Two tabs would have to dismiss in the same instant.
    - Never pruned: confirmed.
      - Test "probe F-12b: the list keeps every key ever dismissed; nothing removes one".
      - 500 dismissals leave 500 keys. The module only sets the key. It has no remove and no cap. Each dismissal rewrites the whole list.
      - Limit of the proof: one key is about 30 bytes, and one key needs one click by the user. The list cannot grow large in real use.
      - Owner: upstream (3772fa127c, 2026-05-03). Size: S.
      - Effect on the user: none that a user sees. Dead keys stay in `localStorage`.
    - First pass: Evidence: what I tried: code reading only. I wrote no probe; the effect is one banner shown again.

### F-M14. Closed views and reopen (web)

- Owner: upstream
- Stored in: `localStorage` key `t3code:closed-views:v2`, version 2 (`apps/web/src/closedViewStore.ts:128`), at most 20 entries (`:113`). Private browser tabs stay in memory only (`:142`).
- States: remembered, deferred (moved to the end), removed.
- Transitions:
  - close -> remembered: `apps/web/src/closedViewStore.ts:107`.
  - reopen plan: drop an entry of a removed environment or an already open view; skip an entry whose thread is gone; wait while the catalog or the shell is not ready. `apps/web/src/reopenClosedView.ts:25`.
- Restart: entries survive, without private tabs.
- Explicit or implicit: explicit. One pure planner and one store.
- Gaps:
  - **F-G14.1** [state with no exit] An entry whose thread was deleted is skipped but never dropped (`apps/web/src/reopenClosedView.ts:37`). It leaves only when 20 newer entries push it out. **Verdict:** by design.
    - Evidence: test row "skips but keeps a thread deleted from a live shell" at `apps/web/src/reopenClosedView.test.ts:260` passes (run above, exit 0).

### F-M15. Command palette (web)

- Owner: upstream
- Stored in: memory (`apps/web/src/commandPaletteStore.ts:18`).
- States: closed, open in a mode, with a session counter.
- Transitions: every change goes through `reduceCommandPaletteUiState` (`apps/web/src/commandPaletteStore.ts:22`); the last unmount resets the store (`:69`).
- Restart: lost.
- Explicit or implicit: explicit. One reducer.
- Gaps:
  - none found. I did not read the reducer in `components/CommandPalette.logic.ts`.

### Area F: other points

- **F-P1** wait without limit: `requestInSession` awaits the RPC answer with no deadline, `packages/client-runtime/src/rpc/client.ts:220`. **Verdict:** confirmed at the lane level by probe `command-lane.probe.test.ts` (see G3.1). I did not reproduce a server that leaves a request without an answer. Tracked: t3code-192.
- **F-P2** lost information: a defect on the shell stream leaves no error in the shell state and no visible status, `packages/client-runtime/src/state/shell.ts:540`. **Verdict:** confirmed by probe `shell-defect.probe.test.ts` (`error` is none after the defect). Tracked: t3code-193.
- **F-P3** untested state: no test covers a defect on the shell stream (see G5.2). **Verdict:** confirmed by the grep in G5.2. Tracked: t3code-193.
- **F-P4** untested state: no unit test pins the order "clear the draft, then await the server" in the web send, `apps/web/src/components/chat/useComposerSend.ts:1167` and `:1324`. **Verdict:** confirmed as a test gap. The behaviour is correct. Tracked: t3code-195.
  - Probe: `useComposerSend.draftOrder.probe.test.tsx`. It uses the harness of the G10.3 probe and the real `composerDraftStore`.
  - Command, from `apps/web`: `vp test run src/components/chat/useComposerSend.draftOrder.probe.test.tsx --reporter=verbose`. Exit code 0. 1 test passed.
  - Test "probe F-14: the send clears the draft before the server answers and restores it on failure".
    - While `startThreadTurn` has no answer, the stored draft prompt and `promptRef` are empty. They stay empty for 1 hour of fake time.
    - When the answer is a failure, the draft prompt and `promptRef` get the text back, and the thread error is "server refused".
  - No existing test: `grep -rln "useComposerSend\|restoreComposerDraft" apps/web/src --include=*.test.ts --include=*.test.tsx` finds no file. Exit code 1.
    - `apps/web/src/components/ChatView.logic.test.ts:1072` tests `snapshotComposerSend` only.
  - Intent of the restore: the doc comment at `apps/web/src/components/chat/chatViewSend.ts:252-256` says "Writes a failed send's composer contents back into its draft."
  - Limit of the proof:
    - The probe restores a text-only draft. It does not cover images, files or terminal contexts.
    - I ran no mutation check, because the brief forbids a change to a tracked file.
    - With G10.3, a send that gets no answer leaves the text in the optimistic message only. The probe shows that the draft is empty in that state.
  - Owner: upstream. Size: S (probe F-14 can become the test).
  - Effect on the user: none today. A later change can break the restore of a failed send, and no unit test would fail.
- **F-P5** lost information: `apps/web/src/threadNotifications.ts:80` and `:132` drop errors from the desktop badge call and from the sound load on purpose (comment at `:133`). **Verdict:** split. Sound load (`apps/web/src/threadNotifications.ts:132`): by design; Desktop badge call (`apps/web/src/threadNotifications.ts:80`): confirmed, low. Tracked: t3code-234.
  - Command: the same run as G13.1. Exit code 0.
  - Sound load (`apps/web/src/threadNotifications.ts:132`): by design.
    - Intent: the comment at `:133` says "A failed load is retried on the next alert."
    - Behaviour: the existing test at `apps/web/src/threadNotifications.test.ts:62`, "retries failed preloads on an alert rather than every gesture".
  - Desktop badge call (`apps/web/src/threadNotifications.ts:80`): confirmed, low.
    - Probe: `threadNotifications.badge.probe.test.ts`, test "probe F-13: a rejected desktop badge call leaves no trace and no retry".
    - The bridge call rejects. The function returns nothing, writes no console line, and causes no unhandled rejection. It does not call the bridge again by itself.
    - Control: the next call from the coordinator goes to the bridge again.
    - No comment states an intent for this line.
    - Limit of the proof: the probe injects the rejection. I did not check whether the desktop IPC handler can reject. The callers in `apps/web/src/components/ThreadNotificationCoordinator.tsx:80`, `:122` and `:127` call again only when the pending count changes.
    - Owner: upstream (line last touched by 67661cfbb5). Size: S.
    - Effect on the user: if the desktop badge call fails, the dock or taskbar badge keeps its old count until the pending count changes, and no log records the failure.

## Area G: Desktop app and shared packages

### Area G: evidence conventions

Scope notes that apply to every entry below:

- `git diff origin/main...origin/fork -- apps/desktop packages/shared packages/contracts` changes 4 files (141 insertions). None is in `apps/desktop`. So every desktop machine is owner `upstream`.
- The fork's changes in this area: `packages/contracts/src/threadPullRequest.ts` (watch end and skip reasons, `watchRecord`), `packages/contracts/src/orchestrationV2.ts` (`workingDirectory` on two turn items; `endReason` and `skip` on one internal command), `packages/contracts/src/orchestratorMcp.ts` (`baseRef`, `startFromOrigin`, `retryAt`, tool result schemas, `include`), `packages/shared/src/threadLinks.ts` (`threadIdOfToolInput`, stateless).
- Probe files are in `<archive>/probes/G/`. To run one again, copy it beside the module that its name gives, run the command, then move it out.
- "Probe run 1" below means this command and result: `cd apps/desktop && vp test run src/backend/DesktopBackendManager.g.probe.test.ts src/app/DesktopLifecycle.g.probe.test.ts src/updates/DesktopUpdates.g.probe.test.ts` -> `Test Files 3 passed (3), Tests 9 passed (9)`, exit code 0.
- "Existing run 1" below means this command and result: `cd apps/desktop && vp test run src/backend/DesktopBackendManager.test.ts src/app/DesktopLifecycle.test.ts src/updates/DesktopUpdates.test.ts src/app/DesktopStartupRecovery.test.ts src/backend/DesktopHomeOwner.test.ts src/app/DesktopClerk.test.ts src/legacyLocalStorageMerge.test.ts` -> `Test Files 7 passed (7), Tests 100 passed (100)`, exit code 0.
- "Probe run 2": `cd apps/desktop && vp test run src/settings/DesktopSettings.g.probe.test.ts src/legacyLocalStorageMerge.g.probe.test.ts` -> `Test Files 2 passed (2), Tests 3 passed (3)`, exit 0.
- "Probe run 3": `cd packages/shared && vp test run src/KeyedCoalescingWorker.g.probe.test.ts` -> `Test Files 1 passed (1), Tests 2 passed (2)`, exit 0.
- "Existing run 2": `cd apps/desktop && vp test run src/settings/DesktopAppSettings.test.ts src/settings/DesktopClientSettings.test.ts src/window/QuitHold.test.ts src/backend/DesktopBackendPool.test.ts src/app/DesktopConnectionCatalogStore.test.ts` -> `Test Files 5 passed (5), Tests 35 passed (35)`, exit 0.
- "Existing run 3": `cd packages/shared && vp test run src/KeyedCoalescingWorker.test.ts src/DrainableWorker.test.ts src/KeyedLock.test.ts` -> `Test Files 3 passed (3), Tests 11 passed (11)`, exit 0.
- "Existing run 4": `cd apps/desktop && vp test run src/ssh/DesktopSshPasswordPrompts.test.ts src/permissions/MacPermissionHelper.test.ts` -> `Test Files 2 passed (2), Tests 7 passed (7)`, exit 0.
- "Existing run 5": `cd apps/desktop && vp test run src/window/DesktopWindow.test.ts` -> `Test Files 1 passed (1), Tests 38 passed (38)`, exit 0.
- A search command given as evidence was run from the repository root; its printed result is quoted or described beside it.
- A probe marked "passes while it asserts the wrong behaviour" is a green test whose assertions describe the defect.

Second pass:

This section gives a verdict for each gap that had `no verdict`: G1.5, G1.6, G5.1, G6.2, G11.1, G11.2, G15.1 and P10.
The first-pass text above is unchanged.
Checkout: `<repo>/`, HEAD `22b65998f3`.
Each probe ran beside the code and then moved to `<archive>/probes/G/`.
To run a probe again, copy it back to the directory that its command names.
All tests use the `TestClock`, except the two `it.live` tests that need a real process or a real socket.
Owner: `git diff --stat origin/main...origin/fork` prints nothing for `apps/desktop`, `apps/server/src/cli/config.ts`, `apps/server/src/cli/server.ts`, `apps/server/src/server.ts` and `apps/server/src/launcherWatch.ts`. Thus each gap here has the owner `upstream`.

- Run A: `cd apps/server && vp test run src/launcherWatch.g2.probe.test.ts src/launcherWatch.test.ts --reporter=verbose`. Exit code 0. Test Files 2 passed, Tests 4 passed. Probe files: `launcherWatch.g2.probe.test.ts`, `launcherWatch.g2.probe.fixture.ts` (both go in `apps/server/src/`).
- Run B: `cd apps/desktop && vp test run src/backend/DesktopBackendManager.g15.probe.test.ts --reporter=verbose`. Exit code 0. Tests 1 passed. Probe file: `DesktopBackendManager.g15.probe.test.ts`.
- Run C: `cd apps/server && vp test run src/server.g15.probe.test.ts src/cli/config.test.ts -t "G1.5|uses the automatic port selector only when no port is configured" --reporter=verbose`. Exit code 0. Test Files 2 passed. Probe file: `server.g15.probe.test.ts` (goes in `apps/server/src/`).
- Run D: `cd apps/desktop && vp test run src/window/DesktopWindow.g11.probe.test.ts --reporter=verbose`. Exit code 0. Tests 7 passed. Probe file: `DesktopWindow.g11.probe.test.ts`.
- Run E: `cd apps/desktop && vp test run src/backend/DesktopBackendPool.g.probe.test.ts --reporter=verbose`. Exit code 0. Tests 3 passed. Probe file: `DesktopBackendPool.g.probe.test.ts`.
- Run F: `cd apps/desktop && vp test run src/ipc/DesktopIpc.g15.probe.test.ts --reporter=verbose`. Exit code 0. Tests 1 passed. Probe file: `DesktopIpc.g15.probe.test.ts`.

### G-M1. Desktop backend process lifecycle (the bundled server child process)

- Owner: upstream
- Stored in: memory. `BackendManagerState` in a `SubscriptionRef` guarded by a one-permit semaphore, `apps/desktop/src/backend/DesktopBackendManager.ts:272` (fields `desiredRunning`, `ready`, `active` run, `restartAttempt`, `restartFiber`, `preflightFailureAttempt`, `config`). The child process itself is the second store.
- States: stopped (`desiredRunning` false, no run); preflight-failed; starting (run active, `ready` false); ready; restart-scheduled (`restartFiber` present); stopping (run has `stopRequested`); state-dir-owned (terminal).
- Transitions:
  - stopped -> starting: `start`. Enforced at `apps/desktop/src/backend/DesktopBackendManager.ts:745-751` (state) and `:813-828` (run). A second `start` with an active run only sets `desiredRunning`, `:708-716`.
  - stopped -> stopped (configuration failed on a first start): `:732-737`. No retry, see G1.1.
  - starting -> preflight-failed -> restart-scheduled or stopped: `:753-803`; stops after `MAX_PREFLIGHT_FAILURE_ATTEMPTS` (5, `:37`) at `:770-780`.
  - starting -> ready: the readiness probe succeeds, `onReady` at `:943-958`; sets `restartAttempt` to 0.
  - starting -> starting: the readiness probe times out (3 minutes, `:39`) and is repeated while the process lives, `:589`. The failure is reported, `:972-982`. The process is not restarted.
  - starting or ready -> restart-scheduled: the process exits, `finalizeRun` -> `scheduleRestart`, `:912`, `:1010-1074`. Delay 500 ms doubling to 10 s, `:35-36`, `:305`. No cap on attempts.
  - starting or ready -> state-dir-owned: exit code 78, `:903-911`; `desiredRunning` false and `onStateDirOwned` shows a dialog and quits (`apps/desktop/src/backend/DesktopBackendPool.ts:182-192`).
  - any -> stopping -> stopped: `stop`, `:1076-1163`. SIGTERM, then SIGKILL after 5 s (`:467-468`). A `start` during `stop` restarts after teardown, `:1157-1159`.
- Restart: all state is lost when the desktop app stops. The child is stopped by the pool finalizer (`apps/desktop/src/app/DesktopApp.ts:159-169`, `:391-398`). When the app dies without running finalizers, the child survives; the server side decides what an orphan does (boundary: `apps/server/src/launcherWatch.ts`, areas A to E). On the next launch the desktop waits up to 10 s for the home lock (M6).
- Explicit or implicit: implicit. One record holds six independent fields and each function checks the fields it needs; there is no named state type and no transition table.
- Gaps:
  - **G-G1.1** [state with no exit] When the first `start` fails to resolve its configuration, the manager returns with `desiredRunning` false. It schedules no retry and reports no startup failure. The same failure after a first run is retried. Only `randomBytes`, the bootstrap token read and the shell environment install can fail here (`apps/desktop/src/backend/DesktopBackendConfiguration.ts:742`, `:753-756`, `:795`), so the trigger is rare. **Verdict:** confirmed. Tracked: t3code-201.
    - Evidence: probe `probes/G/DesktopBackendManager.g.probe.test.ts`, tests "G1.1 a first start whose configuration fails is never retried" and "G1.1 contrast: the same failure after a run is retried"; probe run 1, exit 0. The first test passes while it asserts the wrong behaviour: after 1 hour of test clock, one resolve call, no spawn, `restartScheduled` false, no `onStartupFailure` call, `waitForReady` false.
    - Size (confirmed only): S. Effect on the user: the app shows no window and no recovery page until the user quits and reopens it.
  - **G-G1.2** [state with no exit] A backend that is alive but never becomes ready is never restarted. The manager repeats the 3-minute probe for ever and reports one failure per probe. **Verdict:** by design.
    - Evidence: comment at `apps/desktop/src/backend/DesktopBackendManager.ts:571` ("retry while the backend is alive"); test `apps/desktop/src/backend/DesktopBackendManager.test.ts:687`; existing run 1, exit 0.
  - **G-G1.3** [wait without limit] A backend that exits at once is respawned for ever, every 10 s at most. Each attempt from the third reports a startup failure. **Verdict:** by design.
    - Evidence: probe test "G1.3 a crashing backend is respawned without a cap" (more than 300 spawns in 1 hour of test clock); probe run 1, exit 0. Intent: comment at `apps/desktop/src/backend/DesktopBackendManager.ts:1036` and the recovery page text at `apps/desktop/src/app/DesktopStartupRecovery.ts:137`. Existing test `apps/desktop/src/backend/DesktopBackendManager.test.ts:629`; existing run 1, exit 0.
  - **G-G1.4** [wait without limit] `stop` with the quit deadline (7 s, `:46-49`) does not stop waiting at the deadline. It logs a warning and waits for the process to exit. **Verdict:** by design.
    - Evidence: comment at `apps/desktop/src/backend/DesktopBackendManager.ts:44-45`; test `apps/desktop/src/backend/DesktopBackendManager.test.ts:725` ("the quit stop keeps waiting for a backend that outlasts its deadline"); existing run 1, exit 0. The way out is the stalled-quit exit of M2.
  - **G-G1.5** [state lost on restart] The backend port is chosen once per app launch (`apps/desktop/src/app/DesktopApp.ts:86-120`, called at `:243`; stored by `configureFromSettings`, `apps/desktop/src/app/DesktopApp.ts:260`). A restart of the backend resolves the configuration again (`apps/desktop/src/backend/DesktopBackendConfiguration.ts:808`) but reads the same port. If another process takes the port between a crash and the respawn, the respawn loop of G1.3 cannot recover. **Verdict:** confirmed. Tracked: t3code-243.
    - Evidence, Run B: test "G1.5 every respawn gets the launch port, also after another process took it". The probe uses the real `DesktopServerExposure` and the real `NetService`. A real socket takes the port after the first backend exits. In 1 hour of test time the manager spawns 364 backends and each one gets the launch port (output: `spawns=364 resolves=364 distinctPorts=1`). `findAvailablePort(port)` returns another port at that time, but no code calls it again.
    - Evidence, Run C: probe test "G1.5 the server's HTTP listener fails on a taken port and tries no other port" (the listener fails with `EADDRINUSE`), and existing test "uses the automatic port selector only when no port is configured" (`apps/server/src/cli/config.test.ts:757`).
    - Limit of the proof: the three links are proved one by one, not in one end-to-end run. A spawner stub stands for the server process in Run B. The trigger is rare: another process must bind the port between a backend exit and the respawn (500 ms to 10 s).
    - Owner: upstream. Size: M (a new port needs a window reload and new advertised endpoints).
    - Effect on the user: after a backend crash with the port taken, the app respawns the backend without end on the taken port, and the user sees a disconnected window until a quit and reopen. The part "the recovery window is skipped while the main window is visible" (`apps/desktop/src/app/DesktopStartupRecovery.ts:251-257`) rests on code reading.
    - First pass: Evidence: `grep -rn "resolveDesktopBackendPort" apps/desktop/src` gives two lines only, the definition (`apps/desktop/src/app/DesktopApp.ts:86`) and the one call at startup (`:243`). That proves the port is chosen once. The failure of the respawn is not proved: a probe needs a real socket bound between two spawns, which the stubbed spawner cannot show.
  - **G-G1.6** [one state in two places] Readiness is kept in the manager (`ready`, `:943-951`) and in `DesktopState.primaryBackendStartup` (`apps/desktop/src/app/DesktopState.ts:22`, `:30`). The second is set to `Ready` only after `handleBackendReady` succeeds (`apps/desktop/src/backend/DesktopBackendPool.ts:168-176`); a window error is logged and leaves it at `Starting` or `Failing` while the manager says ready. `primaryBackendStartup` is never set back to `Starting`. **Verdict:** by design, for the part "a window error leaves `primaryBackendStartup` at `Starting` while the manager says ready".
    - Intent: `apps/desktop/src/backend/DesktopBackendPool.ts:166` ("Absorb window errors so readiness can reset restartAttempt.") and `:169` ("Only once the main window exists, so the recovery window never closes into nothing.").
    - Evidence, Run E: test "G1.6 a window error at readiness leaves primaryBackendStartup at Starting while the manager is ready". Output after 1 hour: `managerReady=true restartAttempt=0 primaryBackendStartup=Starting spawns=1 readyCalls=1`. The pool does not call `handleBackendReady` again.
    - The part "`primaryBackendStartup` is never set back to `Starting`" is shown as a fact, with no stated intent. Run E, test "G1.6/G11.2 after Ready a crashed backend leaves primaryBackendStartup at Ready until the startup failure report": after a crash the value stays `Ready` while the manager says not ready, then becomes `Failing`, then `Ready` again when a backend is healthy. No wrong behaviour for the user follows from this in the probe.
    - Limit of the proof: the probe uses the real pool and the real manager with a stub window, a stub spawner and a stub HTTP client. The reaction of the recovery window (`DesktopStartupRecovery.ts`) to these values is not in the probe.
    - First pass: Evidence: read `apps/desktop/src/backend/DesktopBackendPool.test.ts` test names (`:205`, `:261`); neither covers a failing `handleBackendReady`. No probe written: the pool layer needs the window, dialog, Electron app and configuration services stubbed, and I gave the time to the update and quit machines.

### G-M2. Desktop quit and relaunch machine

- Owner: upstream
- Stored in: memory, three places. `QuitState.phase` (a closure variable, `apps/desktop/src/app/DesktopLifecycle.ts:103`, created at `:254`); `DesktopState.quitting` (`apps/desktop/src/app/DesktopState.ts:19`); the `DesktopShutdown` deferreds `requested` and `completed` (`apps/desktop/src/app/DesktopShutdown.ts:19-20`).
- States: `running`; `waiting` (quit asked, backend stop in progress); `allowed` (the next `before-quit` passes). Beside them: `quitting` true or false.
- Transitions:
  - running -> waiting: `before-quit`, `apps/desktop/src/app/DesktopLifecycle.ts:138-185` (`:115`, `:166`).
  - waiting -> allowed -> process exit: shutdown completes, `:177`, then `quit`.
  - waiting -> process exit 0: a second `before-quit` or a signal after 10 s (`SHUTDOWN_STALL_THRESHOLD`, `:110`), `:122-136`, `:157-158`, `:194-195`.
  - running -> allowed: `before-quit-for-update`, `:260-277` (`:264`).
  - running -> allowed: SIGINT or SIGTERM, `:187-212` (`:208`), only when `quitting` was false (`:203-204`).
  - running (phase unchanged) with `quitting` true: `relaunch`, `:216-245` (`:223`); also the update install (`apps/desktop/src/updates/DesktopUpdates.ts:812`).
- Restart: all in memory. A new process starts at `running` with `quitting` false.
- Explicit or implicit: implicit. The phase has a type, but `quitting` and the shutdown deferreds are written by three other code paths that do not touch the phase.
- Gaps:
  - **G-G2.1** [one state in two places] `relaunch` and the update install set `quitting` without moving the phase to `waiting`. While their backend stop stalls, every SIGTERM and SIGINT returns at `:203-204` with no log, and never reaches the stalled-quit exit. This contradicts the stated intent at `apps/desktop/src/app/DesktopLifecycle.ts:119-121` ("a repeated Quit or SIGTERM is the user's only way out short of SIGKILL"). **Verdict:** confirmed. Tracked: t3code-202.
    - Evidence: probe `probes/G/DesktopLifecycle.g.probe.test.ts`, test "G2.1 SIGTERM is dropped while `quitting` is set outside the quit phase"; probe run 1, exit 0. It passes while it asserts the wrong behaviour: three SIGTERMs over 1 hour of test clock give no exit; after a `before-quit` and 10 s more, one SIGTERM gives `exit(0)`.
    - Size (confirmed only): S. Effect on the user: after a change of the network access mode or of the local environment switch (both relaunch the app, `apps/desktop/src/ipc/methods/serverExposure.ts:38`, `apps/desktop/src/ipc/methods/localEnvironment.ts:29`) with a hung backend, `kill <pid>` and the SIGTERM of the update script do nothing; only a menu Quit followed by a second Quit after 10 s, or SIGKILL, ends the app.
  - **G-G2.2** [state lost on crash] A second Quit or a signal 10 s after the first Quit calls `exit(0)` while the backend stop still runs. The backend child is then left to the server's own orphan handling. `scripts/fork-app-update.sh` (area D) sends SIGTERM 90 s after its quit request, so it always takes this path when the stop stalls. **Verdict:** by design.
    - Evidence: probe test "G2.2 SIGTERM 90 s after Quit exits without waiting for the backend stop"; probe run 1, exit 0. Intent: comment at `apps/desktop/src/app/DesktopLifecycle.ts:107-109` and `:119-121`; test `apps/desktop/src/app/DesktopLifecycle.test.ts:274`; existing run 1, exit 0. Boundary: what the orphan server does next belongs to `apps/server/src/launcherWatch.ts` and to the update script.

### G-M3. Desktop update machine (Electron updater)

- Owner: upstream. In the fork build the machine stays in `disabled` (G3.1).
- Stored in: memory (`DesktopUpdateState` in a ref, sent to the renderer; type at `packages/contracts/src/ipc.ts:71`, schema `:86`); two flags `updaterConfiguredRef` and the action reservation (`apps/desktop/src/updates/DesktopUpdates.ts:496-515`); disk: `<baseDir>/runtime/desktop-update-restart` (read by the server with a 1-minute limit, `apps/server/src/cloud/updateHandoff.ts:16`, `:44-60`), `<baseDir>/runtime/desktop-update-install.json`, `<stateDir>/desktop-last-started-version`.
- States: `disabled`, `idle`, `checking`, `up-to-date`, `available`, `downloading`, `downloaded`, `error`; beside them the action in progress (`check`, `download`, `install`) and `quitting`.
- Transitions (reducers in `apps/desktop/src/updates/updateMachine.ts`; each reducer sets a target status and does not check the source status):
  - disabled -> idle: `configure` with a feed, `apps/desktop/src/updates/DesktopUpdates.ts:1121-1204`; returns early when a disabled reason exists, `:1162-1164`.
  - idle, up-to-date, available, downloaded, error -> checking: `checkForUpdates`, `:535-593`; refused when quitting (`:541`), not configured (`:542`), `disabled` (`:546`), or `downloading` (`:547-553`). Reducer `apps/desktop/src/updates/updateMachine.ts:43`.
  - checking -> available or downloaded: `update-available`, `apps/desktop/src/updates/DesktopUpdates.ts:927-981`; reducer `updateMachine.ts:89`.
  - checking -> up-to-date or downloaded: `update-not-available`, `:983-989`; reducer `updateMachine.ts:113`.
  - available -> downloading: `downloadAvailableUpdate`, guarded by `status === "available"`, `:597`; reducer `updateMachine.ts:145`.
  - any -> downloading: `download-progress`, `:1032-1063`; reducer `updateMachine.ts:172-184`. Not guarded, see G3.3.
  - downloading -> downloaded: `update-downloaded`, `:1065-1102`; reducer `updateMachine.ts:186`.
  - downloaded -> (install running, `quitting` true) -> process exit: `installDownloadedUpdate`, `:764-871`.
  - install running -> downloaded: a `quitAndInstall` error, interrupt or defect, `:838-868`; or an updater `error` event during the install, `:991-1030`; `recoverFailedInstall`, `:730-762`.
  - any -> error: updater `error` event, `:991-1030`; reducers `updateMachine.ts:61`, `:158`.
- Restart: the status is lost; a new process starts at `disabled` or `idle` and checks again. The downloaded file is kept by electron-updater. The restart marker on disk expires after 1 minute on the server side.
- Explicit or implicit: half explicit. The status values and reducers are named and tested (`apps/desktop/src/updates/updateMachine.test.ts`), but the guards live in the callers, and the updater's event order is trusted.
- Gaps:
  - **G-G3.1** [state with no exit] A build without `app-update.yml` (the fork build, `docs/operations/fork.md:319`) stays `disabled` for ever. `configure` registers no listener and no poller, and `check`, `download` and `install` are refused. **Verdict:** by design.
    - Evidence: probe `probes/G/DesktopUpdates.g.probe.test.ts`, test "G3.1 a build without an update feed stays `disabled` and wires nothing"; probe run 1, exit 0. Existing tests `apps/desktop/src/updates/DesktopUpdates.test.ts:105` and `:1136`; existing run 1, exit 0. Consequence for the owner: the update flow that runs on the owner's machine is the script of area D plus M2 and M1; M3 is inert there.
  - **G-G3.2** [state with no exit] `installDownloadedUpdate` sets `quitting`, stops every backend, calls `quitAndInstall` and returns "accepted" (`apps/desktop/src/updates/DesktopUpdates.ts:812-836`). When the app then does not quit and the updater sends no `error`, nothing restores the state: no time limit, backends stay stopped, `quitting` stays true, every later check and install is refused. **Verdict:** confirmed. Tracked: t3code-203.
    - Evidence: probe test "G3.2 an install whose quit never happens leaves the app stopped for ever"; probe run 1, exit 0. It passes while it asserts the wrong behaviour: after 1 day of test clock `quitting` is true, the install reservation is held, `installSteps` is `["quitAndInstall"]` and a second install is refused. Not reachable in the fork build (G3.1).
    - Size (confirmed only): M. Effect on the user: on a build with a feed, a silent failure of the installer hand-over leaves an app with no backend until the user force-quits it.
  - **G-G3.3** [unguarded transition] A `download-progress` event after `update-downloaded` moves `downloaded` back to `downloading` (`apps/desktop/src/updates/updateMachine.ts:172-184`, called from `apps/desktop/src/updates/DesktopUpdates.ts:1032-1042`). `downloading` blocks every check (`:547`) and the install, so only an app restart leaves it. **Verdict:** confirmed (the transition is unguarded). No verdict on whether electron-updater can send this event order. Tracked: t3code-203.
    - Evidence: probe test "G3.3 a download-progress event moves `downloaded` back to `downloading`"; probe run 1, exit 0. It passes while it asserts the wrong behaviour. The event order is synthetic. Not reachable in the fork build.
    - Size (confirmed only): S. Effect on the user: on a build with a feed, a late progress event would hide "Restart to update" until the next app start.

### G-M4. Startup recovery window (shown when the backend does not start)

- Owner: upstream
- Stored in: memory (`failureRef`, `apps/desktop/src/app/DesktopStartupRecovery.ts:348-351`; `DesktopState.primaryBackendStartup`); disk: `<stateDir>/desktop-last-started-version` (`:22`).
- States: offer `Checking`, `Update`, `Downloading`, `Reinstall`, `Releases`, `ManagedPolicy` (`resolveStartupRecoveryOffer`, `:42-69`); window shown or not.
- Transitions:
  - none -> shown: `primaryBackendStartup` becomes `Failing`; set once per failure episode, `:348-351`; skipped when the backend has started before and the main window is visible, `:251-257`.
  - shown -> closed: `primaryBackendStartup` becomes `Ready`, `:341-346`.
  - one update check per episode, `:355-357`.
- Restart: the window and `failureRef` are lost; the last started version stays on disk.
- Explicit or implicit: explicit for the offer (one pure function with tests, `apps/desktop/src/app/DesktopStartupRecovery.test.ts:33-98`); implicit for the window.
- Gaps:
  - **G-G4.1** [one state in two places] With updates `disabled` (the fork build), the offer is `Reinstall` of the last started version, with a link to `https://github.com/pingdotgg/t3code/releases/tag/v<version>` (`apps/desktop/src/app/DesktopStartupRecovery.ts:21`, `:226`). A fork version such as `0.1.8-fork.20261101` has no upstream release, so the link is dead. **Verdict:** by design (a known and documented limit, not a wanted behaviour).
    - Evidence: probe test "G4.1 offers `Reinstall` of the last started version when updates are disabled"; probe run 1, exit 0. Document: `docs/operations/fork.md:365` ("No such release exists, so roll back instead."). Existing test `apps/desktop/src/app/DesktopStartupRecovery.test.ts:90`; existing run 1, exit 0.

### G-M5. Backend pool registry (one entry per backend instance)

- Owner: upstream
- Stored in: memory. A `SynchronizedRef` of `Map<BackendInstanceId, RegisteredInstance>`; entry type at `apps/desktop/src/backend/DesktopBackendPool.ts:84-95`.
- States (per id): absent; `Active`; `Closing` (holds a `done` Deferred).
- Transitions:
  - (start) -> `Active` for the primary instance: `apps/desktop/src/backend/DesktopBackendPool.ts:199-203`. The primary entry has no scope and is never unregistered.
  - absent -> `Active`: `register`. Enforced at `:216-238`; a second `register` of an `Active` id fails with `DesktopBackendPoolInstanceAlreadyRegisteredError` (`:217-220`); a `register` of a `Closing` id waits for `done` (`:222-226`).
  - `Active` -> `Closing` -> absent: `unregister`. Enforced at `:277-282`; the entry is removed only when the `done` Deferred is still the same one (`:292-295`). A second `unregister` waits for the first (`:287-290`).
- Restart: all lost; the pool is built again with only the primary instance. On macOS only the primary instance exists (the other instances are WSL backends).
- Explicit or implicit: explicit; one tagged union and every change goes through `SynchronizedRef.modifyEffect`.
- Gaps:
  - **G-G5.1** [state with no exit] A `register` or `unregister` that meets a `Closing` entry waits on `done` with no time limit (`apps/desktop/src/backend/DesktopBackendPool.ts:287-290`). If the stop of that instance never ends (see G1.4), the waiter never ends. **Verdict:** confirmed. Tracked: t3code-246.
    - Evidence, Run E: test "G5.1 a second unregister and a register of the same id wait without a limit on a stop that does not end". The stop of the instance does not end. After 1 hour of test time the first `unregister`, the second `unregister` and a `register` of the same id are all pending, and `pool.get(id)` returns none. All three end when the stop ends.
    - Limit of the proof: the stop hangs because the probe's spawner makes it hang. In production the stop sends SIGTERM, then SIGKILL, and waits for the exit (existing test "unregister during pool quit does not interrupt sibling stops", `apps/desktop/src/backend/DesktopBackendPool.test.ts:205`). Thus the endless wait needs a process that does not exit after SIGKILL. `pool.register` has one caller, `apps/desktop/src/wsl/DesktopWslBackend.ts:119`, which is Windows only. No probe ran on Windows.
    - Owner: upstream. Size: S (a time limit on the wait, or a failure result for the waiter).
    - Effect on the user: on Windows, if a WSL backend process does not exit, a later stop or start of the WSL backend never finishes; this is not reachable on macOS or Linux. The Windows part is an inference from the caller, not a test result.
    - First pass: Evidence: none of my own. I read the code and ran the existing tests `apps/desktop/src/backend/DesktopBackendPool.test.ts:205` and `:261` (existing run 2, exit 0); they pin the normal close path only. I wrote no probe: the path needs a second instance, which does not exist on macOS.

### G-M6. T3 home ownership (desktop side of the server's home lock)

- Owner: upstream
- Stored in: disk, written by the server (area boundary): `<stateDir>/server-owner.sqlite` (the lock) and `<stateDir>/server-runtime.json` (the owner record). The desktop only reads them.
- States (as the desktop sees them): free; locked by a live server; locked by an owner that shuts down.
- Transitions:
  - locked -> free (wait): `awaitHomeOwnershipRelease` polls the lock every 250 ms for `BACKEND_QUIT_STOP_TIMEOUT` + 3 s. `apps/desktop/src/backend/DesktopHomeOwner.ts:62-63`, `:66`. `BACKEND_QUIT_STOP_TIMEOUT` is the 5 s terminate grace + 2 s, `apps/desktop/src/backend/DesktopBackendManager.ts:46-49`.
  - still locked -> dialog and quit: the backend exits with the "state dir owned" code, `onStateDirOwned` reads the owner and shows "This T3 home is unavailable", then quits. `apps/desktop/src/backend/DesktopBackendPool.ts:182-192`; owner read at `apps/desktop/src/backend/DesktopHomeOwner.ts:80`.
- Restart: nothing is stored by the desktop. The lock belongs to the server process.
- Explicit or implicit: implicit; the desktop infers the state from a lock probe (`apps/desktop/src/backend/DesktopHomeOwner.ts:40`) and from a child exit code.
- Gaps:
  - **G-G6.1** [state with no exit] When another live process holds the home, the desktop app waits about 10 s, shows a dialog and quits. It never takes the home over and never offers to stop the owner. **Verdict:** by design.
    - Evidence: existing tests `apps/desktop/src/backend/DesktopHomeOwner.test.ts:100` ("waits for a shutting-down owner to release the lock, then gives up"), `:65` and `:88`; existing run 1, exit 0. The test name states the intent.
  - **G-G6.2** [state lost on crash] If the desktop app dies without stopping its child (for example SIGKILL of the app), a server that keeps running keeps the home. The next launch then ends at G6.1. Whether the server exits when its parent dies is the server's side (boundary: server process lifecycle, areas A to E). **Verdict:** refuted. The server ends itself when its launcher is gone.
    - Evidence, Run A: probe test "G6.2 a real child with the real `process.ppid` exits after SIGKILL of its launcher" (`it.live`). The child mirrors `apps/server/src/cli/server.ts:44-50`. Output: `child-ready pid=97214 ppid=97198`; `desktop launcher is gone; shutting down the backend { launcherPid: 97198, parentPid: 1 }`; `server-finalizer-ran ppid=1`; `child-exit code=130`. `process.kill(childPid, 0)` then throws `ESRCH`.
    - Evidence, Run A: probe test "G6.2 the watch ends at the first poll after the parent pid changes" (1 hour with a live launcher, then the end within 2 s), and existing test "notices a launcher that was already gone when the watch began" (`apps/server/src/launcherWatch.test.ts`).
    - Limit of the proof: the probe does not run the real `runServerCommand`. The gate at `apps/server/src/cli/server.ts:43` (mode `desktop` and a bootstrap token) and the desktop bootstrap that sets both rest on code reading. There is no watch on Windows and none when the server started under pid 1; this is stated intent (`apps/server/src/launcherWatch.ts:10-14`) and probe test "G6.2 limit: no watch on Windows, and none when the server started under pid 1" shows it. Detection takes up to 2 s plus the server's shutdown time. A server whose shutdown hangs still keeps the home lock; no probe covers that case.
    - First pass: Evidence: none. I started no real process (the brief forbids a dev server) and the desktop code has no logic for this case to test.

### G-M7. Single-instance lock

- Owner: upstream
- Stored in: the Electron data folder (the Electron single-instance lock). `docs/operations/fork.md:323-324` says so.
- States: primary instance; second launch.
- Transitions:
  - launch -> primary or quit: `apps/desktop/src/app/DesktopClerk.ts:115`; the Clerk bridge does not manage the lock (`manageSingleInstanceLock: false`, `:95`).
  - second launch -> the primary gets a `second-instance` event with the argv: `:129`.
- Restart: the operating system releases the lock when the process ends.
- Explicit or implicit: explicit (one Electron primitive, one call site).
- Gaps:
  - none found. The order "lock first, then Clerk and the runtime" is pinned by `apps/desktop/src/app/DesktopClerk.test.ts:267` ("quits a second launch before initializing Clerk or the application runtime on %s"); existing run 1, exit 0.

### G-M8. Desktop settings file (`desktop-settings.json`)

- Owner: upstream
- Stored in: disk `<stateDir>/desktop-settings.json`; memory copy in a `SynchronizedRef`.
- States: file missing (defaults); file valid; file not valid for the schema (defaults in memory, old file on disk until the next save).
- Transitions:
  - load: `readSettings`, `apps/desktop/src/settings/DesktopAppSettings.ts:382-402`. One strict schema for the whole document, `:91`.
  - save: `persist`, `:486`; one writer at a time through `SynchronizedRef.modifyEffect`, `:489`; temp file `:425`, rename `:459`.
- Restart: the file stays. A save that was not finished leaves the old file (temp file plus rename); pinned by `apps/desktop/src/settings/DesktopAppSettings.test.ts:280`.
- Explicit or implicit: implicit; "the file is not valid" is not a state that the code names, logs or shows.
- Gaps:
  - **G-G8.1** [state lost on restart] One field value outside the schema makes the load return every default (`Effect.orElseSucceed(() => defaultSettings)`, `apps/desktop/src/settings/DesktopAppSettings.ts:397`). No log record is written. The next save of any field (for example the window bounds, 500 ms after a window move) replaces the file, so every earlier setting is gone. No backup is kept. **Verdict:** confirmed. Tracked: t3code-204.
    - Evidence: probe `DesktopSettings.g.probe.test.ts`, test "G8.1 one value outside the schema resets every desktop setting, and the next save overwrites the file"; probe run 2 = `cd apps/desktop && vp test run src/settings/DesktopSettings.g.probe.test.ts src/legacyLocalStorageMerge.g.probe.test.ts` -> 2 files, 3 tests passed, exit 0. It passes while it asserts the wrong behaviour: a file with `"serverExposureMode":"network-accessible"`, `"tailscaleServeEnabled":true` and `"updateChannel":"beta"` (one value the schema does not know) loads as `DEFAULT_DESKTOP_SETTINGS` (`serverExposureMode` "local-only"); after `setMainWindowBounds` the file no longer holds "network-accessible". The fallback for a malformed file is also pinned by `apps/desktop/src/settings/DesktopAppSettings.test.ts:149`; `:199` shows that only the window bounds are handled per field. Existing run 2 = `cd apps/desktop && vp test run src/settings/DesktopAppSettings.test.ts src/settings/DesktopClientSettings.test.ts src/window/QuitHold.test.ts src/backend/DesktopBackendPool.test.ts src/app/DesktopConnectionCatalogStore.test.ts` -> 5 files, 35 tests passed, exit 0.
    - Size (confirmed only): S. Effect on the user: after one setting value that this build does not know (a hand edit, or a file written by a newer build before a roll back), the host goes back to local-only without a message, and the other devices cannot connect until the owner sets network access again.

### G-M9. Client settings file and connection catalog file

- Owner: upstream
- Stored in: disk `<stateDir>/client-settings.json` and `<stateDir>/connection-catalog.json`.
- States: file missing; file present. A write in progress is a temp file `<target>.<pid>.<random>.tmp`.
- Transitions:
  - save (client settings): `set`, `apps/desktop/src/settings/DesktopClientSettings.ts:199-212`; temp path `:144`, rename `:176`. No lock and no order check. IPC entry: `apps/desktop/src/ipc/methods/clientSettings.ts:21-29`.
  - save (connection catalog): `set`, `apps/desktop/src/app/DesktopConnectionCatalogStore.ts:489`; temp path `:227`, rename `:259`. Same shape.
- Restart: the file stays; a crash in the middle leaves the old file and maybe a temp file.
- Explicit or implicit: implicit; "last rename wins".
- Gaps:
  - **G-G9.1** [two writers] Two `set` calls that overlap are not ordered. The call whose rename happens last wins, also when it carries the older value. `DesktopAppSettings` (M8) does not have this defect because it serializes its saves. **Verdict:** confirmed (the transition is unguarded). No verdict on whether the renderer sends overlapping calls; that side is `apps/web` (boundary: area F). Tracked: t3code-205.
    - Evidence: probe `DesktopSettings.g.probe.test.ts`, test "G9.1 an older client settings save that writes slower replaces a newer save"; probe run 2, exit 0. It passes while it asserts the wrong behaviour: the first `set` (`fontSizeCode` 11) is held at its file write, the second `set` (17) completes, then the first completes; the file holds 11. The connection catalog `set` has the same shape; I did not probe it.
    - Size (confirmed only): S. Effect on the user: two fast setting changes can leave the older value on disk, which then comes back at the next app start.

### G-M10. Legacy (V1) local storage import

- Owner: upstream
- Stored in: disk marker `<userData>/v1-local-storage-imported` (`apps/desktop/src/app/DesktopLegacyLocalStorage.ts:23`); memory `items` Ref (taken once); the renderer's `localStorage`.
- States: not imported (no marker); read and waiting for the renderer; merged; marked done.
- Transitions:
  - not imported -> done with no V1 data: marker written at once, `apps/desktop/src/app/DesktopLegacyLocalStorage.ts:80`.
  - not imported -> read: `:82-96`; a read error is logged and the import is tried again at the next launch (`:85-87`).
  - read -> merged: the preload takes the items with a synchronous IPC call and merges them, `apps/desktop/src/preload.ts:36-44`; merge at `apps/desktop/src/legacyLocalStorageMerge.ts:79-101`.
  - merged -> marked done: only when the merge returned `true`; the preload then sends `complete` without waiting (`apps/desktop/src/preload.ts:40-41`); marker write at `apps/desktop/src/app/DesktopLegacyLocalStorage.ts:66`, a write failure is only logged (`:69`).
- Restart: no marker means the whole import runs again. The step "merged" is not recorded.
- Explicit or implicit: implicit; one marker file stands for a four-step protocol across two processes.
- Gaps:
  - **G-G10.1** [state lost on crash] The import is not idempotent for user deletions. When the marker is not written (one `setItem` throws, the marker write fails, or the app stops between the merge and the marker), the next launch merges the V1 data again and brings back entries that the user deleted in between. **Verdict:** confirmed. Tracked: t3code-206.
    - Evidence: probe `legacyLocalStorageMerge.g.probe.test.ts`, test "G10.1 an import that repeats on the next launch brings back what the user deleted"; probe run 2, exit 0. It passes while it asserts the wrong behaviour: first merge returns `false`, the user removes one stash entry, the second merge puts it back. The existing tests of the merge are in `apps/desktop/src/legacyLocalStorageMerge.test.ts` (existing run 1, exit 0); `apps/desktop/src/app/DesktopLegacyLocalStorage.ts` has no test file (`ls apps/desktop/src/app | grep -i LegacyLocalStorage` prints only `DesktopLegacyLocalStorage.ts`).
    - Size (confirmed only): S. Effect on the user: only on a machine that still has V1 data and only while the marker is missing; deleted drafts or stash entries come back after a restart.

### G-M11. Main window lifecycle and restore state

- Owner: upstream
- Stored in: memory (`backendReadyRef`, `backendHasStarted`, `mainClosedDuringStartup`, `apps/desktop/src/window/DesktopWindow.ts:395-397`; renderer recovery timestamps); disk: window bounds inside `desktop-settings.json` (M8).
- States: no window (backend not ready); main window open; main window closed during startup; renderer crashed and reloading; renderer crashed and given up.
- Transitions:
  - backend ready -> window: `handleBackendReady`, sets the flags at `:1161-1162` and creates the window unless the user closed it during startup (`:1164`).
  - backend not ready: `handleBackendNotReady`, `:1166`.
  - closed during startup: `:1001`; cleared at `:1013`.
  - bounds changed -> saved after 500 ms: `:89`, `:587`; flushed before close (pinned by `apps/desktop/src/window/DesktopWindow.test.ts:1273`; existing run 5, exit 0).
  - load failed: `did-fail-load` handler at `:907`; a retry exists only in development (`:90`, `:849-872`); in a packaged build the failure is only logged. `loadURL` errors are dropped at `:864`.
  - renderer gone -> reload after 500 ms, at most 3 times in 60 s: `:91-93`, `:932-962`.
- Restart: all memory flags are lost; the bounds stay on disk.
- Explicit or implicit: implicit; flags and closures, no state type.
- Gaps:
  - **G-G11.1** [state with no exit] After the third renderer crash inside 60 s the handler returns (`apps/desktop/src/window/DesktopWindow.ts:954-956`). The window stays with a dead renderer; the only trace is one log record. In a packaged build a main-frame load failure has the same end. **Verdict:** confirmed. Tracked: t3code-244.
    - Evidence, Run D, five tests:
      - "G11.1 the fourth renderer crash inside 60 s is left without a reload or a message". Log annotation `recovering` is true, true, true, false. After the fourth crash and 1 hour there is no reload, no new window and nothing sent to the window.
      - "G11.1 contrast: a crash 60 s after the earlier ones is reloaded".
      - "G11.1 a renderer that fails to launch is never reloaded".
      - "G11.1 a main-frame load failure outside development is logged and not retried".
      - "G11.1 contrast: in development the same load failure is retried".
    - Correction to the first-pass text: crashes 1 to 3 inside 60 s are reloaded. The fourth one is the first without a reload.
    - Limit of the proof: the probe uses a fake `BrowserWindow`, so the real Electron event order is not tested. A manual way out exists: View > Reload (`runMainContentsCommand("reload")`, existing test "reloads and inspects the main window even when a popup has focus", `apps/desktop/src/window/DesktopWindow.test.ts:829`). P2 stays true: the repository has no test for renderer crash recovery.
    - Owner: upstream. Size: S (show a message or a reload action when recovery stops).
    - Effect on the user: the window stays blank with no message until the user picks Reload or restarts the app.
    - First pass: Evidence: code reading only. No existing test covers it: `grep -rn "render-process-gone\|did-fail-load\|RENDERER_RECOVERY" apps/desktop/src --include=*.test.ts` gives 4 hits, all in `preview/` and `telemetry/` tests, none for the main window. I wrote no probe: the handler lives inside the window factory and needs the fake `BrowserWindow` harness of `DesktopWindow.test.ts`, which I did not learn. `apps/desktop/src/window/DesktopWindow.test.ts` ran green (existing run 5, exit 0), which shows only that the other states hold.
  - **G-G11.2** [one state in two places] "The backend is ready" is kept in three live places: the manager state (`ready`, M1), `DesktopState.primaryBackendStartup` (`apps/desktop/src/app/DesktopState.ts:22`) and `backendReadyRef` (`apps/desktop/src/window/DesktopWindow.ts:395`). A fourth, `DesktopState.backendReady`, is dead (see P1). **Verdict:** confirmed. The three copies disagree in two orders of events. The first-pass sentence "no order of events in which the three live copies disagree for longer than one callback" is wrong. Tracked: t3code-245.
    - Order 1, a window error at readiness. Run E, test "G1.6 a window error at readiness leaves primaryBackendStartup at Starting while the manager is ready": manager `ready` true, `primaryBackendStartup` `Starting`, for 1 hour. Run D, test "G11.2 a failed window create leaves the window's readiness copy set, and activate then creates the window": `backendReadyRef` stays true after the failed create (output `handleBackendReady failed=true creates=2 loads=1`; before readiness `activate` creates nothing). This order is by design (`DesktopBackendPool.ts:166`, `:169`).
    - Order 2, a crash after `Ready`. Run E, test "G1.6/G11.2 after Ready a crashed backend leaves primaryBackendStartup at Ready until the startup failure report": the manager says not ready and the pool calls `handleBackendNotReady`, but `primaryBackendStartup` stays `Ready` until the startup failure report sets `Failing`. No comment states intent for this order.
    - Limit of the proof: two probes with stubs show the copies; no test wires the real window layer into the real pool. The length of order 2 was not measured (the report comes at restart attempt 3, `apps/desktop/src/backend/DesktopBackendManager.ts:53` and `:1038`, by reading). No effect on the user was shown for either order. Not probed: after order 1 a later `activate` creates the main window while `primaryBackendStartup` stays `Starting`; the reaction of the recovery window to that state is unknown.
    - Owner: upstream. Size: S.
    - Effect on the user: none was shown; the risk is that code which reads one copy acts on a value that the other copies contradict.

### G-M12. Quit shortcut hold (Cmd+Q)

- Owner: upstream
- Stored in: memory, closure variables in `apps/desktop/src/window/QuitHold.ts` (196 lines, read in full).
- States: idle; holding (mode not yet known); holding in hold mode; armed; released inside the grace time.
- Transitions: all inside the one module; a `generation` counter drops late results of a superseded press; a `watchdog` timer is part of the state.
- Restart: lost; no effect.
- Explicit or implicit: implicit in form (flags), but one module owns every transition and its tests name the races.
- Gaps:
  - none found. Tests: `apps/desktop/src/window/QuitHold.test.ts:69`, `:88`, `:133`, `:155`; existing run 2, exit 0.

### G-M13. Shared workers and locks (`packages/shared`)

- Owner: upstream
- Stored in: memory. `KeyedCoalescingWorker`: a transactional state of pending values and active keys. `DrainableWorker`: a queue plus a count. `KeyedLock`: a map of semaphores per key.
- States (`KeyedCoalescingWorker`, per key): idle; pending; active; active with a newer pending value.
- Transitions:
  - enqueue -> pending (values for one key are merged); pending -> active; active -> idle or pending again. The processor result is dropped by `Effect.ignoreCause`, `packages/shared/src/KeyedCoalescingWorker.ts:75`.
  - `drainKey` waits until the key is neither pending nor active, `packages/shared/src/KeyedCoalescingWorker.ts:100`.
- Restart: lost. The only caller is the server terminal manager, `apps/server/src/terminal/Manager.ts:1937` (drain at `:1986`); boundary: the server terminal area.
- Explicit or implicit: explicit for the key state; implicit for failure and for scope close.
- Gaps:
  - **G-G13.1** [lost information] A processor failure or defect leaves no log record and the value is dropped. `DrainableWorker` logs the same case ("DrainableWorker item failed", pinned by `packages/shared/src/DrainableWorker.test.ts:22`). **Verdict:** confirmed. Tracked: t3code-207.
    - Evidence: probe `KeyedCoalescingWorker.g.probe.test.ts`, test "G13.1 a failed or defective item leaves no log record and its value is dropped"; probe run 3 = `cd packages/shared && vp test run src/KeyedCoalescingWorker.g.probe.test.ts` -> 1 file, 2 tests passed, exit 0. It passes while it asserts the wrong behaviour. Existing run 3 = `cd packages/shared && vp test run src/KeyedCoalescingWorker.test.ts src/DrainableWorker.test.ts src/KeyedLock.test.ts` -> 3 files, 11 tests passed, exit 0.
    - Size (confirmed only): S. Effect on the user: today small; the one caller's processor has error type `never`, so only a defect (a bug) in terminal history persistence would disappear without a trace.
  - **G-G13.2** [state with no exit] `drainKey` waits for ever for a key that was pending when the worker's scope closed. `DrainableWorker` documents and tests the matching case (`packages/shared/src/DrainableWorker.test.ts:52`). **Verdict:** confirmed. Tracked: t3code-207.
    - Evidence: probe test "G13.2 drainKey waits for ever for a key that was pending when the scope closed"; probe run 3, exit 0. It passes while it asserts the wrong behaviour (after the scope closes and the test clock moves, the drain fiber is still not done).
    - Size (confirmed only): S. Effect on the user: none shown; it needs a `drainKey` call that races the server shutdown. Whether `apps/server/src/terminal/Manager.ts:1986` can do that is the server's side. - `KeyedLock` is "not reentrant: taking a key while already holding it deadlocks"; this is documented in `packages/shared/src/KeyedLock.ts` and is by design. Tests `packages/shared/src/KeyedLock.test.ts:13`, `:48`, `:66`, `:97`; existing run 3, exit 0. No gap claimed.

### G-M14. Compile cache of the desktop app and of the bundled server

- Owner: upstream
- Stored in: disk. `<tmpdir>/t3code/compile-cache` on macOS (`apps/desktop/src/compileCache.ts:11-16`); for the server child a directory below it whose name is the CRC32 of the resources path (`scripts/lib/server-compile-cache.ts:78`), seeded from a prepared cache that the build ships.
- States: no cache; prepared cache seeded; prepared cache refused; Node cache only.
- Transitions:
  - seed: `seedPreparedCache`, `scripts/lib/server-compile-cache.ts:26`; refused when the manifest format is not 1 or the runtime identity differs (`:35`, identity at `:10`).
  - enable: `enablePreparedServerCache`, `:69`; any error makes it return `false` (`:139`), and the caller then enables the plain Node cache (`apps/desktop/src/compileCache.ts:20-22`).
- Restart: the cache stays on disk. macOS can delete the temp directory at any time; the cache is then built again.
- Explicit or implicit: implicit; staleness is left to Node's own cache key plus the runtime identity check.
- Gaps:
  - none proved. Every failure is swallowed on purpose (`apps/desktop/src/compileCache.ts:24`, `scripts/lib/server-compile-cache.ts:60`, `:64`, `:139`): a cache failure costs start time only. I read `scripts/lib/server-compile-cache.ts` lines 1-150 of 182 and did not run `scripts/lib/server-compile-cache.test.ts`. The new build at the same install path reuses the same directory; I did not prove or refute that a stale entry can be loaded. No verdict.

### G-M15. IPC requests between the renderer and the main process

- Owner: upstream
- Stored in: nothing. One request is one Electron `invoke` or one synchronous message.
- States: none kept. Each handler decodes, checks the sender and answers.
- Transitions: asynchronous handler at `apps/desktop/src/ipc/DesktopIpc.ts:116`, sender check `:120`; synchronous handler `:152`, sender check `:157`.
- Restart: an open request is lost with the process.
- Explicit or implicit: stateless.
- Gaps:
  - **G-G15.1** [wait without limit] No handler has a time limit of its own; a handler that never ends leaves the renderer's promise open. **Verdict:** confirmed. Tracked: t3code-247.
    - Evidence, Run F: test "G15.1 an invoke whose handler does not end stays open, also after the handler is unregistered". The invoke promise is pending after 1 hour of test time. It is still pending after the registration scope closes (the handler is removed from `ipcMain`) and 1 more hour. It settles only when the handler's own wait ends. A contrast handler that sleeps 1 minute settles after `TestClock.adjust(1 minute)`, so the handlers run on the test clock and a time limit would have fired.
    - Limit of the proof: the stuck handler is synthetic. No production handler was shown to hang; the first pass names only the handlers that wait on M1 (G1.4) and M3 (G3.2), by reading. Time limits on the renderer side of a call were not checked.
    - Owner: upstream. Size: S (a time limit in `DesktopIpc.handle`, `apps/desktop/src/ipc/DesktopIpc.ts:104-139`).
    - Effect on the user: a renderer call to a handler that hangs never settles, so the part of the UI that awaits it stays in its waiting state.

### G-M16. SSH password prompt (one request from an SSH launch to the renderer)

- Owner: upstream
- Stored in: memory. A map of pending prompts (`apps/desktop/src/ssh/DesktopSshPasswordPrompts.ts:231`), one Deferred per prompt (`:334`).
- States (per request): pending; resolved with a password; cancelled; timed out; window closed; service stopped.
- Transitions: pending -> timed out after 3 minutes (`:21`, `:395`); pending -> window closed (`cancelOnWindowClosed`, `:345-363`); pending -> service stopped (`cancelPending`, `:235`); cleanup always removes the entry and tells the window (`:384-393`).
- Restart: lost; the SSH launch fails.
- Explicit or implicit: explicit enough; every pending entry has four exits and one cleanup.
- Gaps:
  - none found. Tests `apps/desktop/src/ssh/DesktopSshPasswordPrompts.test.ts:120` and `:196`; existing run 4 = `cd apps/desktop && vp test run src/ssh/DesktopSshPasswordPrompts.test.ts src/permissions/MacPermissionHelper.test.ts` -> 2 files, 7 tests passed, exit 0. I read lines 225-250 and 318-430 of this file only. `apps/desktop/src/ssh/DesktopSshEnvironment.ts` (the launch itself) is not read; see "Not read".

### G-M17. macOS permission helper window

- Owner: upstream
- Stored in: memory. `generation` and `window` in `apps/desktop/src/permissions/MacPermissionHelper.ts:68-69`.
- States: no helper; probing the permission; helper shown (polls the permission each second, `:182`); closed.
- Transitions: `show` closes any earlier helper first (`:84`) and drops its own result when a newer `show` started (`generation` check, `:85-87`); granted -> close and focus the owner (`:116-122`); helper window closed -> timer cleared (`:184-185`).
- Restart: lost; the operating system keeps the permission itself.
- Explicit or implicit: implicit but small; one class owns it.
- Gaps:
  - none proved. The superseded-probe race is pinned by `apps/desktop/src/permissions/MacPermissionHelper.test.ts:111`; existing run 4, exit 0. The poll has no time limit while the helper is open; that is the purpose of the helper. An error of the permission probe inside the poll is dropped (`catch {}` in `check`, `:124-133`); no verdict on its effect.

### G-M18. Remote desktop update (an update prepared for a remote host)

- Owner: upstream
- Stored in: memory, refs in `apps/desktop/src/updates/DesktopRemoteUpdates.ts`; prepared update status `"prepared" | "committing" | "failed"` at `:36`.
- States: none; prepared; committing; failed.
- Transitions: decided by one pure function, `nextRemoteDesktopUpdateStep`, `apps/desktop/src/updates/remoteUpdateFlow.ts:32`; at most 3 downloads (`:21`, `:63`).
- Restart: lost.
- Explicit or implicit: explicit for the step choice (one function).
- Gaps:
  - none claimed. The function returns at once when the updater is `disabled` (`apps/desktop/src/updates/remoteUpdateFlow.ts:37`), which is the permanent state of the fork build (G3.1). I read only an outline of `DesktopRemoteUpdates.ts` (517 lines); see "Not read".

### G-M19. Status, phase and state types that cross the wire (`packages/contracts/src`)

- Owner: both. The fork owns `ThreadPullRequestWatchEndReason`, `ThreadPullRequestWatchSkipReason` and `watchRecord` in `packages/contracts/src/threadPullRequest.ts`; the rest is upstream.
- Stored in: the contracts hold only the type. The values live in the server's event stream and projections (areas A to E), in desktop memory (update state), and in client stores (area F).
- States (catalogue; `path:line` is the literal list):
  - Run: `OrchestrationV2RunStatus`, `packages/contracts/src/orchestrationV2.ts:614`: preparing, queued, starting, running, waiting, completed, interrupted, failed, cancelled, rolled_back.
  - Shell thread: `OrchestrationV2ShellThreadStatus`, `:2098`: idle plus the run status.
  - Run attempt: `OrchestrationV2RunAttempt.status`, `:756`: pending, running, completed, interrupted, failed, cancelled, superseded.
  - Node: `:789`: idle, pending, running, waiting, completed, interrupted, failed, cancelled, rolled_back.
  - Subagent (delegated task): `:917`: idle, pending, running, waiting, completed, failed, cancelled, interrupted.
  - Delegated completion delivery: `OrchestrationV2DelegatedCompletionTaskDeliveryState`, `:628`: pending, claimed, acknowledged, delivered, disposed. Cohort disposition `:654`: open, stopped, disposed.
  - Provider session: `:964`: starting, ready, running, waiting, stopped, error.
  - Provider thread: `:1109`: not_loaded, idle, active, archived, closed, error.
  - Provider goal: `OrchestrationV2ProviderGoalStatus`, `:1079`: active, paused, blocked, usage_limited, budget_limited, complete.
  - Provider turn: `OrchestrationV2ProviderTurn.status`, `:1201`: pending, running, completed, interrupted, failed, cancelled.
  - Runtime request: `:1242`: pending, resolved, expired, cancelled.
  - Turn item: `OrchestrationV2TurnItemStatus`, `:1465`: idle, pending, running, waiting, completed, failed, cancelled, interrupted.
  - Plan artifact: `:1393`: draft, active, completed, superseded.
  - Context transfer: `OrchestrationV2ContextTransfer.status`, `:257`: pending, resolved_native, resolved_portable, failed, consumed, superseded.
  - Secret request: `OrchestrationV2SecretRequestStatus`, `:1581`: pending, saved, declined, cancelled. Link request: `OrchestrationV2LinkRequestStatus`, `:1602`: pending, linked, declined, cancelled, failed.
  - Other inline lists in the same file that I did not map to a struct name: `:824` (queued, running, completed, failed), `:1168` (pending, ready, failed, superseded), `:1182` (pending, injected, inline), `:1363` (pending, running, completed), `:1438` (ready, missing, error, stale), `:3277` (phase: worktree, setup).
  - MCP delegated task: `OrchestratorMcpDelegatedTaskStatus`, `packages/contracts/src/orchestratorMcp.ts:149`: queued, running, waiting, completed, failed, cancelled, interrupted; terminal subset `OrchestratorMcpTerminalDelegatedTaskStatus`, `:160`.
  - Pull request watch: `ThreadPullRequestWatchEndReason`, `packages/contracts/src/threadPullRequest.ts:110` (merged, closed, unreadable, comment-limit, settled, subagent, archived, unwatched, unlinked, stopped); `ThreadPullRequestWatchSkipReason`, `:125` (missing-tool, unauthenticated, forbidden, rate-limited, not-found, failed). The watch itself has no status field: "watching" is the presence of `watch` on the link, "ended" is `endedWatch` plus `watchRecord.ended` (link fields at `:160-163`, record at `:136`).
  - Scheduled task run: `ScheduledTaskRunStatus`, `packages/contracts/src/scheduledTask.ts:217`: never, running, succeeded, failed.
  - Terminal session: `TerminalSessionStatus`, `packages/contracts/src/terminal.ts:89`: starting, running, exited, error.
  - Desktop update: `DesktopUpdateStatus`, `packages/contracts/src/ipc.ts:71` (schema `:86`): disabled, idle, checking, up-to-date, available, downloading, downloaded, error.
  - Files with further status or reason lists that I only found by search and did not read: `server.ts`, `pullRequest.ts`, `relay.ts`, `relayClient.ts`, `projectClone.ts`, `worktreeSetup.ts`, `worktreeMcp.ts`, `guestShare.ts`, `peerLink.ts`, `device.ts`, `speech.ts`, `preview.ts`, `providerSetup.ts`, `resourceTelemetry.ts`, `usage.ts`, `sourceControl.ts`, `git.ts`, `background.ts`, `remoteAccess.ts` (all in `packages/contracts/src`).
- Transitions:
  - The contracts check values only. Every type above is a `Schema.Literals` list or a TypeScript union. No contract states which change is allowed: `grep -rnEi "canTransition|allowedTransitions|transitionTable|validTransition|nextStatus|isTerminal" packages/contracts/src` prints nothing. So at the contract level any writer can set any listed value.
  - The only status predicates that the contracts export are `isOrchestrationV2WorkActive` (`packages/contracts/src/orchestrationV2.ts:939`), `isLiveSubagentShell` (`:2220`) and `isOlderSettledThreadShell` (`:2238`).
  - Who writes, as far as I checked by search (the checks themselves belong to areas A to E):
    - Desktop update status: one module, the reducers in `apps/desktop/src/updates/updateMachine.ts`, called from `apps/desktop/src/updates/DesktopUpdates.ts`. Not every transition is guarded (G3.3).
    - Pull request watch reasons and `watchRecord`: one writer, `apps/server/src/orchestration-v2/Orchestrator.ts:787` and `:4616-4638`; the reason is chosen in `apps/server/src/orchestration-v2/PullRequestWatchReactor.ts`.
    - Delegated completion delivery state: two files, `apps/server/src/orchestration-v2/Orchestrator.ts` and `apps/server/src/orchestration-v2/ThreadDeletion.ts` (`grep -rlE "completionDelivery: \{|completionDelivery = " apps/server/src --include=*.ts`, tests removed).
    - Terminal session status: four files write `status: "starting"` or `status: "exited"`: `apps/server/src/orchestration-v2/Orchestrator.ts`, `apps/server/src/terminal/Manager.ts`, `apps/server/src/resourceTelemetry/NativeTelemetryClient.ts`, `apps/server/src/device/SshDeviceHost.ts` (some of these hits can belong to another type with the same literals; I did not separate them).
    - Runs, attempts, nodes, turns, sessions, requests: written through orchestrator events; I did not determine the checking module. The only server module that is named as a transition policy is `apps/server/src/orchestration-v2/ProviderSessionTransitionPolicy.ts` (`ls apps/server/src/orchestration-v2 | grep -i transition` prints it and its test); a content search for `canTransition|allowedTransitions|TransitionPolicy|validTransition` over `apps/server/src` (tests removed) names one more file, `apps/server/src/orchestration-v2/ProviderSwitchService.ts`. I read neither.
- Restart: not applicable to the types. See areas A to E for each stored value.
- Explicit or implicit: implicit at the contract level; the value sets are explicit, the allowed changes and the "terminal" subsets are not.
- Gaps:
  - **G-G19.1** [one state in two places] The set of "terminal" status values is defined again in at least nine server places and once more in the client, because the contracts export it only for the MCP delegated task (`packages/contracts/src/orchestratorMcp.ts:160`). Places: `apps/server/src/orchestration-v2/Orchestrator.ts:846`, `apps/server/src/orchestration-v2/ThreadManagementService.ts:533`, `apps/server/src/orchestration-v2/RunExecutionService.ts:90`, `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts:2466`, `apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts:931`, `apps/server/src/mcp/OrchestratorMcpService.ts:499`, `apps/server/src/peer/RemoteDelegation.ts:978` (takes a plain `string`), `apps/server/src/cli/thread.ts:45`, `apps/server/src/telemetry/ProviderUsageAnalytics.ts:80`; client: `packages/client-runtime/src/state/threadSettled.ts` (area F). **Verdict:** confirmed that the copies exist; no verdict on a disagreement. I printed each copy and compared the lists by eye per status type; I found no difference. I wrote no test that compares them. Tracked: t3code-208.
    - Evidence: the search above over `packages/contracts/src` prints nothing; each `path:line` above was printed with `sed -n <line>p` and shows a function or a set named "terminal".
    - Size (confirmed only): M (one exported predicate per status type, then nine call sites). Effect on the user: none today; a new status value added to one list and not to the others would make one part of the app treat a run as ended and another as live.
  - **G-G19.2** [status value no code writes] Context transfer status `resolved_native` (`packages/contracts/src/orchestrationV2.ts:259`) has no writer. **Verdict:** confirmed. Tracked: t3code-209.
    - Evidence: `grep -rn "resolved_native" apps packages --include=*.ts --include=*.tsx | grep -v node_modules` prints two lines only: `apps/web/src/components/chat/ThreadRelationshipIcon.tsx:31` (a `case`) and `packages/contracts/src/orchestrationV2.ts:259` (the list). The fork did not add it (`git diff origin/main...origin/fork -- packages/contracts/src/orchestrationV2.ts | grep -c 'resolved_native\|"draft"'` prints 0). Owner: upstream.
    - Size (confirmed only): S. Effect on the user: none; a dead value and a dead client branch.
  - **G-G19.3** [status value no code writes] Plan artifact status `draft` (`packages/contracts/src/orchestrationV2.ts:1393`) is not written by the server. **Verdict:** confirmed for the literal; a value that a provider payload carries through a schema decode would not show in this search. Tracked: t3code-209.
    - Evidence: `grep -rn "\"draft\"" apps/server/src --include=*.ts | grep -v "\.test\." | wc -l` prints 0. The plan status writes that the search does find are `apps/server/src/orchestration-v2/Orchestrator.ts:6805` (`completed`) and `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts:7908` (`superseded`). Owner: upstream.
    - Size (confirmed only): S. Effect on the user: none shown.
  - **G-G19.4** [value no client handles] `watchRecord` (fork-owned, why a watch ended and why sweeps were skipped) is read by no client. It reaches only agents, through the MCP tool output (`apps/server/src/mcp/toolkits/pullRequests/handlers.ts:146-147`). **Verdict:** confirmed that no client reads it. Whether a client should show it is a product choice; the contract comment calls it "the durable trace" because "logs rotate" (`packages/contracts/src/threadPullRequest.ts:135`), which does not name a reader. Tracked: t3code-210.
    - Evidence: `grep -rn "watchRecord" apps/web/src apps/mobile packages/client-runtime/src apps/desktop/src --include=*.ts --include=*.tsx | grep -v node_modules` prints nothing. Owner: fork.
    - Size (confirmed only): S. Effect on the user: when a pull request watch stops (for example `unreadable` or `comment-limit`) or is skipped (for example `unauthenticated`), the owner sees no reason in the app; only an agent that lists the thread's pull requests sees it.
  - **G-G19.5** [status value no code writes] Checked and not found for the fork-owned lists: each of the 10 watch end reasons has a writer. **Verdict:** refuted.
    - Evidence: a per-value search over `apps/server/src` (tests removed) finds a writer for 8 values on a line that also names the watch; the two that the pattern missed are `subagent` at `apps/server/src/orchestration-v2/PullRequestWatchReactor.ts:487` and `unwatched` at `apps/server/src/orchestration-v2/Orchestrator.ts:4616`. I did not run the same check for the 6 skip reasons.
  - **G-G19.6** [status value no code writes or no client handles] Checked and not found for `DesktopUpdateStatus`. **Verdict:** refuted.
    - Evidence: per-value counts of `status: "<value>"` in `apps/desktop/src` (tests removed) and of comparisons in `apps/web/src`: disabled 2/2, checking 1/4, available 3/7, downloading 2/8, downloaded 4/5, error 7/3. The two zero counts have other forms: `idle` is written at `apps/desktop/src/updates/DesktopUpdates.ts:309`; `up-to-date` is read at `apps/web/src/components/settings/SettingsPanels.tsx:295`. - Note, not a gap for the owner: provider goal statuses `usage_limited` and `budget_limited` are written only by the Codex adapter (`apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts:966-967`); the Claude path never sets them.

### Area G: other points

- **G-P1** [untested state / dead state] `DesktopState.backendReady` is created and never read or written, `apps/desktop/src/app/DesktopState.ts:18` and `:27`. **Verdict:** confirmed. Tracked: t3code-209.
  - Evidence: `grep -rn "backendReady\b" apps/desktop/src apps/web/src packages` prints these two lines and a local variable in `apps/desktop/src/window/DesktopWindow.ts:1148`; nothing else. A reader of the code can take it for the source of truth; the live flags are listed in G11.2. Size S.
  - Owner: upstream.
- **G-P2** [untested state] The main window's renderer crash recovery (3 reloads in 60 s, then stop) and its load-failure handling have no test, `apps/desktop/src/window/DesktopWindow.ts:907` and `:932-962`. **Verdict:** confirmed (no test exists). Tracked: t3code-211.
  - Evidence: the search given in G11.1; its 4 hits are in `preview/` and `telemetry/` tests.
  - Owner: upstream.
- **G-P3** [lost information] The desktop settings load replaces a file that fails the schema with the defaults and writes no log record, `apps/desktop/src/settings/DesktopAppSettings.ts:397`. **Verdict:** confirmed. Tracked: t3code-204.
  - Evidence: the probe of G8.1 (probe run 2, exit 0); the existing test `apps/desktop/src/settings/DesktopAppSettings.test.ts:149` pins the fallback.
  - Owner: upstream.
- **G-P4** [lost information] The preload wraps the whole legacy import in `try {} catch {}`, `apps/desktop/src/preload.ts:37-44`, and the marker write failure is only logged, `apps/desktop/src/app/DesktopLegacyLocalStorage.ts:69`. **Verdict:** confirmed for the effect (the import repeats), by the probe of G10.1 (probe run 2, exit 0). The empty `catch` itself is not exercised by a probe. Tracked: t3code-206.
  - Owner: upstream.
- **G-P5** [untested state] `apps/desktop/src/app/DesktopLegacyLocalStorage.ts` (marker, load, take, complete) has no test file. **Verdict:** confirmed. Tracked: t3code-206.
  - Evidence: `ls apps/desktop/src/app | grep -i LegacyLocalStorage` prints only the module.
  - Owner: upstream.
- **G-P6** [lost information] `KeyedCoalescingWorker` drops processor failures without a log record, `packages/shared/src/KeyedCoalescingWorker.ts:75`. Same as G13.1; listed here for the kind. **Verdict:** confirmed (probe run 3, exit 0). Tracked: t3code-207.
- **G-P7** [wait without limit] `drainKey`, `packages/shared/src/KeyedCoalescingWorker.ts:100`. Same as G13.2. **Verdict:** confirmed (probe run 3, exit 0). Tracked: t3code-207.
- **G-P8** [wait without limit] The backend stop on quit waits for the child exit after its own time limit has passed, `apps/desktop/src/backend/DesktopBackendManager.ts:307-332`. Same as G1.4 (by design, pinned by an existing test). Listed here for the kind. **Verdict:** no verdict of its own; see the gap it names.
- **G-P9** [lost information] `relaunch` only logs its errors and leaves `quitting` set, `apps/desktop/src/app/DesktopLifecycle.ts:216-245`. Same as G2.1 (confirmed, probe run 1). **Verdict:** no verdict of its own; see the gap it names. Tracked: t3code-202.
- **G-P10** [lost information] The main window drops `loadURL` errors, `apps/desktop/src/window/DesktopWindow.ts:864`. **Verdict:** refuted, with a limit. Tracked: t3code-211.
  - Evidence, Run D: test "P10 a rejected loadURL leaves no record; the did-fail-load event leaves one". The rejection alone writes no record (`apps/desktop/src/window/DesktopWindow.ts:860-865`). The `did-fail-load` handler writes a warning with `errorCode`, `errorDescription` and `url`.
  - Limit of the proof: the probe uses a fake window. The link "each rejection comes with a `did-fail-load` event" rests on the Electron typings (`electron.d.ts:6239`, "rejects if the page fails to load (see `did-fail-load`)"), not on a test. A rejection without that event would leave no record.
