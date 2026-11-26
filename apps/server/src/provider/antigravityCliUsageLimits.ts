import type {
  AntigravitySettings,
  ServerProvider,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";
import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import type { ManagedServerProvider } from "@t3tools/provider-core/server/snapshot";
import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
  resolveUsageLimitsAfterProbe,
} from "@t3tools/provider-core/server/usageLimits";
import * as Clock from "effect/Clock";
import * as Digest from "effect/crypto/Digest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as FiberHandle from "effect/FiberHandle";
import * as FileSystem from "effect/FileSystem";
import * as Hex from "effect/encoding/Hex";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

const ANTIGRAVITY_CLI_PRINT_TIMEOUT = "15s";
const ANTIGRAVITY_CLI_OUTER_TIMEOUT = "20 seconds";
const USAGE_FRESH_MS = 5 * 60_000;
const USAGE_FAILURE_BACKOFF_MS = 5 * 60_000;
const MAX_CLI_OUTPUT_BYTES = 256 * 1024;

const WINDOW_DURATION_MINS = new Map<string, number>([
  ["5h", 5 * 60],
  ["weekly", 7 * 24 * 60],
]);

const AgyUsageBucket = Schema.Struct({
  id: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  window: Schema.optional(Schema.String),
  remaining_fraction: Schema.optional(Schema.Number),
  reset_time: Schema.optional(Schema.String),
  disabled: Schema.optional(Schema.Boolean),
});

const AgyUsageGroup = Schema.Struct({
  name: Schema.optional(Schema.String),
  displayName: Schema.optional(Schema.String),
  buckets: Schema.optional(Schema.Array(AgyUsageBucket)),
});

const AgyCliUsageResponse = Schema.Struct({
  status: Schema.String,
  error: Schema.optional(Schema.String),
  command: Schema.optional(
    Schema.Struct({
      name: Schema.optional(Schema.String),
      data: Schema.optional(
        Schema.Struct({
          groups: Schema.optional(Schema.Array(AgyUsageGroup)),
          buckets: Schema.optional(Schema.Array(AgyUsageBucket)),
        }),
      ),
    }),
  ),
});

const decodeAgyCliUsage = Schema.decodeUnknownOption(AgyCliUsageResponse);

const AUTH_ERROR_PATTERN =
  /authentication required|authentication failed|please sign in|not authenticated|accounts\.google\.com\/o\/oauth2\//i;

export function isAntigravityCliAuthPrompt(text: string): boolean {
  return AUTH_ERROR_PATTERN.test(text);
}

function decodeUsageResponseFromOutput(
  text: string,
): Option.Option<typeof AgyCliUsageResponse.Type> {
  const trimmed = text.trim();
  if (trimmed.length === 0) return Option.none();
  try {
    const decoded = decodeAgyCliUsage(JSON.parse(trimmed));
    if (Option.isSome(decoded)) return decoded;
  } catch {
    // Fall through to line-based scanning when notice lines surround the JSON payload.
  }
  const lines = trimmed.split("\n");
  for (let start = 0; start < lines.length; start += 1) {
    if (!lines[start]?.trimStart().startsWith("{")) continue;
    for (let end = lines.length; end > start; end -= 1) {
      if (!lines[end - 1]?.trimEnd().endsWith("}")) continue;
      try {
        const decoded = decodeAgyCliUsage(JSON.parse(lines.slice(start, end).join("\n")));
        if (Option.isSome(decoded)) return decoded;
      } catch {
        // Try a tighter slice when trailing notice lines follow the JSON payload.
      }
    }
  }
  return Option.none();
}

function formatGroupLabel(groupName: string | undefined, bucketId: string): string {
  const raw = groupName?.trim();
  if (raw) {
    if (/^gemini\s+models$/i.test(raw)) return "Gemini";
    if (/^claude\s+and\s+gpt\s+models$/i.test(raw)) return "Claude & GPT (shared)";
    return raw;
  }
  return bucketId.startsWith("3p-") ? "Claude & GPT (shared)" : "Gemini";
}

