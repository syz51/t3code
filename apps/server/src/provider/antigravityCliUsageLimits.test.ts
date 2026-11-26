import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageLimits,
} from "@t3tools/contracts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "@t3tools/provider-core/server/maintenanceResolver";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import {
  attachAntigravityCliUsageLimits,
  getSharedAntigravityCliUsageCache,
  isAntigravityCliAuthPrompt,
  makeAntigravityCliUsageCache,
  makeAntigravityCliUsageProbe,
  parseAntigravityCliUsageOutput,
  resolveAntigravityCliUsageTokenPath,
  type AntigravityCliUsageProbe,
} from "./antigravityCliUsageLimits.ts";

const windowsHost = HostProcess.Platform.defaultValue() === "win32";

const LIVE_SHAPE_USAGE_JSON = JSON.stringify({
  status: "SUCCESS",
  num_turns: 0,
  usage: { total_tokens: 0 },
  command: {
    name: "usage",
    data: {
      groups: [
        {
          name: "Gemini Models",
          buckets: [
            {
              id: "gemini-weekly",
              name: "Weekly",
              window: "weekly",
              remaining_fraction: 0.72,
              reset_time: "2026-12-01T00:00:00Z",
            },
            {
              id: "gemini-5h",
              name: "5h",
              window: "5h",
              remaining_fraction: 0.25,
              reset_time: "2026-11-26T15:00:00Z",
            },
          ],
        },
        {
          name: "Claude and GPT models",
          buckets: [
            {
              id: "3p-weekly",
              name: "Weekly",
              window: "weekly",
              remaining_fraction: 1,
              reset_time: "1970-01-01T00:00:00Z",
            },
            {
              id: "3p-5h",
              name: "5h",
              window: "5h",
              remaining_fraction: 0.6,
              reset_time: "2026-11-26T14:00:00Z",
            },
          ],
        },
      ],
    },
  },
});

function makeBaseSnapshot(overrides: Partial<ServerProvider> = {}): ServerProvider {
  return {
    driver: ProviderDriverKind.make("antigravity"),
    instanceId: ProviderInstanceId.make("antigravity-test"),
    displayName: "Google Antigravity",
    enabled: true,
    installed: true,
    version: "1.5.12",
    status: "ready",
    auth: { status: "authenticated", type: "oauth-personal", email: "user@example.com" },
    checkedAt: "2026-11-26T10:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    supportsTextGeneration: true,
    ...overrides,
  };
}

const makeFakeProvider = Effect.fn("makeFakeProvider")(function* (initial: ServerProvider) {
  const snapRef = yield* Ref.make(initial);
  const pubsub = yield* Effect.acquireRelease(PubSub.unbounded<ServerProvider>(), PubSub.shutdown);
  const refreshCount = yield* Ref.make(0);
  const refreshUsageCount = yield* Ref.make(0);
  const signedOutCount = yield* Ref.make(0);
  const authRequiredCount = yield* Ref.make(0);

  const publish = (next: ServerProvider) =>
    Ref.set(snapRef, next).pipe(Effect.andThen(PubSub.publish(pubsub, next)), Effect.asVoid);

  const maintenance = makeManualOnlyProviderMaintenanceCapabilities({
    provider: ProviderDriverKind.make("antigravity"),
    packageName: null,
  });

  const provider = {
    snapshot: {
      resolveMaintenance: () => Effect.succeed(maintenance),
      getSnapshot: Ref.get(snapRef),
      isAwaitingFirstCheck: Effect.succeed(false),
      refresh: Ref.update(refreshCount, (n) => n + 1).pipe(Effect.andThen(Ref.get(snapRef))),
      applyUsageLimits: () => Effect.void,
      refreshUsage: Ref.update(refreshUsageCount, (n) => n + 1),
      get streamChanges() {
        return Stream.fromPubSub(pubsub);
      },
    },
    onSessionStarted: () => Effect.void,
    onSignedOut: Ref.update(signedOutCount, (n) => n + 1),
    onAuthRequired: Ref.update(authRequiredCount, (n) => n + 1),
    snapshotForCwd: (_cwd: string) => Ref.get(snapRef),
  };

  return {
    provider,
    publish,
    refreshCount,
    refreshUsageCount,
    signedOutCount,
    authRequiredCount,
  };
});

