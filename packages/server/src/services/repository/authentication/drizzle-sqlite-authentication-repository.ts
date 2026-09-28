import {
	AccountId,
	type Authentication,
	AuthenticationId,
	UserId,
	type UserSessionId,
} from "@nodecg-next/internal";
import { and, eq, gt, sql } from "drizzle-orm";
import { Array, Crypto, Effect, Layer, Option } from "effect";

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

		const insertAuthentications = Effect.fn(function* (
			inputs: Array.NonEmptyReadonlyArray<Authentication>,
		) {
			const rows = yield* Effect.forEach(
				inputs,
				Effect.fn(function* ({ issuer, subject, displayName }) {
					return {
						id: AuthenticationId.make(yield* crypto.randomUUIDv4),
						userId: UserId.make(yield* crypto.randomUUIDv4),
						issuer,
						subject,
						displayName,
					};
				}),
			);
			const insertedRows = yield* db
				.insert(authentications)
				.values(
					rows.map(({ id, userId, issuer, subject }) => ({
						id,
						userId,
						issuer,
						subject,
					})),
				)
				.onConflictDoNothing({
					target: [authentications.issuer, authentications.subject],
				})
				.returning({ userId: authentications.userId });
			const insertedUserIds = new Set(insertedRows.map(({ userId }) => userId));
			return rows.filter(({ userId }) => insertedUserIds.has(userId));
		}, retryOnIdCollision);

		const insertUsers = Effect.fn(function* (
			created: Array.NonEmptyReadonlyArray<{
				readonly userId: UserId;
				readonly displayName: string;
			}>,
			now: number,
		) {
			const rows = yield* Effect.forEach(
				created,
				Effect.fn(function* ({ userId, displayName }) {
					return {
						userId,
						displayName,
						accountId: AccountId.make(yield* crypto.randomUUIDv4),
					};
				}),
			);
			yield* db.insert(accounts).values(
				rows.map(({ accountId, displayName }) => ({
					id: accountId,
					displayName,
					createdAt: now,
				})),
			);
			yield* db
				.insert(users)
				.values(
					rows.map(({ userId, accountId }) => ({ id: userId, accountId })),
				);
		}, retryOnIdCollision);

		const insertMissing = Effect.fn(function* (
			inputs: Array.NonEmptyReadonlyArray<Authentication>,
			now: number,
		) {
			return yield* db.transaction(() =>
				Effect.gen(function* () {
					// Check foreign keys at commit, not at insert
					yield* db.run(sql`PRAGMA defer_foreign_keys = ON`);
					const created = yield* insertAuthentications(inputs);
					if (!Array.isReadonlyArrayNonEmpty(created)) {
						return [];
					}
					yield* insertUsers(created, now);
					return created.map(({ id }) => id);
				}),
			);
		});

		const findOrCreateAuthentication = Effect.fn(
			"AuthenticationRepository.findOrCreateAuthentication",
		)(
			function* (authentication: Authentication, now: number) {
				const created = Array.head(yield* insertMissing([authentication], now));
				if (Option.isSome(created)) {
					return created.value;
				}
				const existing = yield* db
					.select({ id: authentications.id })
					.from(authentications)
					.where(
						and(
							eq(authentications.issuer, authentication.issuer),
							eq(authentications.subject, authentication.subject),
						),
					)
					.pipe(Effect.head);
				return existing.id;
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
		);

		const resolveBySession = Effect.fn(
			"AuthenticationRepository.resolveBySession",
		)(
			function* (sessionId: UserSessionId, now: number) {
				const rows = yield* db
					.select({
						accountId: accounts.id,
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
				return Array.head(rows).pipe(
					Option.map(({ accountId, issuer, subject, displayName }) => ({
						accountId,
						authentication: { issuer, subject, displayName },
					})),
				);
			},
			Effect.catchTag("EffectDrizzleQueryError", (cause) =>
				BackendError.make({ cause }),
			),
		);

		return { findOrCreateAuthentication, resolveBySession };
	}),
);
