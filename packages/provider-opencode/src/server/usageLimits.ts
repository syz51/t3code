import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import * as Digest from "effect/crypto/Digest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Hex from "effect/encoding/Hex";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const AuthFile = Schema.Struct({ "opencode-go": Schema.optionalKey(Schema.Unknown) });
const ApiAuth = Schema.Struct({ type: Schema.Literal("api"), key: Schema.String });
const decodeAuthFile = Schema.decodeEffect(Schema.fromJsonString(AuthFile));
const decodeApiAuth = Schema.decodeUnknownOption(ApiAuth);
// OpenCode 2's database tags a stored key "key"; auth.json tags it "api".
const StoredKey = Schema.Struct({
  type: Schema.Literal("key"),
  key: Schema.String,
  metadata: Schema.optionalKey(
    Schema.NullOr(Schema.Struct({ server: Schema.optionalKey(Schema.Unknown) })),
  ),
});
const decodeStoredKey = Schema.decodeOption(Schema.fromJsonString(StoredKey));
const UsageWindow = Schema.Struct({
  percent: Schema.Finite,
  resetsAt: Schema.DateTimeUtcFromString,
});
const UsageResponse = Schema.Struct({
  usage: Schema.Struct({ rolling: UsageWindow, weekly: UsageWindow, monthly: UsageWindow }),
});

// Select before decoding so an OAuth or self-hosted connection cannot fall
// through to another stored account. NULL-active rows predate the selection flag.
class OpenCodeCredentialReadError extends Schema.TaggedError<OpenCodeCredentialReadError>()(
  "OpenCodeCredentialReadError",
  { databasePath: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not read OpenCode credentials from ${this.databasePath}.`;
  }
}

const isConsoleServerUrl = (server: string): boolean => {
  try {
    const url = new URL(server);
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}` === "https://opencode.ai/console";
  } catch {
    return false;
  }
};

const readStoredApiKeys = Effect.fn("readStoredApiKeys")(function* (
  databasePath: string,
  integrationIds: ReadonlyArray<"opencode" | "opencode-go">,
) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(databasePath).pipe(Effect.orElseSucceed(() => false)))) {
    return [];
  }
  return yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const keys: Array<string | undefined> = [];
    for (const integrationId of integrationIds) {
      const rows = yield* sql<{ readonly value: unknown }>`
        SELECT value FROM credential
        WHERE integration_id = ${integrationId} AND active IS NOT 0
        ORDER BY active DESC, time_created DESC, id DESC LIMIT 1
      `;
      const row = rows[0];
      const stored =
        typeof row?.value === "string"
          ? Option.getOrUndefined(decodeStoredKey(row.value))
          : undefined;
      const server = stored?.metadata?.server;
      if (typeof server === "string" && !isConsoleServerUrl(server)) {
        keys.push(undefined);
        continue;
      }
      keys.push(stored?.key.trim());
    }
    return keys;
  }).pipe(
    Effect.provide(
      NodeSqliteClient.layer({
        filename: databasePath,
        readonly: true,
        writerWorker: true,
        busyTimeoutMs: 100,
      }),
    ),
    Effect.mapError((cause) => new OpenCodeCredentialReadError({ databasePath, cause })),
    Effect.orElseSucceed((): Array<string | undefined> => []),
  );
});