describe("parseAntigravityCliUsageOutput", () => {
  it("parses live-shape groups and omits epoch-zero reset times", () => {
    const parsed = parseAntigravityCliUsageOutput({
      stdout: LIVE_SHAPE_USAGE_JSON,
      stderr: "",
      checkedAt: "2026-11-26T10:00:00.000Z",
      credentialFingerprint: "email:abc123",
    });

    expect(parsed.kind).toBe("ok");
    if (parsed.kind !== "ok") return;
    expect(parsed.limits.credentialFingerprint).toBe("email:abc123");
    expect(parsed.limits.windows).toEqual([
      {
        id: "3p-5h",
        kind: "session",
        label: "Claude & GPT (shared) · 5-hour",
        usedPercent: 40,
        resetsAt: "2026-11-26T14:00:00.000Z",
        windowDurationMins: 300,
      },
      {
        id: "gemini-5h",
        kind: "session",
        label: "Gemini · 5-hour",
        usedPercent: 75,
        resetsAt: "2026-11-26T15:00:00.000Z",
        windowDurationMins: 300,
      },
      {
        id: "3p-weekly",
        kind: "weekly",
        label: "Claude & GPT (shared) · Weekly",
        usedPercent: 0,
        windowDurationMins: 10080,
      },
      {
        id: "gemini-weekly",
        kind: "weekly",
        label: "Gemini · Weekly",
        usedPercent: 28,
        resetsAt: "2026-12-01T00:00:00.000Z",
        windowDurationMins: 10080,
      },
    ]);
  });

  it("extracts JSON surrounded by leading and trailing CLI notice lines", () => {
    const wrapped = [
      '{"event":"startup","ok":true}',
      "Notice: Checking quota...",
      JSON.stringify(JSON.parse(LIVE_SHAPE_USAGE_JSON), null, 2),
      "Done.",
    ].join("\n");
    const parsed = parseAntigravityCliUsageOutput({
      stdout: wrapped,
      stderr: "",
      checkedAt: "2026-11-26T10:00:00.000Z",
    });
    expect(parsed.kind).toBe("ok");
    if (parsed.kind !== "ok") return;
    expect(parsed.limits.windows).toHaveLength(4);
  });

  it("skips disabled buckets, clamps remaining_fraction, and keeps higher usedPercent on duplicates", () => {
    const payload = JSON.stringify({
      status: "SUCCESS",
      command: {
        data: {
          buckets: [
            { id: "gemini-5h", remaining_fraction: -0.5 },
            { id: "gemini-5h", remaining_fraction: 0.9 },
            { id: "gemini-weekly", remaining_fraction: 1.5 },
            { id: "3p-5h", remaining_fraction: 0.1, disabled: true },
          ],
        },
      },
    });
    const parsed = parseAntigravityCliUsageOutput({
      stdout: payload,
      stderr: "",
      checkedAt: "2026-11-26T10:00:00.000Z",
    });
    expect(parsed.kind).toBe("ok");
    if (parsed.kind !== "ok") return;
    expect(parsed.limits.windows.map((w) => [w.id, w.usedPercent])).toEqual([
      ["gemini-5h", 100],
      ["gemini-weekly", 0],
    ]);
  });

  it("detects unauthenticated prompts and failed outputs", () => {
    const authPrompt =
      "Authentication required. Please visit the URL to log in:\n  https://accounts.google.com/o/oauth2/auth?client_id=1";
    expect(isAntigravityCliAuthPrompt(authPrompt)).toBe(true);
    expect(
      parseAntigravityCliUsageOutput({
        stdout: authPrompt,
        stderr: "",
        checkedAt: "2026-11-26T10:00:00.000Z",
      }),
    ).toEqual({ kind: "unauthenticated" });

    expect(
      parseAntigravityCliUsageOutput({
        stdout: JSON.stringify({ status: "ERROR", error: "Temporary quota error" }),
        stderr: "",
        checkedAt: "2026-11-26T10:00:00.000Z",
      }),
    ).toEqual({ kind: "failed", message: "Temporary quota error" });

    expect(
      parseAntigravityCliUsageOutput({
        stdout: "not json",
        stderr: "",
        checkedAt: "2026-11-26T10:00:00.000Z",
      }).kind,
    ).toBe("failed");
  });
});

const nodeLayer = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer);

