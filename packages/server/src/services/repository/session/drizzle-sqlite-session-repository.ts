import type { AuthenticationId, UserSessionId } from "@nodecg-next/internal";
import { and, eq, gt } from "drizzle-orm";
import { DateTime, Effect, Layer } from "effect";

import { DrizzleSqliteDatabaseService } from "../../database/drizzle-sqlite/drizzle-sqlite-database.ts";
import { sessions } from "../../database/drizzle-sqlite/tables.ts";
import { BackendError, KeyTaken } from "../repository-errors.ts";
import { SessionRepositoryService } from "./session-repository.ts";

export const DrizzleSqliteSessionRepository = Layer.effect(
	SessionRepositoryService,
	Effect.gen(function* () {
		const db = yield* DrizzleSqliteDatabaseService;

		const create = Effect.fn("SessionRepository.create")(
			function* (
				id: UserSessionId,
				authenticationId: AuthenticationId,
				expiresAt: DateTime.DateTime,
			) {
				const inserted = yield* db
					.insert(sessions)
					.values({
						id,
						authenticationId,
						expiresAt: DateTime.toEpochMillis(expiresAt),
					})
					.onConflictDoNothing({ target: sessions.id })
					.returning({ id: sessions.id });
				if (inserted.length === 0) {
					return yield* KeyTaken.make();
				}
			},
			Effect.catchTag("EffectDrizzleQueryError", (cause) =>
				BackendError.make({ cause }),
			),
		);

		const refreshTTL = Effect.fn("SessionRepository.refreshTTL")(
			function* (id: UserSessionId, expiresAt: DateTime.DateTime) {
				const now = yield* DateTime.now;
				yield* db
					.update(sessions)
					.set({ expiresAt: DateTime.toEpochMillis(expiresAt) })
					.where(
						and(
							eq(sessions.id, id),
							gt(sessions.expiresAt, DateTime.toEpochMillis(now)),
						),
					);
			},
			Effect.catchTag("EffectDrizzleQueryError", (cause) =>
				BackendError.make({ cause }),
			),
		);

		const revoke = Effect.fn("SessionRepository.revoke")(
			function* (id: UserSessionId) {
				yield* db.delete(sessions).where(eq(sessions.id, id));
			},
			Effect.catchTag("EffectDrizzleQueryError", (cause) =>
				BackendError.make({ cause }),
			),
		);

		return { create, refreshTTL, revoke };
	}),
);