/** External OpenCode servers own their credentials; never read the host's account for them. */
export const readOpenCodeGoUsageLimits = Effect.fn("readOpenCodeGoUsageLimits")(function* (input: {
  readonly enabled: boolean;
  readonly serverUrl: string;
  readonly environment: NodeJS.ProcessEnv;
}) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const unsupported = makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
  if (!input.enabled || input.serverUrl.trim()) return unsupported;

  return yield* Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const env = input.environment;
    const dataHome =
      env.XDG_DATA_HOME ||
      path.join(
        env.HOME || env.USERPROFILE || (yield* HostProcess.HomeDirectory),
        ".local",
        "share",
      );
    const authPath = path.join(dataHome, "opencode", "auth.json");
    const contents =
      env.OPENCODE_AUTH_CONTENT ||
      (yield* fs.readFileString(authPath).pipe(
        Effect.catchTags({
          PlatformError: (error) =>
            error.reason._tag === "NotFound" ? Effect.succeed("{}") : Effect.fail(error),
        }),
      ));
    const auth = yield* decodeAuthFile(contents);
    const apiAuth = decodeApiAuth(auth["opencode-go"]);
    // OpenCode overlays stored API credentials after environment credentials.
    const goKey = (Option.isSome(apiAuth) ? apiAuth.value.key : env.OPENCODE_API_KEY)?.trim();
    // Console supplies Go credentials in OpenCode 2. Inline auth explicitly
    // overrides local credentials, including the Console connection.
    const databaseFile = env.OPENCODE_DB ?? "opencode.db";
    const databasePath = path.resolve(dataHome, "opencode", databaseFile);
    const storedKeys =
      env.OPENCODE_AUTH_CONTENT || databaseFile === ":memory:"
        ? []
        : // OpenCode 2 imports auth.json once, so a replaced Go key only exists in opencode-go.
          yield* readStoredApiKeys(databasePath, ["opencode", "opencode-go"]);
    const keys = [...new Set([...storedKeys, goKey].filter((key): key is string => Boolean(key)))];
    let apiKey = keys[0];
    if (!apiKey) return unsupported;

    const client = yield* HttpClient.HttpClient;
    const readUsage = (key: string) =>
      client.execute(
        HttpClientRequest.get("https://opencode.ai/zen/go/v1/usage").pipe(
          HttpClientRequest.bearerToken(key),
        ),
      );
    let response = yield* readUsage(apiKey);
    for (const key of keys.slice(1)) {
      if (response.status !== 401 && response.status !== 403) break;
      apiKey = key;
      response = yield* readUsage(apiKey);
    }
    // A valid Zen key can exist without a Go subscription.
    if (response.status === 403) return unsupported;
    const body = yield* HttpClientResponse.filterStatusOk(response).pipe(
      Effect.flatMap(HttpClientResponse.schemaBodyJson(UsageResponse)),
    );
    const windows: ServerProviderUsageWindow[] = [
      {
        id: "go_rolling",
        kind: "session",
        label: "Go · Session",
        windowDurationMins: 5 * 60,
        usedPercent: clampPercent(body.usage.rolling.percent),
        resetsAt: DateTime.formatIso(body.usage.rolling.resetsAt),
      },
      {
        id: "go_weekly",
        kind: "weekly",
        label: "Go · Weekly",
        windowDurationMins: 7 * 24 * 60,
        usedPercent: clampPercent(body.usage.weekly.percent),
        resetsAt: DateTime.formatIso(body.usage.weekly.resetsAt),
      },
      {
        id: "go_monthly",
        kind: "monthly",
        label: "Go · Monthly",
        usedPercent: clampPercent(body.usage.monthly.percent),
        resetsAt: DateTime.formatIso(body.usage.monthly.resetsAt),
      },
    ];
    const digest = yield* Digest.Digest;
    // Unkeyed hashes match across environments; random Go keys resist offline guessing.
    const credentialFingerprint = yield* digest
      .digest(Digest.sha256, new TextEncoder().encode(`opencode-go\0${apiKey}`))
      .pipe(Effect.map(Hex.encode), Effect.orDie);
    return {
      ...makeUsageLimits({ checkedAt, windows }),
      credentialFingerprint,
    };
  }).pipe(
    Effect.timeout("5 seconds"),
    Effect.orElseSucceed(() =>
      makeUnavailableUsageLimits({
        checkedAt,
        reason: "probeFailed",
        message: "OpenCode Go could not read usage.",
      }),
    ),
  );
});
