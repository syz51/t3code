import { AuthSessionId, type AuthEnvironmentScope } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import { REUSABLE_DEV_SESSION_PREFIX } from "../auth/ReusableDevAuth.ts";
import * as AuthSessions from "./AuthSessions.ts";
import * as Sqlite from "./Sqlite.ts";

const layerAuthSession = AuthSessions.layer.pipe(Layer.provideMerge(Sqlite.layerMemory));

const scopes: ReadonlyArray<AuthEnvironmentScope> = ["access:read"];
const client = {
  label: "t3 thread cli",
  ipAddress: null,
  userAgent: null,
  deviceType: "desktop" as const,
  os: null,
  browser: null,
};

const now = DateTime.makeUnsafe("2026-11-28T12:00:00.000Z");
const cutoff = DateTime.subtractDuration(now, AuthSessions.AUTH_SESSION_RETENTION);

const createSession = (
  sessions: AuthSessions.AuthSessionRepository["Service"],
  input: {
    readonly id: string;
    readonly issuedAt: DateTime.Utc;
    readonly expiresAt: DateTime.Utc;
    readonly revokedAt?: DateTime.Utc;
  },
) =>
  Effect.gen(function* () {
    const sessionId = AuthSessionId.make(input.id);
    yield* sessions.create({
      sessionId,
      subject: "mcp-client",
      scopes,
      method: "bearer-access-token",
      client,
      issuedAt: input.issuedAt,
      expiresAt: input.expiresAt,
    });
    if (input.revokedAt !== undefined) {
      yield* sessions.revoke({ sessionId, revokedAt: input.revokedAt });
    }
    return sessionId;
  });

const remainingSessionIds = Effect.flatMap(
  SqlClient.SqlClient,
  (sql) =>
    sql<{ readonly session_id: string }>`SELECT session_id FROM auth_sessions ORDER BY session_id`,
).pipe(Effect.map((rows) => rows.map((row) => row.session_id)));