function resolveWindowMeta(
  bucket: typeof AgyUsageBucket.Type,
  id: string,
): {
  readonly kind: ServerProviderUsageWindow["kind"];
  readonly labelSuffix: string;
  readonly windowDurationMins: number | undefined;
} {
  const windowKey =
    bucket.window?.trim().toLowerCase() ||
    (id.endsWith("-5h") ? "5h" : id.endsWith("-weekly") ? "weekly" : undefined);
  if (windowKey === "5h") {
    return {
      kind: "session",
      labelSuffix: "5-hour",
      windowDurationMins: WINDOW_DURATION_MINS.get("5h"),
    };
  }
  if (windowKey === "weekly") {
    return {
      kind: "weekly",
      labelSuffix: "Weekly",
      windowDurationMins: WINDOW_DURATION_MINS.get("weekly"),
    };
  }
  if (windowKey === "monthly") {
    return { kind: "monthly", labelSuffix: "Monthly", windowDurationMins: undefined };
  }
  return {
    kind: "other",
    labelSuffix: bucket.name?.trim() || "Quota",
    windowDurationMins: undefined,
  };
}

function parseResetTime(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const parsed = DateTime.make(raw);
  // Antigravity emits Unix epoch zero (1970-01-01T00:00:00Z) for untouched 100% buckets.
  if (Option.isNone(parsed) || DateTime.toEpochMillis(parsed.value) <= 0) return undefined;
  return DateTime.formatIso(parsed.value);
}

export type ParsedAntigravityCliUsage =
  | { readonly kind: "ok"; readonly limits: ServerProviderUsageLimits }
  | { readonly kind: "unauthenticated" }
  | { readonly kind: "failed"; readonly message: string };

export function parseAntigravityCliUsageOutput(input: {
  readonly stdout: string;
  readonly stderr: string;
  readonly checkedAt: string;
  readonly credentialFingerprint?: string | undefined;
}): ParsedAntigravityCliUsage {
  const decoded = decodeUsageResponseFromOutput(input.stdout);
  if (Option.isNone(decoded)) {
    if (isAntigravityCliAuthPrompt(input.stdout) || isAntigravityCliAuthPrompt(input.stderr)) {
      return { kind: "unauthenticated" };
    }
    return { kind: "failed", message: "Could not read Antigravity usage from the CLI." };
  }

  const response = decoded.value;
  if (response.status !== "SUCCESS") {
    const err = response.error ?? "";
    if (isAntigravityCliAuthPrompt(err) || isAntigravityCliAuthPrompt(input.stderr)) {
      return { kind: "unauthenticated" };
    }
    return {
      kind: "failed",
      message: err.trim() || "Antigravity CLI did not return usage limits.",
    };
  }

  const data = response.command?.data;
  if (!data) {
    return { kind: "failed", message: "Antigravity CLI returned no usage data." };
  }

  const windowsById = new Map<string, ServerProviderUsageWindow>();
  const addBucket = (groupName: string | undefined, bucket: typeof AgyUsageBucket.Type) => {
    if (bucket.disabled === true) return;
    const id = bucket.id?.trim();
    if (!id) return;
    const remaining = bucket.remaining_fraction;
    if (remaining === undefined || !Number.isFinite(remaining)) return;
    const meta = resolveWindowMeta(bucket, id);
    const resetsAt = parseResetTime(bucket.reset_time);
    const groupLabel = formatGroupLabel(groupName, id);
    const next: ServerProviderUsageWindow = {
      id,
      kind: meta.kind,
      label: `${groupLabel} · ${meta.labelSuffix}`,
      usedPercent: clampPercent(
        Math.round((1 - Math.max(0, Math.min(1, remaining))) * 10_000) / 100,
      ),
      ...(resetsAt !== undefined ? { resetsAt } : {}),
      ...(meta.windowDurationMins !== undefined
        ? { windowDurationMins: meta.windowDurationMins }
        : {}),
    };
    const previous = windowsById.get(id);
    if (!previous || next.usedPercent > previous.usedPercent) {
      windowsById.set(id, next);
    }
  };

  for (const group of data.groups ?? []) {
    const groupName = group.name ?? group.displayName;
    for (const bucket of group.buckets ?? []) {
      addBucket(groupName, bucket);
    }
  }
  for (const bucket of data.buckets ?? []) {
    addBucket(undefined, bucket);
  }

  if (windowsById.size === 0) {
    return { kind: "failed", message: "Antigravity CLI returned no usage buckets." };
  }

  const limits: ServerProviderUsageLimits = {
    ...makeUsageLimits({ checkedAt: input.checkedAt, windows: windowsById.values() }),
    ...(input.credentialFingerprint !== undefined
      ? { credentialFingerprint: input.credentialFingerprint }
      : {}),
  };
  return { kind: "ok", limits };
}