it.layer(nodeLayer)("makeAntigravityCliUsageProbe", (it) => {
  it.effect("returns unsupported for non-OAuth methods without spawning", () =>
    Effect.gen(function* () {
      let spawns = 0;
      const probe = yield* makeAntigravityCliUsageProbe({
        profileDirectory: "/nonexistent",
        authMethod: "gemini-api-key",
        readAccountEmail: Effect.undefined,
        prepareIsolatedSpawn: () =>
          Effect.sync(() => {
            spawns += 1;
            throw new Error("should not spawn");
          }),
      });
      const result = yield* probe.probe();
      expect(result?.unavailable?.reason).toBe("unsupported");
      expect(spawns).toBe(0);
    }),
  );

  it.effect("returns undefined without spawning when no local token file exists", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const profileDirectory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ag-notoken-" });
      let spawns = 0;
      const probe = yield* makeAntigravityCliUsageProbe({
        profileDirectory,
        authMethod: "oauth-personal",
        readAccountEmail: Effect.succeed("user@example.com"),
        prepareIsolatedSpawn: () =>
          Effect.sync(() => {
            spawns += 1;
            throw new Error("should not spawn");
          }),
      });
      expect(yield* probe.probe()).toBeUndefined();
      expect(spawns).toBe(0);
    }),
  );

  it.effect.skipIf(windowsHost)(
    "caches across instances sharing an email, deduplicates in-flight calls, and runs onAfterExit before isolated dir removal",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseEnv = yield* HostProcess.Environment;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ag-probe-" });
        const profileA = path.join(root, "profile-a");
        const profileB = path.join(root, "profile-b");
        for (const profile of [profileA, profileB]) {
          const acpDir = path.join(profile, "antigravity-acp");
          yield* fs.makeDirectory(acpDir, { recursive: true });
          yield* fs.writeFileString(path.join(acpDir, "antigravity-oauth-token"), "{}");
        }

        const scriptPath = path.join(root, "fake-agy.sh");
        yield* fs.writeFileString(
          scriptPath,
          [
            "#!/bin/sh",
            'if [ ! -f "$HOME/.gemini/antigravity-cli/antigravity-oauth-token" ]; then',
            '  echo "Authentication required. Please visit the URL to log in:"',
            "  exit 1",
            "fi",
            'printf "%s" "renewed" > "$HOME/.gemini/antigravity-cli/marker.txt"',
            `printf '%s\\n' '${LIVE_SHAPE_USAGE_JSON.replaceAll("'", `'\\''`)}'`,
            "",
          ].join("\n"),
        );
        yield* fs.chmod(scriptPath, 0o755);

        const cache = makeAntigravityCliUsageCache();
        let spawnCount = 0;
        let markerSeenOnAfterExit = false;
        let lastIsolatedDir: string | undefined;

        const makePrepare = (profile: string) => (_cwd: string) =>
          Effect.gen(function* () {
            spawnCount += 1;
            const isolatedProfileDirectory = yield* fs.makeTempDirectoryScoped({
              prefix: "t3-ag-iso-",
            });
            lastIsolatedDir = isolatedProfileDirectory;
            return {
              isolatedProfileDirectory,
              spawn: {
                command: scriptPath,
                env: {
                  PATH: baseEnv.PATH ?? "/usr/bin:/bin",
                  GEMINI_HOME: isolatedProfileDirectory,
                  DISPLAY: ":0",
                  WAYLAND_DISPLAY: "wayland-0",
                },
              },
              onAfterExit: Effect.gen(function* () {
                const exists = yield* fs.exists(
                  path.join(isolatedProfileDirectory, ".gemini", "antigravity-cli", "marker.txt"),
                );
                if (exists && profile === profileA) {
                  markerSeenOnAfterExit = true;
                }
              }).pipe(Effect.ignore),
            };
          });

        const probeA = yield* makeAntigravityCliUsageProbe({
          profileDirectory: profileA,
          authMethod: "oauth-personal",
          readAccountEmail: Effect.succeed("User@Example.com"),
          prepareIsolatedSpawn: makePrepare(profileA),
          cache,
        });
        const probeB = yield* makeAntigravityCliUsageProbe({
          profileDirectory: profileB,
          authMethod: "oauth-personal",
          readAccountEmail: Effect.succeed("user@example.com"),
          prepareIsolatedSpawn: makePrepare(profileB),
          cache,
        });

        // Concurrent calls across instances sharing an email deduplicate to one spawn.
        const [first, second] = yield* Effect.all([probeA.probe(), probeB.probe()], {
          concurrency: "unbounded",
        });
        expect(spawnCount).toBe(1);
        expect(markerSeenOnAfterExit).toBe(true);
        if (lastIsolatedDir) {
          expect(yield* fs.exists(lastIsolatedDir)).toBe(false);
        }
        expect(first?.windows).toHaveLength(4);
        expect(first?.credentialFingerprint).toMatch(/^email:[0-9a-f]{64}$/);
        expect(second).toEqual(first);

        // Cached within 5 minutes.
        yield* TestClock.adjust("4 minutes");
        expect(yield* probeB.probe()).toEqual(first);
        expect(spawnCount).toBe(1);

        // Concurrent force: true refreshes across same-account instances bypass cache but share one spawn.
        const [forcedA, forcedB] = yield* Effect.all(
          [probeA.probe({ force: true }), probeB.probe({ force: true })],
          { concurrency: "unbounded" },
        );
        expect(forcedB).toEqual(forcedA);
        expect(spawnCount).toBe(2);

        // Expires after 5 minutes.
        yield* TestClock.adjust("5 minutes");
        yield* probeB.probe();
        expect(spawnCount).toBe(3);
      }),
  );

  it.effect.skipIf(windowsHost)(
    "aborts early on interactive OAuth prompt and backs off failed probes until clearBackoff",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseEnv = yield* HostProcess.Environment;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ag-authprompt-" });
        const acpDir = path.join(root, "antigravity-acp");
        yield* fs.makeDirectory(acpDir, { recursive: true });
        yield* fs.writeFileString(path.join(acpDir, "antigravity-oauth-token"), "{}");

        const scriptPath = path.join(root, "hang-on-auth.sh");
        yield* fs.writeFileString(
          scriptPath,
          [
            "#!/bin/sh",
            'echo "Authentication required. Please visit the URL to log in:"',
            'echo "  https://accounts.google.com/o/oauth2/auth?client_id=test"',
            "sleep 60",
            "",
          ].join("\n"),
        );
        yield* fs.chmod(scriptPath, 0o755);

        let spawnCount = 0;
        const probe = yield* makeAntigravityCliUsageProbe({
          profileDirectory: root,
          authMethod: "oauth-personal",
          readAccountEmail: Effect.succeed("user@example.com"),
          prepareIsolatedSpawn: (_cwd) =>
            Effect.gen(function* () {
              spawnCount += 1;
              const isolatedProfileDirectory = yield* fs.makeTempDirectoryScoped({
                prefix: "t3-ag-iso-auth-",
              });
              return {
                isolatedProfileDirectory,
                spawn: {
                  command: scriptPath,
                  env: {
                    PATH: baseEnv.PATH ?? "/usr/bin:/bin",
                    GEMINI_HOME: isolatedProfileDirectory,
                  },
                },
              };
            }),
        });

        const first = yield* probe.probe();
        expect(first?.unavailable?.reason).toBe("probeFailed");
        expect(first?.unavailable?.message).toContain("renewed");
        expect(spawnCount).toBe(1);

        // Backed off within 5 minutes.
        const backedOff = yield* probe.probe();
        expect(backedOff?.unavailable?.reason).toBe("probeFailed");
        expect(spawnCount).toBe(1);

        // clearBackoff allows immediate retry.
        yield* probe.clearBackoff;
        yield* probe.probe();
        expect(spawnCount).toBe(2);
      }),
  );

  it.effect.skipIf(windowsHost)(
    "evicts cached email entry on clearAccount even after logout deletes the token file",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseEnv = yield* HostProcess.Environment;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ag-logout-" });
        const acpDir = path.join(root, "antigravity-acp");
        const tokenPath = path.join(acpDir, "antigravity-oauth-token");
        yield* fs.makeDirectory(acpDir, { recursive: true });
        yield* fs.writeFileString(tokenPath, "{}");

        const scriptPath = path.join(root, "ok-agy.sh");
        yield* fs.writeFileString(
          scriptPath,
          [
            "#!/bin/sh",
            `printf '%s\\n' '${LIVE_SHAPE_USAGE_JSON.replaceAll("'", `'\\''`)}'`,
            "",
          ].join("\n"),
        );
        yield* fs.chmod(scriptPath, 0o755);

        let tokenPresent = true;
        let spawnCount = 0;
        const probe = yield* makeAntigravityCliUsageProbe({
          profileDirectory: root,
          authMethod: "oauth-personal",
          readAccountEmail: Effect.sync(() => (tokenPresent ? "user@example.com" : undefined)),
          prepareIsolatedSpawn: (_cwd) =>
            Effect.gen(function* () {
              spawnCount += 1;
              const isolatedProfileDirectory = yield* fs.makeTempDirectoryScoped({
                prefix: "t3-ag-iso-logout-",
              });
              return {
                isolatedProfileDirectory,
                spawn: {
                  command: scriptPath,
                  env: {
                    PATH: baseEnv.PATH ?? "/usr/bin:/bin",
                    GEMINI_HOME: isolatedProfileDirectory,
                  },
                },
              };
            }),
        });

        expect((yield* probe.probe())?.windows).toHaveLength(4);
        expect(spawnCount).toBe(1);

        // Logout deletes the token file before calling clearAccount.
        tokenPresent = false;
        yield* fs.remove(tokenPath);
        yield* probe.clearAccount;

        // Re-signing into the same account immediately probes instead of returning stale cache.
        tokenPresent = true;
        yield* fs.writeFileString(tokenPath, "{}");
        expect((yield* probe.probe())?.windows).toHaveLength(4);
        expect(spawnCount).toBe(2);
      }),
  );

  it.effect.skipIf(windowsHost)(
    "seeds isolated HOME/.gemini/antigravity-cli from isolated ACP credentials and isolates HOME/XDG env",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseEnv = yield* HostProcess.Environment;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ag-clihome-" });
        const profileAcpDir = path.join(root, "profile", "antigravity-acp");
        yield* fs.makeDirectory(profileAcpDir, { recursive: true });
        yield* fs.writeFileString(
          path.join(profileAcpDir, "antigravity-oauth-token"),
          '{"token":{"access_token":"from-profile"}}',
        );
        yield* fs.writeFileString(path.join(profileAcpDir, "installation_id"), "install-uuid-1");

        const dumpPath = path.join(root, "dump.txt");
        const scriptPath = path.join(root, "inspect-agy.sh");
        yield* fs.writeFileString(
          scriptPath,
          [
            "#!/bin/sh",
            `{`,
            '  printf "HOME=%s\\n" "$HOME"',
            '  printf "GEMINI_HOME=%s\\n" "$GEMINI_HOME"',
            '  printf "XDG_CONFIG_HOME=%s\\n" "${XDG_CONFIG_HOME:-}"',
            '  printf "XDG_CACHE_HOME=%s\\n" "${XDG_CACHE_HOME:-}"',
            '  printf "XDG_DATA_HOME=%s\\n" "${XDG_DATA_HOME:-}"',
            '  printf "TOKEN=%s\\n" "$(cat "$HOME/.gemini/antigravity-cli/antigravity-oauth-token")"',
            '  printf "INSTALL=%s\\n" "$(cat "$HOME/.gemini/antigravity-cli/installation_id")"',
            '  printf "SETTINGS=%s\\n" "$(cat "$HOME/.gemini/antigravity-cli/settings.json")"',
            `} > ${JSON.stringify(dumpPath)}`,
            `printf '%s\\n' '${LIVE_SHAPE_USAGE_JSON.replaceAll("'", `'\\''`)}'`,
            "",
          ].join("\n"),
        );
        yield* fs.chmod(scriptPath, 0o755);

        let capturedHome = "";
        const probe = yield* makeAntigravityCliUsageProbe({
          profileDirectory: path.join(root, "profile"),
          authMethod: "oauth-personal",
          readAccountEmail: Effect.succeed("cli-home@example.com"),
          prepareIsolatedSpawn: () =>
            Effect.gen(function* () {
              const isolatedHomeDirectory = yield* fs.makeTempDirectoryScoped({
                prefix: "t3-ag-home-",
              });
              capturedHome = isolatedHomeDirectory;
              const isolatedProfileDirectory = path.join(isolatedHomeDirectory, ".gemini");
              const isolatedAcpDir = path.join(isolatedProfileDirectory, "antigravity-acp");
              yield* fs.makeDirectory(isolatedAcpDir, { recursive: true });
              yield* fs.writeFileString(
                path.join(isolatedAcpDir, "antigravity-oauth-token"),
                '{"token":{"access_token":"from-isolated"}}',
              );
              yield* fs.writeFileString(
                path.join(isolatedAcpDir, "settings.json"),
                '{"auth":{"type":"oauth-personal"}}',
              );
              expect(resolveAntigravityCliUsageTokenPath(path, isolatedHomeDirectory)).toBe(
                path.join(
                  isolatedHomeDirectory,
                  ".gemini",
                  "antigravity-cli",
                  "antigravity-oauth-token",
                ),
              );
              return {
                isolatedHomeDirectory,
                isolatedProfileDirectory,
                spawn: {
                  command: scriptPath,
                  env: {
                    PATH: baseEnv.PATH ?? "/usr/bin:/bin",
                    HOME: "/real/user/home",
                    GEMINI_HOME: "/wrong/gemini/home",
                    XDG_CONFIG_HOME: "/real/xdg/config",
                    XDG_CACHE_HOME: "/real/xdg/cache",
                    XDG_DATA_HOME: "/real/xdg/data",
                  },
                },
              };
            }),
        });

        const result = yield* probe.probe();
        expect(result?.windows).toHaveLength(4);
        const dump = yield* fs.readFileString(dumpPath);
        expect(dump).toContain(`HOME=${capturedHome}\n`);
        expect(dump).toContain(`GEMINI_HOME=${path.join(capturedHome, ".gemini")}\n`);
        expect(dump).toContain("XDG_CONFIG_HOME=\n");
        expect(dump).toContain("XDG_CACHE_HOME=\n");
        expect(dump).toContain("XDG_DATA_HOME=\n");
        expect(dump).toContain('TOKEN={"token":{"access_token":"from-isolated"}}\n');
        expect(dump).toContain("INSTALL=install-uuid-1\n");
        expect(dump).toContain('SETTINGS={"auth":{"type":"oauth-personal"}}\n');
      }),
  );

  it("shares cache instances per stateDir via getSharedAntigravityCliUsageCache", () => {
    const first = getSharedAntigravityCliUsageCache("/tmp/t3-cache-test-a");
    const second = getSharedAntigravityCliUsageCache("/tmp/t3-cache-test-a");
    const other = getSharedAntigravityCliUsageCache("/tmp/t3-cache-test-b");
    expect(second).toBe(first);
    expect(other).not.toBe(first);
  });
});

describe("attachAntigravityCliUsageLimits", () => {
  const waitForSnapshot = (
    stream: Stream.Stream<ServerProvider>,
    predicate: (snap: ServerProvider) => boolean,
  ) =>
    stream.pipe(
      Stream.filter(predicate),
      Stream.take(1),
      Stream.runHead,
      Effect.forkScoped({ startImmediately: true }),
    );

  it.effect(
    "probes once on startup readiness, skips periodic publishes, refreshes stale sessions, and clears on sign-out/email switch",
    () =>
      Effect.gen(function* () {
        const fake = yield* makeFakeProvider(makeBaseSnapshot());
        let probeCalls = 0;
        let clearedAccount = 0;
        let clearedBackoff = 0;
        const probeStarted = yield* Deferred.make<void>();
        const probeGate = yield* Deferred.make<void>();
        let nextLimits: ServerProviderUsageLimits = {
          checkedAt: "1970-01-01T00:00:00.000Z",
          windows: [
            {
              id: "gemini-5h",
              kind: "session",
              label: "Gemini · 5-hour",
              usedPercent: 30,
              windowDurationMins: 300,
            },
          ],
        };

        const usage: AntigravityCliUsageProbe = {
          probe: () =>
            Effect.gen(function* () {
              probeCalls += 1;
              yield* Deferred.succeed(probeStarted, undefined);
              yield* Deferred.await(probeGate);
              return nextLimits;
            }),
          clearAccount: Effect.sync(() => {
            clearedAccount += 1;
          }),
          clearBackoff: Effect.sync(() => {
            clearedBackoff += 1;
          }),
        };

        const wrapped = yield* attachAntigravityCliUsageLimits({
          provider: fake.provider,
          usage,
          enabled: true,
          shouldRunBackgroundWork: Effect.succeed(true),
        });

        // Boot probe runs once automatically; await its published snapshot via streamChanges.
        const bootPublished = yield* waitForSnapshot(
          wrapped.snapshot.streamChanges,
          (snap) => snap.usageLimits?.windows[0]?.usedPercent === 30,
        );
        yield* Deferred.await(probeStarted);
        yield* Deferred.succeed(probeGate, undefined);
        expect((yield* Fiber.join(bootPublished))._tag).toBe("Some");

        expect(probeCalls).toBe(1);
        expect((yield* wrapped.snapshot.getSnapshot).usageLimits?.windows[0]?.usedPercent).toBe(30);
        expect((yield* wrapped.snapshotForCwd("/tmp")).usageLimits?.windows[0]?.usedPercent).toBe(
          30,
        );

        // Periodic health check snapshot updates forward on streamChanges without re-probing.
        const periodicPublished = yield* waitForSnapshot(
          wrapped.snapshot.streamChanges,
          (snap) => snap.checkedAt === "2026-11-26T10:01:00.000Z",
        );
        yield* fake.publish(makeBaseSnapshot({ checkedAt: "2026-11-26T10:01:00.000Z" }));
        expect((yield* Fiber.join(periodicPublished))._tag).toBe("Some");
        expect(probeCalls).toBe(1);

        // Fresh overlay skips onSessionStarted probe (still clears any prior failure backoff).
        const backoffBeforeSession = clearedBackoff;
        yield* wrapped.onSessionStarted();
        expect(clearedBackoff).toBe(backoffBeforeSession + 1);
        expect(probeCalls).toBe(1);

        // After 5 minutes, onSessionStarted triggers a background refresh.
        yield* TestClock.adjust("5 minutes");
        nextLimits = {
          checkedAt: "1970-01-01T00:05:00.000Z",
          windows: [
            {
              id: "gemini-5h",
              kind: "session",
              label: "Gemini · 5-hour",
              usedPercent: 55,
              windowDurationMins: 300,
            },
          ],
        };
        const stalePublished = yield* waitForSnapshot(
          wrapped.snapshot.streamChanges,
          (snap) => snap.usageLimits?.windows[0]?.usedPercent === 55,
        );
        yield* wrapped.onSessionStarted();
        expect((yield* Fiber.join(stalePublished))._tag).toBe("Some");
        expect(probeCalls).toBe(2);
        expect((yield* wrapped.snapshot.getSnapshot).usageLimits?.windows[0]?.usedPercent).toBe(55);

        // Transient probeFailed on explicit refresh retains last good usage limits.
        nextLimits = {
          checkedAt: "1970-01-01T00:06:00.000Z",
          windows: [],
          unavailable: { reason: "probeFailed", message: "boom" },
        };
        const refreshed = yield* wrapped.snapshot.refresh;
        expect(clearedBackoff).toBeGreaterThanOrEqual(2);
        expect(refreshed.usageLimits?.windows[0]?.usedPercent).toBe(55);

        // Account switch clears overlay and re-probes.
        nextLimits = {
          checkedAt: "1970-01-01T00:07:00.000Z",
          windows: [
            {
              id: "gemini-5h",
              kind: "session",
              label: "Gemini · 5-hour",
              usedPercent: 10,
              windowDurationMins: 300,
            },
          ],
        };
        const switchedPublished = yield* waitForSnapshot(
          wrapped.snapshot.streamChanges,
          (snap) =>
            snap.auth.email === "other@example.com" &&
            snap.usageLimits?.windows[0]?.usedPercent === 10,
        );
        yield* fake.publish(
          makeBaseSnapshot({
            auth: { status: "authenticated", type: "oauth-personal", email: "other@example.com" },
          }),
        );
        expect((yield* Fiber.join(switchedPublished))._tag).toBe("Some");
        expect(clearedAccount).toBeGreaterThanOrEqual(1);
        expect((yield* wrapped.snapshot.getSnapshot).usageLimits?.windows[0]?.usedPercent).toBe(10);

        // Sign-out clears overlay immediately.
        yield* wrapped.onSignedOut;
        expect((yield* wrapped.snapshot.getSnapshot).usageLimits).toBeUndefined();
      }),
  );

  it.effect(
    "forced snapshot.refresh cleanly interrupts an in-flight background probe and handles an account switch without aborting",
    () =>
      Effect.gen(function* () {
        const fake = yield* makeFakeProvider(makeBaseSnapshot());
        const cache = makeAntigravityCliUsageCache();
        const bgStarted = yield* Deferred.make<void>();
        const bgInterrupted = yield* Deferred.make<void>();
        const forcedLimits: ServerProviderUsageLimits = {
          checkedAt: "2026-11-26T10:02:00.000Z",
          windows: [
            {
              id: "gemini-5h",
              kind: "session",
              label: "Gemini · 5-hour",
              usedPercent: 64,
              windowDurationMins: 300,
            },
          ],
        };

        const usage: AntigravityCliUsageProbe = {
          probe: (options) =>
            Effect.gen(function* () {
              const key = "email:test";
              if (!options?.force) {
                const pending = yield* Deferred.make<ServerProviderUsageLimits | undefined>();
                cache.inFlight.set(key, pending);
                return yield* Effect.gen(function* () {
                  yield* Deferred.succeed(bgStarted, undefined);
                  return yield* Effect.never;
                }).pipe(
                  Effect.onInterrupt(() =>
                    Effect.gen(function* () {
                      if (cache.inFlight.get(key) === pending) {
                        cache.inFlight.delete(key);
                      }
                      yield* Deferred.succeed(pending, undefined);
                      yield* Deferred.succeed(bgInterrupted, undefined);
                    }),
                  ),
                );
              }
              return forcedLimits;
            }),
          clearAccount: Effect.void,
          clearBackoff: Effect.void,
        };

        // Simulate snapshot.refresh discovering a switched email on disk and publishing to base streamChanges.
        const switchedSnap = makeBaseSnapshot({
          auth: { status: "authenticated", type: "oauth-personal", email: "switched@example.com" },
        });
        const providerWithSwitchRefresh = {
          ...fake.provider,
          snapshot: {
            ...fake.provider.snapshot,
            refresh: fake.publish(switchedSnap).pipe(Effect.as(switchedSnap)),
          },
        };

        const wrapped = yield* attachAntigravityCliUsageLimits({
          provider: providerWithSwitchRefresh,
          usage,
          enabled: true,
          shouldRunBackgroundWork: Effect.succeed(true),
        });

        yield* Deferred.await(bgStarted);
        const refreshed = yield* wrapped.snapshot.refresh;
        yield* Deferred.await(bgInterrupted);
        expect(refreshed.auth.email).toBe("switched@example.com");
        expect(refreshed.usageLimits).toEqual(forcedLimits);
      }),
  );

  it.effect("automatically yields when the base provider already supplies native usageLimits", () =>
    Effect.gen(function* () {
      const nativeLimits: ServerProviderUsageLimits = {
        checkedAt: "2026-11-26T10:00:00.000Z",
        windows: [
          {
            id: "upstream-5h",
            kind: "session",
            label: "Upstream · 5-hour",
            usedPercent: 42,
            windowDurationMins: 300,
          },
        ],
      };
      const fake = yield* makeFakeProvider(makeBaseSnapshot({ usageLimits: nativeLimits }));
      let probeCalls = 0;
      const usage: AntigravityCliUsageProbe = {
        probe: () =>
          Effect.sync(() => {
            probeCalls += 1;
            return undefined;
          }),
        clearAccount: Effect.void,
        clearBackoff: Effect.void,
      };

      const wrapped = yield* attachAntigravityCliUsageLimits({
        provider: fake.provider,
        usage,
        enabled: true,
        shouldRunBackgroundWork: Effect.succeed(true),
      });

      expect((yield* wrapped.snapshot.getSnapshot).usageLimits).toEqual(nativeLimits);
      expect((yield* wrapped.snapshot.refresh).usageLimits).toEqual(nativeLimits);
      yield* wrapped.snapshot.refreshUsage!;
      expect(yield* Ref.get(fake.refreshUsageCount)).toBe(1);
      expect(probeCalls).toBe(0);
    }),
  );

  it.effect("emits overlay updates on streamChanges and refreshes on snapshot.refreshUsage", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeProvider(makeBaseSnapshot());
      const limits: ServerProviderUsageLimits = {
        checkedAt: "2026-11-26T10:00:00.000Z",
        windows: [
          {
            id: "gemini-5h",
            kind: "session",
            label: "Gemini · 5-hour",
            usedPercent: 80,
            windowDurationMins: 300,
          },
        ],
      };
      const usage: AntigravityCliUsageProbe = {
        probe: () => Effect.succeed(limits),
        clearAccount: Effect.void,
        clearBackoff: Effect.void,
      };
      const wrapped = yield* attachAntigravityCliUsageLimits({
        provider: fake.provider,
        usage,
        enabled: true,
        shouldRunBackgroundWork: Effect.succeed(false),
      });

      const nextChange = yield* waitForSnapshot(
        wrapped.snapshot.streamChanges,
        (snap) => snap.usageLimits !== undefined,
      );
      yield* wrapped.snapshot.refreshUsage!;
      const received = yield* Fiber.join(nextChange);
      expect(received._tag).toBe("Some");
      if (received._tag === "Some") {
        expect(received.value.usageLimits).toEqual(limits);
      }
    }),
  );
});