describe("AuthSessionRepository.pruneExpiredAndRevoked", () => {
  it.effect(
    "prunes expired and revoked rows older than the cutoff while preserving active and within-window rows",
    () =>
      Effect.gen(function* () {
        const sessions = yield* AuthSessions.AuthSessionRepository;
        const oldIssuedAt = DateTime.subtractDuration(cutoff, Duration.days(10));

        const activeId = yield* createSession(sessions, {
          id: "01-active",
          issuedAt: DateTime.subtractDuration(now, Duration.days(1)),
          expiresAt: DateTime.addDuration(now, Duration.days(29)),
        });
        const recentExpiredId = yield* createSession(sessions, {
          id: "02-recent-expired",
          issuedAt: oldIssuedAt,
          expiresAt: DateTime.addDuration(cutoff, Duration.seconds(1)),
        });
        const boundaryExpiredId = yield* createSession(sessions, {
          id: "03-boundary-expired",
          issuedAt: oldIssuedAt,
          expiresAt: cutoff,
        });
        const recentRevokedId = yield* createSession(sessions, {
          id: "04-recent-revoked",
          issuedAt: oldIssuedAt,
          expiresAt: DateTime.addDuration(now, Duration.days(20)),
          revokedAt: DateTime.addDuration(cutoff, Duration.seconds(1)),
        });
        const boundaryRevokedId = yield* createSession(sessions, {
          id: "05-boundary-revoked",
          issuedAt: oldIssuedAt,
          expiresAt: DateTime.addDuration(now, Duration.days(20)),
          revokedAt: cutoff,
        });
        // Prunable: expired strictly before cutoff.
        yield* createSession(sessions, {
          id: "06-old-expired",
          issuedAt: oldIssuedAt,
          expiresAt: DateTime.subtractDuration(cutoff, Duration.seconds(1)),
        });
        // Prunable: revoked strictly before cutoff even though expires_at is still in the future.
        yield* createSession(sessions, {
          id: "07-old-revoked-future-expiry",
          issuedAt: oldIssuedAt,
          expiresAt: DateTime.addDuration(now, Duration.days(20)),
          revokedAt: DateTime.subtractDuration(cutoff, Duration.seconds(1)),
        });
        // Protected: revoked reusable-dev-token tombstone must survive pruning so restarts do not re-enable it.
        const revokedDevId = yield* createSession(sessions, {
          id: `${REUSABLE_DEV_SESSION_PREFIX}revoked-tombstone`,
          issuedAt: oldIssuedAt,
          expiresAt: DateTime.addDuration(now, Duration.days(20)),
          revokedAt: DateTime.subtractDuration(cutoff, Duration.days(30)),
        });
        // Protected: expired session still referenced by a live connection or DPoP renewal chain.
        const liveExcludedId = yield* createSession(sessions, {
          id: "08-live-excluded-expired",
          issuedAt: oldIssuedAt,
          expiresAt: DateTime.subtractDuration(cutoff, Duration.days(2)),
        });

        const firstPass = yield* sessions.pruneExpiredAndRevoked({
          before: cutoff,
          excludeSessionIds: [liveExcludedId],
        });
        assert.deepStrictEqual(firstPass, {
          deletedRevokedCount: 1,
          deletedExpiredCount: 1,
          totalDeletedCount: 2,
        });
        const expectedRemaining = [
          activeId,
          recentExpiredId,
          boundaryExpiredId,
          recentRevokedId,
          boundaryRevokedId,
          liveExcludedId,
          revokedDevId,
        ];
        assert.deepStrictEqual(yield* remainingSessionIds, expectedRemaining);
        assert.isTrue(Option.isSome(yield* sessions.getById({ sessionId: activeId })));

        // Re-running with the same cutoff is idempotent.
        const secondPass = yield* sessions.pruneExpiredAndRevoked({
          before: cutoff,
          excludeSessionIds: [liveExcludedId],
        });
        assert.deepStrictEqual(secondPass, {
          deletedRevokedCount: 0,
          deletedExpiredCount: 0,
          totalDeletedCount: 0,
        });
        assert.deepStrictEqual(yield* remainingSessionIds, expectedRemaining);
      }).pipe(Effect.provide(layerAuthSession)),
  );

  it.effect("deletes in bounded batches and yields between pages", () =>
    Effect.gen(function* () {
      const sessions = yield* AuthSessions.AuthSessionRepository;
      const oldTime = DateTime.subtractDuration(cutoff, Duration.days(1));
      const futureTime = DateTime.addDuration(now, Duration.days(30));

      for (let i = 0; i < 7; i++) {
        yield* createSession(sessions, {
          id: `revoked-${String(i).padStart(2, "0")}`,
          issuedAt: oldTime,
          expiresAt: futureTime,
          revokedAt: oldTime,
        });
      }
      for (let i = 0; i < 5; i++) {
        yield* createSession(sessions, {
          id: `expired-${String(i).padStart(2, "0")}`,
          issuedAt: DateTime.subtractDuration(oldTime, Duration.days(1)),
          expiresAt: oldTime,
        });
      }
      const activeA = yield* createSession(sessions, {
        id: "active-a",
        issuedAt: now,
        expiresAt: futureTime,
      });
      const activeB = yield* createSession(sessions, {
        id: "active-b",
        issuedAt: now,
        expiresAt: futureTime,
      });

      let pauses = 0;
      const result = yield* sessions.pruneExpiredAndRevoked({
        before: cutoff,
        batchSize: 3,
        betweenPages: Effect.sync(() => {
          pauses += 1;
        }),
      });
      assert.deepStrictEqual(result, {
        deletedRevokedCount: 7,
        deletedExpiredCount: 5,
        totalDeletedCount: 12,
      });
      // 7 revoked rows with batchSize=3 -> 2 inter-batch pauses + 1 between passes + 1 for 5 expired rows = 4.
      assert.equal(pauses, 4);
      assert.deepStrictEqual(yield* remainingSessionIds, [activeA, activeB]);

      // Empty follow-up pass performs no pauses.
      pauses = 0;
      const emptyPass = yield* sessions.pruneExpiredAndRevoked({
        before: cutoff,
        batchSize: 3,
        betweenPages: Effect.sync(() => {
          pauses += 1;
        }),
      });
      assert.deepStrictEqual(emptyPass, {
        deletedRevokedCount: 0,
        deletedExpiredCount: 0,
        totalDeletedCount: 0,
      });
      assert.equal(pauses, 0);
    }).pipe(Effect.provide(layerAuthSession)),
  );
});
