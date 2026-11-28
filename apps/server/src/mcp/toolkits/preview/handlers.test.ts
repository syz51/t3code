import { describe, expect, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import {
  EnvironmentId,
  PreviewTabId,
  ProjectId,
  ProviderInstanceId,
  SERVER_BROWSER_AUTOMATION_CLIENT_ID,
  ThreadId,
  TurnItemId,
  type PreviewAutomationRequest,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Stream from "effect/Stream";

import {
  createPendingAttachmentId,
  parseThreadSegmentFromAttachmentId,
} from "../../../attachmentStore.ts";
import * as ServerSecretStore from "../../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../../config.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as SecretRequests from "../../../secrets/SecretRequests.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell, liveThreadsLayer } from "../../McpToolAccess.testkit.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import { claimPreviewRecording, layerStandard } from "./handlers.ts";
import { PreviewStandardToolkit } from "./tools.ts";

it.effect("preview_open navigates the opened tab to a dev server in one tool call", () =>
  Effect.gen(function* () {
    const scope = yield* McpInvocationContext.McpInvocationContext;
    const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
    const connected = yield* Deferred.make<void>();
    const tabId = PreviewTabId.make("opened-tab");
    const target = {
      kind: "environment-port" as const,
      port: 3000,
      path: "/settings?tab=account",
    };
    const requests: PreviewAutomationRequest[] = [];
    const status = {
      available: true,
      visible: false,
      tabId,
      url: "http://localhost:3000/settings?tab=account",
      title: "Settings",
      loading: false,
    };
    const events = yield* broker.connect({
      clientId: "client-1",
      environmentId: scope.environmentId,
    });
    yield* Stream.runForEach(events, (event) => {
      if (event.type === "connected") return Deferred.succeed(connected, undefined);
      requests.push(event.request);
      return broker.respond({
        clientId: "client-1",
        connectionId: event.connectionId,
        requestId: event.request.requestId,
        ok: true,
        result: event.request.operation === "open" ? { ...status, url: "about:blank" } : status,
      });
    }).pipe(Effect.forkScoped);
    yield* Deferred.await(connected);
    const toolkit = yield* PreviewStandardToolkit.pipe(
      Effect.provide(McpToolAccess.HandlersLayer.layer(layerStandard)),
    );
    const results = yield* toolkit
      .handle("preview_open", {
        url: "http://localhost:3000",
        target,
        open: false,
        reuseExistingTab: false,
      })
      .pipe(Stream.unwrap, Stream.runCollect);
    expect(results.at(-1)?.result).toEqual(status);
    expect(requests.map(({ operation, input }) => ({ operation, input }))).toEqual([
      { operation: "open", input: { open: false, show: false, reuseExistingTab: false } },
      { operation: "navigate", input: { target } },
    ]);
    expect(requests[1]?.tabId).toBe(tabId);
    expect(requests[1]?.tabIdExplicit).toBe(true);
  }).pipe(
    Effect.provideService(McpInvocationContext.McpInvocationContext, {
      environmentId: EnvironmentId.make("environment-1"),
      requestNamespace: "provider-session-1",
      thread: {
        threadId: ThreadId.make("thread-1"),
        providerSessionId: "provider-session-1",
        providerInstanceId: ProviderInstanceId.make("codex"),
      },
      client: undefined,
      capabilities: new Set(["preview"] as const),
      issuedAt: 1,
    }),
    Effect.provide(
      Layer.mergeAll(
        PreviewAutomationBroker.layer,
        liveThreadsLayer,
        Layer.mock(SecretRequests.SecretRequests)({}),
      ).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
    ),
  ),
);

describe("preview_act secretRef", () => {
  const threadId = ThreadId.make("thread-1");
  const otherThreadId = ThreadId.make("thread-other-project");
  const turnItemId = TurnItemId.make("turn-item:secret-request:preview-login");
  const projectId = ProjectId.make("project:mcp-test");
  const otherProjectId = ProjectId.make("project:other");

  const makeSecretLayer = () => {
    const stored = new Map<string, Uint8Array>();
    let secretStatus = "pending";
    const threads = Layer.mock(ThreadManagementService.ThreadManagementService)({
      getThreadShell: (id) =>
        Effect.succeed({
          ...liveThreadShell(id),
          projectId: id === otherThreadId ? otherProjectId : projectId,
        }),
      getThreadRecords: () =>
        Effect.succeed({
          thread: { projectId },
          runs: [{ id: "run-1", status: "running" }],
          turnItems: [
            {
              id: turnItemId,
              threadId,
              runId: "run-1",
              nodeId: "node-root",
              type: "secret_request",
              label: "App password",
              reason: "Sign in to preview page.",
              secretStatus,
            },
          ],
        } as never),
      dispatch: (command) =>
        Effect.sync(() => {
          if (command.type === "secret_request.record" && secretStatus === "pending") {
            secretStatus = command.secretStatus;
          }
          return {} as never;
        }),
    });
    const secretStore = Layer.succeed(
      ServerSecretStore.ServerSecretStore,
      ServerSecretStore.ServerSecretStore.of({
        get: (name) => Effect.succeed(Option.fromNullishOr(stored.get(name))),
        set: (name, value) => Effect.sync(() => void stored.set(name, value)),
        create: (name, value) =>
          stored.has(name)
            ? Effect.fail(
                new ServerSecretStore.SecretStorePersistError({
                  resource: name,
                  cause: new PlatformError.PlatformError(
                    new PlatformError.SystemError({
                      _tag: "AlreadyExists",
                      module: "FileSystem",
                      method: "open",
                    }),
                  ),
                } as never),
              )
            : Effect.sync(() => void stored.set(name, value)),
        getOrCreateRandom: (name, bytes) =>
          Effect.sync(() => {
            const existing = stored.get(name);
            if (existing) return existing;
            const value = new Uint8Array(bytes).fill(9);
            stored.set(name, value);
            return value;
          }),
        remove: (name) => Effect.sync(() => void stored.delete(name)),
      }),
    );
    const base = Layer.mergeAll(
      NodeServices.layer,
      NodeCrypto.layer,
      secretStore,
      Layer.mock(SecretResolver.SecretResolver)({}),
    );
    return Layer.mergeAll(PreviewAutomationBroker.layer, SecretRequests.layer).pipe(
      Layer.provideMerge(threads),
      Layer.provide(base),
    );
  };

  const makeScope = (
    overrides: Partial<McpInvocationContext.McpThreadInvocationScope> = {},
  ): McpInvocationContext.McpThreadInvocationScope => ({
    environmentId: EnvironmentId.make("environment-1"),
    requestNamespace: "provider-session-1",
    thread: {
      threadId,
      providerSessionId: "provider-session-1",
      providerInstanceId: ProviderInstanceId.make("codex"),
    },
    client: undefined,
    capabilities: new Set(["preview"] as const),
    issuedAt: 1,
    ...overrides,
  });

  it.effect(
    "types a one-use secretRef once, rejects reuse, and keeps the value out of results and logs",
    () => {
      const secretValue = "SuperSecret-Login!9876";
      const logLines: Array<string> = [];
      const captureLogger = Logger.make(({ message, cause }) => {
        logLines.push(JSON.stringify({ message, cause: String(cause) }));
      });
      return Effect.gen(function* () {
        const secrets = yield* SecretRequests.SecretRequests;
        const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
        yield* secrets.answer({
          threadId,
          turnItemId,
          answer: { type: "save", secret: secretValue },
        });
        const secretRef = Option.getOrThrow(yield* secrets.savedRef({ threadId, turnItemId }));

        const connected = yield* Deferred.make<void>();
        const requests: PreviewAutomationRequest[] = [];
        const events = yield* broker.connect({
          clientId: SERVER_BROWSER_AUTOMATION_CLIENT_ID,
          environmentId: EnvironmentId.make("environment-1"),
        });
        yield* Stream.runForEach(events, (event) => {
          if (event.type === "connected") return Deferred.succeed(connected, undefined);
          requests.push(event.request);
          return broker.respond({
            clientId: SERVER_BROWSER_AUTOMATION_CLIENT_ID,
            connectionId: event.connectionId,
            requestId: event.request.requestId,
            ok: true,
            result:
              event.request.operation === "status"
                ? {
                    available: true,
                    visible: true,
                    tabId: PreviewTabId.make("tab-login"),
                    url: "https://example.test/login",
                    title: "Sign in",
                    loading: false,
                  }
                : {},
          });
        }).pipe(Effect.forkScoped);
        yield* Deferred.await(connected);

        const toolkit = yield* PreviewStandardToolkit.pipe(
          Effect.provide(McpToolAccess.HandlersLayer.layer(layerStandard)),
        );

        // Invalid input or missing preview capability must not consume the ref.
        const conflicting = yield* toolkit
          .handle("preview_act", {
            action: "type",
            locator: "aria-ref=e4",
            text: "literal",
            secretRef,
          })
          .pipe(Stream.unwrap, Stream.runCollect, Effect.flip);
        expect(conflicting._tag).toBe("OrchestratorMcpFailure");
        expect(requests).toEqual([]);

        const noPreview = yield* toolkit
          .handle("preview_act", {
            action: "type",
            locator: "aria-ref=e4",
            secretRef,
          })
          .pipe(
            Stream.unwrap,
            Stream.runCollect,
            Effect.flip,
            Effect.provideService(
              McpInvocationContext.McpInvocationContext,
              makeScope({ capabilities: new Set() }),
            ),
          );
        expect(noPreview._tag).toBe("PreviewAutomationUnavailableError");
        expect(requests).toEqual([]);

        // Another project cannot consume this project's secretRef.
        const wrongProject = yield* toolkit
          .handle("preview_act", {
            action: "type",
            locator: "aria-ref=e4",
            secretRef,
          })
          .pipe(
            Stream.unwrap,
            Stream.runCollect,
            Effect.flip,
            Effect.provideService(
              McpInvocationContext.McpInvocationContext,
              makeScope({
                thread: {
                  threadId: otherThreadId,
                  providerSessionId: "provider-session-2",
                  providerInstanceId: ProviderInstanceId.make("codex"),
                },
              }),
            ),
          );
        expect(wrongProject._tag).toBe("OrchestratorMcpFailure");
        expect(wrongProject.message).toContain("already used or does not exist");
        expect(requests).toEqual([]);

        // First authorized fill consumes the ref and types the secret.
        const results = yield* toolkit
          .handle("preview_act", {
            action: "type",
            locator: "aria-ref=e4",
            secretRef,
            clear: true,
          })
          .pipe(Stream.unwrap, Stream.runCollect);
        const output = results.at(-1)?.result;
        expect(output).toEqual({
          toolIcon: { _tag: "website", pageUrl: "https://example.test/login" },
        });
        expect(JSON.stringify(output)).not.toContain(secretValue);
        expect(requests[0]?.operation).toBe("type");
        expect(requests[0]?.input).toEqual({
          locator: "aria-ref=e4",
          text: secretValue,
          clear: true,
          sensitive: true,
        });

        // Second use of the same secretRef fails and does not invoke the browser.
        const countAfterFirstUse = requests.length;
        const reused = yield* toolkit
          .handle("preview_act", {
            action: "type",
            locator: "aria-ref=e4",
            secretRef,
          })
          .pipe(Stream.unwrap, Stream.runCollect, Effect.flip);
        expect(reused._tag).toBe("OrchestratorMcpFailure");
        expect(reused.message).toContain("already used");
        expect(reused.message).not.toContain(secretValue);
        expect(requests.length).toBe(countAfterFirstUse);
        expect(logLines.join("\n")).not.toContain(secretValue);
      }).pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, makeScope()),
        Effect.provide(Layer.mergeAll(makeSecretLayer(), Logger.layer([captureLogger]))),
      );
    },
  );

  it.effect("redacts host errors that echo a secretRef value", () => {
    const secretValue = "EchoedSecret#4242";
    return Effect.gen(function* () {
      const secrets = yield* SecretRequests.SecretRequests;
      const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
      yield* secrets.answer({
        threadId,
        turnItemId,
        answer: { type: "save", secret: secretValue },
      });
      const secretRef = Option.getOrThrow(yield* secrets.savedRef({ threadId, turnItemId }));

      const connected = yield* Deferred.make<void>();
      const events = yield* broker.connect({
        clientId: SERVER_BROWSER_AUTOMATION_CLIENT_ID,
        environmentId: EnvironmentId.make("environment-1"),
      });
      yield* Stream.runForEach(events, (event) => {
        if (event.type === "connected") return Deferred.succeed(connected, undefined);
        return broker.respond({
          clientId: SERVER_BROWSER_AUTOMATION_CLIENT_ID,
          connectionId: event.connectionId,
          requestId: event.request.requestId,
          ok: false,
          error: {
            _tag: "PreviewAutomationExecutionError",
            message: `Malformed value "${secretValue}"`,
          },
        });
      }).pipe(Effect.forkScoped);
      yield* Deferred.await(connected);

      const toolkit = yield* PreviewStandardToolkit.pipe(
        Effect.provide(McpToolAccess.HandlersLayer.layer(layerStandard)),
      );
      const failure = yield* toolkit
        .handle("preview_act", {
          action: "type",
          locator: "#pw",
          secretRef,
        })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.flip);
      expect(failure._tag).toBe("PreviewAutomationExecutionError");
      expect(failure.message).not.toContain(secretValue);
    }).pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, makeScope()),
      Effect.provide(makeSecretLayer()),
    );
  });
});

