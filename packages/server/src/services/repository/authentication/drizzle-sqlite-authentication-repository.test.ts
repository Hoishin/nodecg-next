import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { type Authentication, UserSessionId } from "@nodecg-next/internal";
import { testLayer } from "@nodecg-next/test-utils";
import { eq, sql } from "drizzle-orm";
import { Crypto, DateTime, Effect, Layer, Option, Schema } from "effect";
import { TestClock } from "effect/testing";
import { Reactivity } from "effect/unstable/reactivity";
import { afterEach, assert, describe, expect, vi } from "vitest";

import { DrizzleSqliteDatabaseService } from "../../database/drizzle-sqlite/drizzle-sqlite-database.ts";
import {
	accounts,
	authentications,
	users,
} from "../../database/drizzle-sqlite/tables.ts";
import { BackendError } from "../repository-errors.ts";
import { DrizzleSqliteSessionRepository } from "../session/drizzle-sqlite-session-repository.ts";
import { SessionRepositoryService } from "../session/session-repository.ts";
import { AuthenticationRepositoryService } from "./authentication-repository.ts";
import { DrizzleSqliteAuthenticationRepository } from "./drizzle-sqlite-authentication-repository.ts";

const randomBytes = vi.fn((size: number) =>
	crypto.getRandomValues(new Uint8Array(size)),
);

afterEach(() => {
	randomBytes.mockReset();
});

const test = testLayer(
	Layer.mergeAll(
		DrizzleSqliteAuthenticationRepository,
		DrizzleSqliteSessionRepository,
	).pipe(
		Layer.provideMerge(
			Layer.effect(
				DrizzleSqliteDatabaseService,
				DrizzleSqliteDatabaseService.make(":memory:"),
			),
		),
		Layer.provide(
			Layer.mergeAll(
				NodeFileSystem.layer,
				NodePath.layer,
				Layer.succeed(
					Crypto.Crypto,
					Crypto.make({ randomBytes, digest: vi.fn() }),
				),
				Reactivity.layer,
			),
		),
	),
);

const alice: Authentication = { issuer: "dev", subject: "alice" };

const bob: Authentication = { issuer: "dev", subject: "bob" };

describe("findOrCreateAuthentication", () => {
	test(
		"creates a user and an account under the given name on its first login",
		Effect.gen(function* () {
			const repository = yield* AuthenticationRepositoryService;
			const db = yield* DrizzleSqliteDatabaseService;
			yield* TestClock.setTime(1000);

			const created = yield* repository.findOrCreateAuthentication(
				alice,
				"Alice",
			);

			const account = yield* db.select().from(accounts).pipe(Effect.head);
			const user = yield* db.select().from(users).pipe(Effect.head);
			const authentication = yield* db
				.select()
				.from(authentications)
				.pipe(Effect.head);
			expect(created).toStrictEqual({
				authenticationId: authentication.id,
				userId: user.id,
				accountId: account.id,
			});
			expect(account).toStrictEqual({
				id: account.id,
				displayName: "Alice",
				createdAt: 1000,
			});
			expect(user).toStrictEqual({ id: user.id, accountId: account.id });
			expect(authentication).toStrictEqual({
				id: authentication.id,
				userId: user.id,
				issuer: "dev",
				subject: "alice",
			});
		}),
	);

	test(
		"returns the same authentication on a later login, keeping the account's name",
		Effect.gen(function* () {
			const repository = yield* AuthenticationRepositoryService;
			const db = yield* DrizzleSqliteDatabaseService;

			yield* TestClock.setTime(1000);
			const first = yield* repository.findOrCreateAuthentication(
				alice,
				"Alice",
			);
			yield* TestClock.setTime(2000);
			const second = yield* repository.findOrCreateAuthentication(
				alice,
				"Alice Liddell",
			);

			expect(second).toStrictEqual(first);
			expect(
				yield* db
					.select({
						displayName: accounts.displayName,
						createdAt: accounts.createdAt,
					})
					.from(accounts),
			).toStrictEqual([{ displayName: "Alice", createdAt: 1000 }]);
		}),
	);

	test(
		"gives another subject of the same issuer its own account",
		Effect.gen(function* () {
			const repository = yield* AuthenticationRepositoryService;
			const db = yield* DrizzleSqliteDatabaseService;

			const created = yield* repository.findOrCreateAuthentication(
				alice,
				"Alice",
			);
			const other = yield* repository.findOrCreateAuthentication(bob, "Bob");

			expect(other.accountId).not.toBe(created.accountId);
			expect(
				(yield* db.select({ displayName: accounts.displayName }).from(accounts))
					.map(({ displayName }) => displayName)
					.toSorted(),
			).toStrictEqual(["Alice", "Bob"]);
		}),
	);

	test(
		"retries a first login from scratch when its drawn user id is taken",
		Effect.gen(function* () {
			const repository = yield* AuthenticationRepositoryService;
			const db = yield* DrizzleSqliteDatabaseService;
			const authenticationId = new Uint8Array(16).fill(1);
			const userId = new Uint8Array(16).fill(2);
			randomBytes
				.mockReturnValueOnce(authenticationId)
				.mockReturnValueOnce(userId);
			const aliceIds = yield* repository.findOrCreateAuthentication(
				alice,
				"Alice",
			);
			randomBytes
				.mockReturnValueOnce(new Uint8Array(16).fill(3))
				.mockReturnValueOnce(userId);

			const bobIds = yield* repository.findOrCreateAuthentication(bob, "Bob");

			// 3 ids times 3 attempts
			expect(randomBytes).toHaveBeenCalledTimes(9);
			const accountRows = yield* db
				.select()
				.from(accounts)
				.orderBy(accounts.displayName);
			expect(accountRows).toStrictEqual([
				{ id: aliceIds.accountId, displayName: "Alice", createdAt: 0 },
				{ id: bobIds.accountId, displayName: "Bob", createdAt: 0 },
			]);
		}),
	);

	test(
		"fails with a backend error when the query fails",
		Effect.gen(function* () {
			const repository = yield* AuthenticationRepositoryService;
			const db = yield* DrizzleSqliteDatabaseService;
			yield* db.run(sql`drop table authentications`);

			const error = yield* repository
				.findOrCreateAuthentication(alice, "Alice")
				.pipe(Effect.flip);

			assert(Schema.is(BackendError)(error));
			expect(error.message).toContain("authentications");
		}),
	);
});