export interface AntigravityCliUsageCache {
  readonly entries: Map<
    string,
    {
      readonly limits: ServerProviderUsageLimits;
      readonly recordedAtMs: number;
    }
  >;
  readonly inFlight: Map<string, Deferred.Deferred<ServerProviderUsageLimits | undefined>>;
}

export function makeAntigravityCliUsageCache(): AntigravityCliUsageCache {
  return {
    entries: new Map(),
    inFlight: new Map(),
  };
}

// Scoped to the runtime's service handle so same-runtime instances share a cache without
// adding a fork-only service to upstream AntigravityDriverEnv or leaking across tests/restarts.
const sharedCachesByRuntime = new WeakMap<object, AntigravityCliUsageCache>();

export function getSharedAntigravityCliUsageCache(runtimeHandle: object): AntigravityCliUsageCache {
  const existing = sharedCachesByRuntime.get(runtimeHandle);
  if (existing !== undefined) return existing;
  const created = makeAntigravityCliUsageCache();
  sharedCachesByRuntime.set(runtimeHandle, created);
  return created;
}

export function resolveAntigravityCliUsageTokenPath(
  path: Path.Path,
  isolatedHomeDirectory: string,
): string {
  return path.join(isolatedHomeDirectory, ".gemini", "antigravity-cli", "antigravity-oauth-token");
}

const CLI_HOME_FILES = [
  "antigravity-oauth-token",
  "acp_token.json",
  "installation_id",
  "settings.json",
] as const;

const STRIPPED_CLI_ENV_KEYS = new Set([
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "GEMINI_HOME",
]);

export interface AntigravityCliUsageProbe {
  readonly probe: (options?: {
    readonly force?: boolean;
  }) => Effect.Effect<ServerProviderUsageLimits | undefined>;
  readonly clearAccount: Effect.Effect<void>;
  readonly clearBackoff: Effect.Effect<void>;
}

function appendBounded(current: string, chunk: string): string {
  if (current.length >= MAX_CLI_OUTPUT_BYTES) return current;
  return current.length + chunk.length <= MAX_CLI_OUTPUT_BYTES
    ? current + chunk
    : current + chunk.slice(0, MAX_CLI_OUTPUT_BYTES - current.length);
}