describe("claimPreviewRecording", () => {
  it.effect("overlapping and repeated claims return the same retained recording", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const uploadedAttachmentId = createPendingAttachmentId(".webm");
      const pendingPath = path.join(config.attachmentsDir, `${uploadedAttachmentId}.webm`);
      yield* fileSystem.makeDirectory(config.attachmentsDir, { recursive: true });
      yield* fileSystem.writeFileString(pendingPath, "video!");
      const response = {
        id: "desktop-recording",
        tabId: "tab-1",
        path: "/desktop/recording.webm",
        mimeType: "video/webm",
        sizeBytes: 6,
        createdAt: "2026-09-07T00:00:00.000Z",
        uploadedAttachmentId,
      };
      const claim = claimPreviewRecording(ThreadId.make("thread-1"), response);
      const [first, second] = yield* Effect.all([claim, claim], { concurrency: "unbounded" });
      expect(first).toEqual(second);
      expect(yield* claim).toEqual(first);
      expect(yield* fileSystem.readFileString(first.path)).toBe("video!");
      expect(yield* fileSystem.exists(pendingPath)).toBe(false);
      const wrongThread = yield* claimPreviewRecording(ThreadId.make("thread-2"), response).pipe(
        Effect.result,
      );
      expect(wrongThread._tag).toBe("Failure");
      const wrongPath = yield* claimPreviewRecording(ThreadId.make("thread-1"), {
        ...response,
        uploadedAttachmentId: `../${uploadedAttachmentId}`,
      }).pipe(Effect.result);
      expect(wrongPath._tag).toBe("Failure");
    }).pipe(
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-preview-recording-" }).pipe(
          Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
        ),
      ),
    ),
  );

  it.effect.each([6, 5])(
    "claims only a complete uploaded recording (reported bytes: %s)",
    (sizeBytes) =>
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const uploadedAttachmentId = createPendingAttachmentId(".webm");
        const pendingPath = path.join(config.attachmentsDir, `${uploadedAttachmentId}.webm`);
        yield* fileSystem.makeDirectory(config.attachmentsDir, { recursive: true });
        yield* fileSystem.writeFileString(pendingPath, "video!");
        const response = {
          id: "desktop-recording",
          tabId: "tab-1",
          path: "/desktop/recording.webm",
          mimeType: "video/webm",
          sizeBytes,
          createdAt: "2026-09-07T00:00:00.000Z",
          uploadedAttachmentId,
        };
        const result = yield* claimPreviewRecording(ThreadId.make("thread-1"), response).pipe(
          Effect.result,
        );
        if (sizeBytes === 6) {
          expect(result._tag).toBe("Success");
          if (result._tag !== "Success") return;
          expect(result.success.path).not.toBe(response.path);
          expect(parseThreadSegmentFromAttachmentId(result.success.id)).toBe("thread-1");
          expect(yield* fileSystem.readFileString(result.success.path)).toBe("video!");
          expect(yield* fileSystem.exists(pendingPath)).toBe(false);
        } else {
          expect(result._tag).toBe("Failure");
          if (result._tag !== "Failure") return;
          expect(result.failure._tag).toBe("PreviewAutomationRecordingTransferError");
          expect(yield* fileSystem.exists(pendingPath)).toBe(true);
        }
      }).pipe(
        Effect.provide(
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-preview-recording-" }).pipe(
            Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
          ),
        ),
      ),
  );
});
