import type { Authentication, UserSessionId } from "@nodecg-next/internal";
import { and, eq, gt } from "drizzle-orm";
import type { EffectDrizzleQueryError } from "drizzle-orm/effect-core";
import { Array, Cause, Effect, Layer, Option, Schema } from "effect";
import { SqlError } from "effect/unstable/sql";

import { DrizzleSqliteDatabaseService } from "../../database/drizzle-sqlite/drizzle-sqlite-database.ts";
import {
	accounts,
	authentications,
	sessions,
	users,
} from "../../database/drizzle-sqlite/tables.ts";
import { BackendError } from "../repository-errors.ts";
import { AuthenticationRepositoryService } from "./authentication-repository.ts";

// https://www.sqlite.org/rescode.html#constraint_primarykey
const isSqlitePrimaryKeyViolation = Schema.is(
	Schema.Struct({ errcode: Schema.Literal(1555) }),
);

export const DrizzleSqliteAuthenticationRepository = Layer.effect(
	AuthenticationRepositoryService,
	Effect.gen(function* () {
		const db = yield* DrizzleSqliteDatabaseService;

		const retryOnIdCollision = <A, R>(
			insert: Effect.Effect<A, EffectDrizzleQueryError, R>,
		) =>
			insert.pipe(
				Effect.retry({
					times: 2,
					while: ({ cause }) =>
						Cause.isCause(cause) &&
						Cause.findErrorOption(cause).pipe(
							Option.filter(SqlError.isSqlError),
							Option.map(({ reason }) => reason),
							Option.filter(Schema.is(SqlError.ConstraintError)),
							Option.map(({ cause }) => cause),
							Option.exists(isSqlitePrimaryKeyViolation),
						),
				}),
			);

		const findOrCreateAuthentication = Effect.fn(
			"AuthenticationRepository.findOrCreateAuthentication",
		)(
			function* (
				{ issuer, subject, displayName }: Authentication,
				now: number,
			) {
				const existing = yield* db
					.select({ id: authentications.id })
					.from(authentications)
					.where(
						and(
							eq(authentications.issuer, issuer),
							eq(authentications.subject, subject),
						),
					)
					.pipe(Effect.map(Array.head));
				if (Option.isSome(existing)) {
					return existing.value.id;
				}
				const account = yield* db
					.insert(accounts)
					.values({ displayName, createdAt: now })
					.returning({ id: accounts.id })
					.pipe(retryOnIdCollision, Effect.head);
				const user = yield* db
					.insert(users)
					.values({ accountId: account.id })
					.returning({ id: users.id })
					.pipe(retryOnIdCollision, Effect.head);
				const authentication = yield* db
					.insert(authentications)
					.values({ userId: user.id, issuer, subject })
					.returning({ id: authentications.id })
					.pipe(retryOnIdCollision, Effect.head);
				return authentication.id;
			},
			Effect.catchTag(
				["EffectDrizzleQueryError", "NoSuchElementError"],
				(cause) => BackendError.make({ cause }),
			),
		);

		const resolveBySession = Effect.fn(
			"AuthenticationRepository.resolveBySession",
		)(
			function* (sessionId: UserSessionId, now: number) {
				const rows = yield* db
					.select({
						issuer: authentications.issuer,
						subject: authentications.subject,
						displayName: accounts.displayName,
					})
					.from(sessions)
					.innerJoin(
						authentications,
						eq(sessions.authenticationId, authentications.id),
					)
					.innerJoin(users, eq(authentications.userId, users.id))
					.innerJoin(accounts, eq(users.accountId, accounts.id))
					.where(and(eq(sessions.id, sessionId), gt(sessions.expiresAt, now)));
				return Array.head(rows);
			},
			Effect.catchTag("EffectDrizzleQueryError", (cause) =>
				BackendError.make({ cause }),
			),
		);

		return { findOrCreateAuthentication, resolveBySession };
	}),
);
