import {
	AccountId,
	type Authentication,
	AuthenticationId,
	UserId,
} from "@nodecg-next/internal";
import { and, eq, gt, sql } from "drizzle-orm";
import { Array, Crypto, DateTime, Effect, Layer, Option } from "effect";

import { DrizzleSqliteDatabaseService } from "../../database/drizzle-sqlite/drizzle-sqlite-database.ts";
import { retryOnIdCollision } from "../../database/drizzle-sqlite/retry-on-id-collision.ts";
import {
	accounts,
	authentications,
	sessions,
	users,
} from "../../database/drizzle-sqlite/tables.ts";
import { BackendError } from "../repository-errors.ts";
import { AuthenticationRepositoryService } from "./authentication-repository.ts";

export const DrizzleSqliteAuthenticationRepository = Layer.effect(
	AuthenticationRepositoryService,
	Effect.gen(function* () {
		const crypto = yield* Crypto.Crypto;
		const db = yield* DrizzleSqliteDatabaseService;

		const insertMissing = Effect.fn(function* (
			inputs: Array.NonEmptyReadonlyArray<{
				readonly authentication: Authentication;
				readonly displayName: string;
			}>,
		) {
			return yield* db
				.transaction(() =>
					Effect.gen(function* () {
						yield* db.run(sql`PRAGMA defer_foreign_keys = ON`);

						const authenticationRows = yield* Effect.forEach(
							inputs,
							Effect.fn(function* ({
								authentication: { issuer, subject },
								displayName,
							}) {
								return {
									id: AuthenticationId.make(yield* crypto.randomUUIDv7),
									userId: UserId.make(yield* crypto.randomUUIDv7),
									issuer,
									subject,
									displayName,
								};
							}),
						);
						const insertedAuthentications = yield* db
							.insert(authentications)
							.values(
								authenticationRows.map(({ id, userId, issuer, subject }) => ({
									id,
									userId,
									issuer,
									subject,
								})),
							)
							.onConflictDoNothing({
								target: [authentications.issuer, authentications.subject],
							})
							.returning({
								id: authentications.id,
							});
						const insertedAuthenticationRows = authenticationRows.filter(
							({ id }) =>
								insertedAuthentications.some(
									({ id: insertedId }) => id === insertedId,
								),
						);

						if (Array.isArrayEmpty(insertedAuthentications)) {
							return [];
						}

						const accountRows = yield* Effect.forEach(
							insertedAuthenticationRows,
							Effect.fn(function* ({
								id: authenticationId,
								userId,
								displayName,
							}) {
								return {
									authenticationId,
									userId,
									displayName,
									accountId: AccountId.make(yield* crypto.randomUUIDv7),
								};
							}),
						);
						const now = yield* DateTime.now;
						yield* db.insert(accounts).values(
							accountRows.map(({ accountId, displayName }) => ({
								id: accountId,
								displayName,
								createdAt: DateTime.toEpochMillis(now),
							})),
						);
						yield* db.insert(users).values(
							accountRows.map(({ userId, accountId }) => ({
								id: userId,
								accountId,
							})),
						);
						return accountRows.map(
							({ authenticationId, userId, accountId }) => ({
								authenticationId,
								userId,
								accountId,
							}),
						);
					}),
				)
				.pipe(retryOnIdCollision);
		});

		return {
			findOrCreateAuthentication: Effect.fn(
				"AuthenticationRepository.findOrCreateAuthentication",
			)(
				function* (authentication, displayName) {
					const created = Array.head(
						yield* insertMissing([{ authentication, displayName }]),
					);
					if (Option.isSome(created)) {
						return created.value;
					}
					return yield* db
						.select({
							authenticationId: authentications.id,
							userId: users.id,
							accountId: users.accountId,
						})
						.from(authentications)
						.innerJoin(users, eq(authentications.userId, users.id))
						.where(
							and(
								eq(authentications.issuer, authentication.issuer),
								eq(authentications.subject, authentication.subject),
							),
						)
						.pipe(Effect.head);
				},
				Effect.catchTag(
					[
						"EffectDrizzleQueryError",
						"SqlError",
						"PlatformError",
						"NoSuchElementError",
					],
					(cause) => BackendError.make({ cause }),
				),
			),
			resolveByAccountId: Effect.fn(
				"AuthenticationRepository.resolveByAccountId",
			)(
				function* (accountId) {
					return yield* db
						.select({
							issuer: authentications.issuer,
							subject: authentications.subject,
						})
						.from(authentications)
						.innerJoin(users, eq(authentications.userId, users.id))
						.where(eq(users.accountId, accountId));
				},
				Effect.catchTag("EffectDrizzleQueryError", (cause) =>
					BackendError.make({ cause }),
				),
			),
			resolveBySession: Effect.fn("AuthenticationRepository.resolveBySession")(
				function* (sessionId) {
					const now = yield* DateTime.now;
					const rows = yield* db
						.select({
							accountId: accounts.id,
							userId: users.id,
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
						.where(
							and(
								eq(sessions.id, sessionId),
								gt(sessions.expiresAt, DateTime.toEpochMillis(now)),
							),
						);
					return Array.head(rows).pipe(
						Option.map(
							({ accountId, userId, issuer, subject, displayName }) => ({
								accountId,
								userId,
								authentication: { issuer, subject },
								displayName,
							}),
						),
					);
				},
				Effect.catchTag("EffectDrizzleQueryError", (cause) =>
					BackendError.make({ cause }),
				),
			),
		};
	}),
);