describe("resolveBySession", () => {
	const sessionId = UserSessionId.make("session");

	test(
		"resolves a live session to its account, authentication and the account's name",
		Effect.gen(function* () {
			const repository = yield* AuthenticationRepositoryService;
			const sessionRepository = yield* SessionRepositoryService;
			const db = yield* DrizzleSqliteDatabaseService;
			const now = yield* DateTime.now;
			const { authenticationId } = yield* repository.findOrCreateAuthentication(
				alice,
				"Alice",
			);
			yield* repository.findOrCreateAuthentication(bob, "Bob");
			yield* sessionRepository.create(
				sessionId,
				authenticationId,
				DateTime.addDuration(now, 2000),
			);
			yield* repository.findOrCreateAuthentication(alice, "Alice Liddell");
			const account = yield* db
				.select({ id: accounts.id })
				.from(accounts)
				.where(eq(accounts.displayName, "Alice"))
				.pipe(Effect.head);
			const user = yield* db
				.select({ id: users.id })
				.from(users)
				.where(eq(users.accountId, account.id))
				.pipe(Effect.head);
			yield* TestClock.setTime(1999);

			const resolved = yield* repository.resolveBySession(sessionId);
			expect(resolved).toStrictEqual(
				Option.some({
					accountId: account.id,
					userId: user.id,
					authentication: alice,
					displayName: "Alice",
				}),
			);
		}),
	);

	test(
		"treats a session as absent from the moment it expires",
		Effect.gen(function* () {
			const repository = yield* AuthenticationRepositoryService;
			const sessionRepository = yield* SessionRepositoryService;
			const now = yield* DateTime.now;
			const { authenticationId } = yield* repository.findOrCreateAuthentication(
				alice,
				"Alice",
			);
			yield* sessionRepository.create(
				sessionId,
				authenticationId,
				DateTime.addDuration(now, 2000),
			);
			yield* TestClock.setTime(2000);

			const resolved = yield* repository.resolveBySession(sessionId);
			expect(resolved).toStrictEqual(Option.none());
		}),
	);

	test(
		"treats an unknown session as absent",
		Effect.gen(function* () {
			const repository = yield* AuthenticationRepositoryService;
			const resolved = yield* repository.resolveBySession(sessionId);
			expect(resolved).toStrictEqual(Option.none());
		}),
	);
});
