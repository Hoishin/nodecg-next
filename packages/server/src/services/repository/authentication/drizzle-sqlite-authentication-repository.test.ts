import { randomUUID } from "node:crypto";

import { NodeFileSystem, NodePath } from "@effect/platform-node";
import {
	AccountId,
	type Authentication,
	UserSessionId,
} from "@nodecg-next/internal";
import { testLayer } from "@nodecg-next/test-utils";
import { eq, sql } from "drizzle-orm";
import { Effect, Layer, Option, Schema } from "effect";
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
			Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, Reactivity.layer),
		),
	),
);

vi.mock(import("node:crypto"), { spy: true });

afterEach(() => {
	vi.mocked(randomUUID).mockReset();
});

const alice: Authentication = {
	issuer: "dev",
	subject: "alice",
	displayName: "Alice",
};

const bob: Authentication = {
	issuer: "dev",
	subject: "bob",
	displayName: "Bob",
};

describe("findOrCreateAuthentication", () => {
	test(
		"creates the account under a fresh id when the generated id is taken",
		Effect.gen(function* () {
			const repository = yield* AuthenticationRepositoryService;
			const db = yield* DrizzleSqliteDatabaseService;
			const takenId = randomUUID();
			vi.mocked(randomUUID).mockReturnValueOnce(takenId);
			yield* repository.findOrCreateAuthentication(alice, 1000);
			vi.mocked(randomUUID).mockReturnValueOnce(takenId);

			yield* repository.findOrCreateAuthentication(bob, 1000);

			const bobAccounts = yield* db
				.select({ id: accounts.id })
				.from(accounts)
				.where(eq(accounts.displayName, "Bob"));
			expect(bobAccounts).toHaveLength(1);
			expect(bobAccounts[0]?.id).not.toBe(takenId);
			expect(
				yield* db
					.select({ displayName: accounts.displayName })
					.from(accounts)
					.where(eq(accounts.id, AccountId.make(takenId))),
			).toStrictEqual([{ displayName: "Alice" }]);
		}),
	);

	test(
		"fails with a backend error when every generated id is taken",
		Effect.gen(function* () {
			const repository = yield* AuthenticationRepositoryService;
			const takenId = randomUUID();
			vi.mocked(randomUUID).mockReturnValueOnce(takenId);
			yield* repository.findOrCreateAuthentication(alice, 1000);
			vi.mocked(randomUUID).mockReturnValue(takenId);

			const error = yield* repository
				.findOrCreateAuthentication(bob, 1000)
				.pipe(Effect.flip);

			assert(Schema.is(BackendError)(error));
		}),
	);

	test(
		"does not retry an insert that fails for another reason than a taken id",
		Effect.gen(function* () {
			const repository = yield* AuthenticationRepositoryService;
			const db = yield* DrizzleSqliteDatabaseService;
			yield* db.run(sql`drop table accounts`);

			const error = yield* repository
				.findOrCreateAuthentication(alice, 1000)
				.pipe(Effect.flip);

			assert(Schema.is(BackendError)(error));
			expect(randomUUID).toHaveBeenCalledOnce();
		}),
	);

	test(
		"creates a user and an account named after the authentication on its first login",
		Effect.gen(function* () {
			const repository = yield* AuthenticationRepositoryService;
			const db = yield* DrizzleSqliteDatabaseService;

			const id = yield* repository.findOrCreateAuthentication(alice, 1000);

			const [account] = yield* db.select().from(accounts);
			const [user] = yield* db.select().from(users);
			assert(typeof account !== "undefined");
			assert(typeof user !== "undefined");
			expect(account).toStrictEqual({
				id: account.id,
				displayName: "Alice",
				createdAt: 1000,
			});
			expect(user).toStrictEqual({ id: user.id, accountId: account.id });
			expect(yield* db.select().from(authentications)).toStrictEqual([
				{ id, userId: user.id, issuer: "dev", subject: "alice" },
			]);
		}),
	);

	test(
		"returns the same authentication on a later login, keeping the account's name",
		Effect.gen(function* () {
			const repository = yield* AuthenticationRepositoryService;
			const db = yield* DrizzleSqliteDatabaseService;

			const first = yield* repository.findOrCreateAuthentication(alice, 1000);
			const second = yield* repository.findOrCreateAuthentication(
				{ ...alice, displayName: "Alice Liddell" },
				2000,
			);

			expect(second).toBe(first);
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

			const aliceAuthId = yield* repository.findOrCreateAuthentication(
				alice,
				1000,
			);
			const bobAuthId = yield* repository.findOrCreateAuthentication(bob, 1000);

			expect(bobAuthId).not.toBe(aliceAuthId);
			expect(
				(yield* db.select({ displayName: accounts.displayName }).from(accounts))
					.map(({ displayName }) => displayName)
					.toSorted(),
			).toStrictEqual(["Alice", "Bob"]);
		}),
	);

	test(
		"fails with a backend error when the query fails",
		Effect.gen(function* () {
			const repository = yield* AuthenticationRepositoryService;
			const db = yield* DrizzleSqliteDatabaseService;
			yield* db.run(sql`drop table authentications`);

			const error = yield* repository
				.findOrCreateAuthentication(alice, 1000)
				.pipe(Effect.flip);

			assert(Schema.is(BackendError)(error));
			expect(error.message).toContain("authentications");
		}),
	);
});

describe("resolveBySession", () => {
	const sessionId = UserSessionId.make("session");

	test(
		"resolves a live session to its authentication, named after the account",
		Effect.gen(function* () {
			const repository = yield* AuthenticationRepositoryService;
			const sessionRepository = yield* SessionRepositoryService;
			const authentication = yield* repository.findOrCreateAuthentication(
				alice,
				1000,
			);
			yield* sessionRepository.create(sessionId, authentication, 2000);
			yield* repository.findOrCreateAuthentication(
				{ ...alice, displayName: "Alice Liddell" },
				1000,
			);

			expect(yield* repository.resolveBySession(sessionId, 1999)).toStrictEqual(
				Option.some(alice),
			);
		}),
	);

	test(
		"treats a session as absent from the moment it expires",
		Effect.gen(function* () {
			const repository = yield* AuthenticationRepositoryService;
			const sessionRepository = yield* SessionRepositoryService;
			const authentication = yield* repository.findOrCreateAuthentication(
				alice,
				1000,
			);
			yield* sessionRepository.create(sessionId, authentication, 2000);

			expect(yield* repository.resolveBySession(sessionId, 2000)).toStrictEqual(
				Option.none(),
			);
		}),
	);

	test(
		"treats an unknown session as absent",
		Effect.gen(function* () {
			const repository = yield* AuthenticationRepositoryService;
			expect(yield* repository.resolveBySession(sessionId, 0)).toStrictEqual(
				Option.none(),
			);
		}),
	);
});