export const makeAntigravityCliUsageProbe = Effect.fn("makeAntigravityCliUsageProbe")(function* <
  E = never,
>(input: {
  readonly profileDirectory: string;
  readonly authMethod: AntigravitySettings["authMethod"];
  readonly readAccountEmail: Effect.Effect<string | undefined>;
  readonly prepareIsolatedSpawn: (cwd: string) => Effect.Effect<
    {
      readonly spawn: Pick<AcpSessionRuntime.AcpSpawnInput, "command" | "env">;
      readonly isolatedProfileDirectory: string;
      readonly isolatedHomeDirectory?: string | undefined;
      readonly onAfterExit?: Effect.Effect<void> | undefined;
    },
    E,
    Scope.Scope
  >;
  readonly cache?: AntigravityCliUsageCache;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const digest = yield* Digest.Digest;
  const cache = input.cache ?? makeAntigravityCliUsageCache();
  const ownedKeys = new Set<string>();
  const cliTokenPath = path.join(
    input.profileDirectory,
    "antigravity-acp",
    "antigravity-oauth-token",
  );
  const legacyTokenPath = path.join(input.profileDirectory, "antigravity-acp", "acp_token.json");

  const accountKeyAndFingerprint = Effect.gen(function* () {
    const email = yield* input.readAccountEmail;
    if (!email) {
      return {
        key: `${input.authMethod}:profile:${input.profileDirectory}`,
        credentialFingerprint: undefined,
      } as const;
    }
    const hash = Hex.encode(
      yield* digest.digest(Digest.sha256, new TextEncoder().encode(email.trim().toLowerCase())),
    );
    const credentialFingerprint = `email:${hash}`;
    return { key: `${input.authMethod}:${credentialFingerprint}`, credentialFingerprint } as const;
  });

  const hasSavedToken = Effect.gen(function* () {
    if (yield* fs.exists(cliTokenPath).pipe(Effect.orElseSucceed(() => false))) return true;
    return yield* fs.exists(legacyTokenPath).pipe(Effect.orElseSucceed(() => false));
  });

  const seedIsolatedCliHome = Effect.fnUntraced(function* (
    isolatedHome: string,
    isolatedProfileDirectory: string,
  ) {
    // `antigravity -p /usage` runs in CLI mode, which ignores GEMINI_HOME and --app-data-dir and
    // always resolves its app data dir at <os.UserHomeDir()>/.gemini/antigravity-cli.
    const geminiDir = path.join(isolatedHome, ".gemini");
    const cliDir = path.join(geminiDir, "antigravity-cli");
    const posix = path.sep !== "\\";
    yield* fs.makeDirectory(cliDir, { recursive: true, mode: 0o700 });
    if (posix) {
      yield* fs.chmod(geminiDir, 0o700).pipe(Effect.ignore);
      yield* fs.chmod(cliDir, 0o700).pipe(Effect.ignore);
    }
    const sourceDirs = [
      path.join(isolatedProfileDirectory, "antigravity-acp"),
      path.join(input.profileDirectory, "antigravity-acp"),
    ];
    for (const fileName of CLI_HOME_FILES) {
      let data: Uint8Array | undefined;
      for (const sourceDir of sourceDirs) {
        data = yield* fs
          .readFile(path.join(sourceDir, fileName))
          .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.undefined));
        if (data !== undefined) break;
      }
      if (data === undefined) continue;
      const targetPath = path.join(cliDir, fileName);
      yield* fs.writeFile(targetPath, data);
      if (posix) {
        yield* fs.chmod(targetPath, 0o600).pipe(Effect.ignore);
      }
    }
    return geminiDir;
  });

  const runCliOnce = (credentialFingerprint: string | undefined) =>
    Effect.scoped(
      Effect.gen(function* () {
        const checkedAt = DateTime.formatIso(yield* DateTime.now);
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-antigravity-usage-" });
        const prepared = yield* input.prepareIsolatedSpawn(cwd).pipe(Effect.option);
        if (Option.isNone(prepared)) {
          return makeUnavailableUsageLimits({
            checkedAt,
            reason: "probeFailed",
            message: "Could not start the Antigravity CLI to read usage limits.",
          });
        }
        const { spawn, isolatedProfileDirectory, isolatedHomeDirectory, onAfterExit } =
          prepared.value;
        // LIFO finalizer runs after the child process exits and before the isolated profile is deleted.
        if (onAfterExit) {
          yield* Effect.addFinalizer(() => onAfterExit.pipe(Effect.ignore));
        }

        const isolatedHome = isolatedHomeDirectory ?? isolatedProfileDirectory;
        const isolatedGeminiDir = yield* seedIsolatedCliHome(
          isolatedHome,
          isolatedProfileDirectory,
        );

        const headlessEnv: Record<string, string | undefined> = {};
        for (const [key, value] of Object.entries(spawn.env ?? {})) {
          if (!STRIPPED_CLI_ENV_KEYS.has(key.toUpperCase())) {
            headlessEnv[key] = value;
          }
        }
        const child = yield* spawner.spawn(
          ChildProcess.make(
            spawn.command,
            [
              "-p",
              "/usage",
              "--output-format",
              "json",
              "--print-timeout",
              ANTIGRAVITY_CLI_PRINT_TIMEOUT,
            ],
            {
              cwd,
              env: {
                ...headlessEnv,
                HOME: isolatedHome,
                ...(path.sep === "\\" ? { USERPROFILE: isolatedHome } : {}),
                GEMINI_HOME: isolatedGeminiDir,
                AGY_ACP_FORCE_FILE_STORAGE: "1",
                AGY_CLI_DISABLE_AUTO_UPDATE: "true",
                AGENT_BOARD_HOOKS: "off",
                SSH_CONNECTION: "127.0.0.1 1 127.0.0.1 22",
              },
              extendEnv: false,
              shell: false,
              stdin: "ignore",
            },
          ),
        );

        let stdout = "";
        let stderr = "";
        const authPromptSeen = yield* Deferred.make<void>();

        const drainStdout = child.stdout.pipe(
          Stream.decodeText(),
          Stream.runForEach((chunk) =>
            Effect.suspend(() => {
              stdout = appendBounded(stdout, chunk);
              return isAntigravityCliAuthPrompt(stdout)
                ? Deferred.succeed(authPromptSeen, undefined).pipe(Effect.asVoid)
                : Effect.void;
            }),
          ),
          Effect.ignore,
        );
        const drainStderr = child.stderr.pipe(
          Stream.decodeText(),
          Stream.runForEach((chunk) =>
            Effect.suspend(() => {
              stderr = appendBounded(stderr, chunk);
              return isAntigravityCliAuthPrompt(stderr)
                ? Deferred.succeed(authPromptSeen, undefined).pipe(Effect.asVoid)
                : Effect.void;
            }),
          ),
          Effect.ignore,
        );

        const completed = yield* Effect.all([drainStdout, drainStderr, child.exitCode], {
          concurrency: "unbounded",
        }).pipe(
          Effect.as("exited" as const),
          Effect.raceFirst(Deferred.await(authPromptSeen).pipe(Effect.as("authPrompt" as const))),
        );

        if (completed === "authPrompt") {
          return makeUnavailableUsageLimits({
            checkedAt,
            reason: "probeFailed",
            message: "Antigravity's saved sign-in needs to be renewed.",
          });
        }

        const parsed = parseAntigravityCliUsageOutput({
          stdout,
          stderr,
          checkedAt,
          credentialFingerprint,
        });
        if (parsed.kind === "ok") return parsed.limits;
        if (parsed.kind === "unauthenticated") {
          return makeUnavailableUsageLimits({
            checkedAt,
            reason: "probeFailed",
            message: "Antigravity's saved sign-in needs to be renewed.",
          });
        }
        return makeUnavailableUsageLimits({
          checkedAt,
          reason: "probeFailed",
          message: parsed.message,
        });
      }),
    ).pipe(
      Effect.timeoutOption(ANTIGRAVITY_CLI_OUTER_TIMEOUT),
      Effect.flatMap((result) =>
        Option.isSome(result)
          ? Effect.succeed(result.value)
          : Effect.map(DateTime.now, (now) =>
              makeUnavailableUsageLimits({
                checkedAt: DateTime.formatIso(now),
                reason: "probeFailed",
                message: "Reading Antigravity usage from the CLI timed out.",
              }),
            ),
      ),
      Effect.catch(() =>
        Effect.map(DateTime.now, (now) =>
          makeUnavailableUsageLimits({
            checkedAt: DateTime.formatIso(now),
            reason: "probeFailed",
            message: "Could not read Antigravity usage from the CLI.",
          }),
        ),
      ),
    );

  const probe: AntigravityCliUsageProbe["probe"] = Effect.fn("AntigravityCliUsageProbe.probe")(
    function* (options) {
      if (input.authMethod !== "oauth-personal" && input.authMethod !== "oauth-business") {
        return makeUnavailableUsageLimits({
          checkedAt: DateTime.formatIso(yield* DateTime.now),
          reason: "unsupported",
        });
      }
      if (!(yield* hasSavedToken)) return undefined;

      const { key, credentialFingerprint } = yield* accountKeyAndFingerprint;
      ownedKeys.add(key);
      const force = options?.force === true;

      while (true) {
        if (!force) {
          const now = yield* Clock.currentTimeMillis;
          const cached = cache.entries.get(key);
          if (cached !== undefined) {
            const ttl =
              cached.limits.unavailable?.reason === "probeFailed"
                ? USAGE_FAILURE_BACKOFF_MS
                : USAGE_FRESH_MS;
            if (now - cached.recordedAtMs < ttl) {
              return cached.limits;
            }
          }
          const existing = cache.inFlight.get(key);
          if (existing !== undefined) {
            const awaited = yield* Deferred.await(existing);
            if (awaited !== undefined) return awaited;
            // Owner probe was interrupted before finishing; re-check cache or run a fresh probe.
            continue;
          }
        }

        const pending = yield* Deferred.make<ServerProviderUsageLimits | undefined>();
        cache.inFlight.set(key, pending);
        if (force) cache.entries.delete(key);

        let result: ServerProviderUsageLimits | undefined;
        return yield* runCliOnce(credentialFingerprint).pipe(
          Effect.tap((limits) =>
            Effect.gen(function* () {
              result = limits;
              const recordedAtMs = yield* Clock.currentTimeMillis;
              cache.entries.set(key, { limits, recordedAtMs });
            }),
          ),
          Effect.ensuring(
            Effect.suspend(() => {
              if (cache.inFlight.get(key) === pending) {
                cache.inFlight.delete(key);
              }
              return Deferred.succeed(pending, result).pipe(Effect.asVoid);
            }),
          ),
        );
      }
    },
  );

  const clearAccount = Effect.gen(function* () {
    const { key } = yield* accountKeyAndFingerprint;
    cache.entries.delete(key);
    for (const ownedKey of ownedKeys) {
      cache.entries.delete(ownedKey);
    }
    ownedKeys.clear();
  });

  const clearBackoff = Effect.gen(function* () {
    const { key } = yield* accountKeyAndFingerprint;
    const keys = new Set(ownedKeys);
    keys.add(key);
    for (const candidate of keys) {
      const cached = cache.entries.get(candidate);
      if (cached?.limits.unavailable?.reason === "probeFailed") {
        cache.entries.delete(candidate);
      }
    }
  });

  return { probe, clearAccount, clearBackoff } satisfies AntigravityCliUsageProbe;
});

interface WrappableAntigravityProvider {
  readonly snapshot: ManagedServerProvider;
  readonly onSessionStarted: (
    started: AcpSessionRuntime.AcpSessionRuntimeStartResult,
    cwd?: string,
    session?: { readonly resumed?: boolean },
  ) => Effect.Effect<void>;
  readonly onSignedOut: Effect.Effect<void>;
  readonly onAuthRequired: Effect.Effect<void>;
  readonly snapshotForCwd: (
    cwd: string,
    skills?: ServerProvider["skills"],
  ) => Effect.Effect<ServerProvider>;
}

/**
 * Decorates `AntigravityProvider` with CLI-based usage limits without editing `AntigravityProvider.ts`.
 * Automatically yields whenever the base snapshot already supplies native `usageLimits`, so any future
 * upstream re-addition takes precedence with zero conflict.
 */
export const attachAntigravityCliUsageLimits = Effect.fn("attachAntigravityCliUsageLimits")(
  function* <P extends WrappableAntigravityProvider>(input: {
    readonly provider: P;
    readonly usage: AntigravityCliUsageProbe;
    readonly enabled: boolean;
    readonly shouldRunBackgroundWork: Effect.Effect<boolean>;
  }): Effect.fn.Return<P & { readonly onTokenRefreshed: Effect.Effect<void> }, never, Scope.Scope> {
    const overlayRef = yield* Ref.make<ServerProviderUsageLimits | undefined>(undefined);
    const lastPublishedRef = yield* Ref.make<ServerProvider | undefined>(undefined);
    const changesPubSub = yield* Effect.acquireRelease(
      PubSub.unbounded<ServerProvider>(),
      PubSub.shutdown,
    );
    const usageRead = yield* FiberHandle.make<void, never>();
    let accountEpoch = 0;

    const mergeUsage = <S extends ServerProvider>(
      base: S,
      cached: ServerProviderUsageLimits | undefined,
    ): S => {
      if (base.usageLimits !== undefined) return base;
      if (cached === undefined) return base;
      if (base.auth.status === "unauthenticated" && cached.unavailable?.reason !== "unsupported") {
        return base;
      }
      return { ...base, usageLimits: cached };
    };

    const publishMerged = Effect.fnUntraced(function* (base: ServerProvider) {
      const cached = yield* Ref.get(overlayRef);
      const merged = mergeUsage(base, cached);
      const changed = yield* Ref.modify(lastPublishedRef, (previous) =>
        previous !== undefined && Equal.equals(previous, merged)
          ? ([false, previous] as const)
          : ([true, merged] as const),
      );
      if (changed) {
        yield* PubSub.publish(changesPubSub, merged);
      }
    });

    const isStale = Effect.fnUntraced(function* (limits: ServerProviderUsageLimits | undefined) {
      if (!limits || limits.unavailable) return true;
      const checked = Date.parse(limits.checkedAt);
      if (!Number.isFinite(checked)) return true;
      return (yield* Clock.currentTimeMillis) - checked >= USAGE_FRESH_MS;
    });

    const runProbe = Effect.fn("AntigravityCliUsageLimits.runProbe")(function* (force: boolean) {
      if (!input.enabled) return;
      const base = yield* input.provider.snapshot.getSnapshot;
      if (
        base.usageLimits !== undefined ||
        !base.enabled ||
        !base.installed ||
        base.status === "error" ||
        base.auth.status === "unauthenticated"
      ) {
        return;
      }
      const startedEpoch = accountEpoch;
      const probed = yield* input.usage.probe({ force });
      if (probed === undefined || startedEpoch !== accountEpoch) return;
      const latestBase = yield* input.provider.snapshot.getSnapshot;
      if (latestBase.usageLimits !== undefined) return;
      if (
        latestBase.auth.status === "unauthenticated" &&
        probed.unavailable?.reason !== "unsupported"
      ) {
        return;
      }
      yield* Ref.update(overlayRef, (published) =>
        resolveUsageLimitsAfterProbe({ published, probed }),
      );
      yield* publishMerged(latestBase);
    });

    const triggerBackgroundProbe = Effect.fnUntraced(function* () {
      if (!input.enabled || !(yield* input.shouldRunBackgroundWork)) return false;
      yield* FiberHandle.run(usageRead, runProbe(false), {
        onlyIfMissing: true,
        startImmediately: false,
      });
      return true;
    });

    const resetOverlay = Effect.gen(function* () {
      accountEpoch += 1;
      yield* FiberHandle.clear(usageRead);
      const hadOverlay = (yield* Ref.getAndSet(overlayRef, undefined)) !== undefined;
      yield* input.usage.clearAccount;
      if (hadOverlay) {
        yield* publishMerged(yield* input.provider.snapshot.getSnapshot);
      }
    });

    // Run once after startup readiness (never on periodic 1-minute checks) and reset on sign-out/account switch.
    let bootProbed = false;
    let lastEmail: string | undefined;
    const reconcileAccount = Effect.fn("AntigravityCliUsageLimits.reconcileAccount")(function* (
      snap: ServerProvider,
      options?: { readonly markBootProbed?: boolean },
    ) {
      const email = snap.auth.email?.trim().toLowerCase();
      if (snap.auth.status === "unauthenticated") {
        lastEmail = undefined;
        bootProbed = false;
        yield* resetOverlay;
        return "unauthenticated" as const;
      }
      if (lastEmail !== undefined && email !== undefined && email !== lastEmail) {
        lastEmail = email;
        bootProbed = options?.markBootProbed === true;
        yield* resetOverlay;
        return "switched" as const;
      }
      if (email !== undefined) lastEmail = email;
      if (options?.markBootProbed === true) bootProbed = true;
      return "unchanged" as const;
    });

    const handleSnapshot = Effect.fn("AntigravityCliUsageLimits.handleSnapshot")(function* (
      snap: ServerProvider,
      publish: boolean,
    ) {
      const accountState = yield* reconcileAccount(snap);
      if (publish) yield* publishMerged(snap);
      if (accountState === "unauthenticated") return;
      if (
        !bootProbed &&
        snap.enabled &&
        snap.installed &&
        snap.status !== "error" &&
        snap.usageLimits === undefined
      ) {
        if (yield* triggerBackgroundProbe()) {
          bootProbed = true;
        }
      }
    });

    // Subscribe before reading the initial snapshot so PubSub never drops a concurrent startup check.
    yield* input.provider.snapshot.streamChanges.pipe(
      Stream.runForEach((snap) => handleSnapshot(snap, true)),
      Effect.ignoreCause({ log: true }),
      Effect.forkScoped({ startImmediately: true }),
    );
    yield* input.provider.snapshot.getSnapshot.pipe(
      Effect.flatMap((snap) => handleSnapshot(snap, false)),
      Effect.ignoreCause({ log: true }),
    );

    const getSnapshot = Effect.gen(function* () {
      const [base, cached] = yield* Effect.all([
        input.provider.snapshot.getSnapshot,
        Ref.get(overlayRef),
      ]);
      return mergeUsage(base, cached);
    });

    const refresh = Effect.fn("AntigravityCliUsageLimits.refresh")(function* () {
      yield* input.usage.clearBackoff;
      const refreshed = yield* input.provider.snapshot.refresh;
      yield* reconcileAccount(refreshed, { markBootProbed: true });
      if (refreshed.usageLimits !== undefined) return refreshed;
      if (
        refreshed.enabled &&
        refreshed.installed &&
        refreshed.status !== "error" &&
        refreshed.auth.status !== "unauthenticated"
      ) {
        // Clear waits for any interrupted background probe's finalizers before starting the forced probe.
        yield* FiberHandle.clear(usageRead);
        yield* FiberHandle.run(usageRead, runProbe(true), {
          onlyIfMissing: false,
          startImmediately: true,
        });
        yield* FiberHandle.awaitEmpty(usageRead);
      }
      return mergeUsage(refreshed, yield* Ref.get(overlayRef));
    });

    const refreshUsage = Effect.fn("AntigravityCliUsageLimits.refreshUsage")(function* () {
      const base = yield* input.provider.snapshot.getSnapshot;
      yield* reconcileAccount(base, { markBootProbed: true });
      if (base.usageLimits !== undefined) {
        if (input.provider.snapshot.refreshUsage) {
          yield* input.provider.snapshot.refreshUsage;
        }
        return;
      }
      yield* input.usage.clearBackoff;
      if (
        base.enabled &&
        base.installed &&
        base.status !== "error" &&
        base.auth.status !== "unauthenticated"
      ) {
        yield* FiberHandle.clear(usageRead);
        yield* FiberHandle.run(usageRead, runProbe(true), {
          onlyIfMissing: false,
          startImmediately: true,
        });
        yield* FiberHandle.awaitEmpty(usageRead);
      }
    });

    const onSessionStarted: P["onSessionStarted"] = Effect.fn(
      "AntigravityCliUsageLimits.onSessionStarted",
    )(function* (started, cwd, session) {
      yield* input.provider.onSessionStarted(started, cwd, session);
      yield* input.usage.clearBackoff;
      const current = yield* Ref.get(overlayRef);
      if (yield* isStale(current)) {
        yield* triggerBackgroundProbe();
      }
    });

    const onTokenRefreshed = Effect.gen(function* () {
      if (!input.enabled) return;
      yield* input.usage.clearBackoff;
      const current = yield* Ref.get(overlayRef);
      if (yield* isStale(current)) {
        yield* triggerBackgroundProbe();
      }
    });

    const snapshotForCwd = Effect.fn("AntigravityCliUsageLimits.snapshotForCwd")(function* (
      cwd: string,
      skills?: ServerProvider["skills"],
    ) {
      const [base, cached] = yield* Effect.all([
        input.provider.snapshotForCwd(cwd, skills),
        Ref.get(overlayRef),
      ]);
      return mergeUsage(base, cached);
    });

    return {
      ...input.provider,
      snapshot: {
        ...input.provider.snapshot,
        getSnapshot,
        get streamChanges() {
          return Stream.fromPubSub(changesPubSub);
        },
        refresh: refresh(),
        refreshUsage: refreshUsage(),
      },
      onSessionStarted,
      onSignedOut: resetOverlay.pipe(Effect.andThen(input.provider.onSignedOut)),
      onAuthRequired: resetOverlay.pipe(Effect.andThen(input.provider.onAuthRequired)),
      snapshotForCwd,
      onTokenRefreshed,
    };
  },
);
