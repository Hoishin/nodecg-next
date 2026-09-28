import { NodeCrypto, NodeFileSystem, NodePath } from "@effect/platform-node";
import { AuthenticationId, UserSessionId } from "@nodecg-next/internal";
import { testLayer } from "@nodecg-next/test-utils";
import { Effect, Layer, Schema } from "effect";
import { Reactivity } from "effect/unstable/reactivity";
import { assert, describe, expect } from "vitest";

import { DrizzleSqliteDatabaseService } from "../../database/drizzle-sqlite/drizzle-sqlite-database.ts";
import { sessions } from "../../database/drizzle-sqlite/tables.ts";
import { AuthenticationRepositoryService } from "../authentication/authentication-repository.ts";
import { DrizzleSqliteAuthenticationRepository } from "../authentication/drizzle-sqlite-authentication-repository.ts";
import { BackendError, KeyTaken } from "../repository-errors.ts";
import { DrizzleSqliteSessionRepository } from "./drizzle-sqlite-session-repository.ts";
import { SessionRepositoryService } from "./session-repository.ts";

const test = testLayer(
	Layer.mergeAll(
		DrizzleSqliteSessionRepository,
		DrizzleSqliteAuthenticationRepository,
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
				NodeCrypto.layer,
				Reactivity.layer,
			),
		),
	),
);

const first = UserSessionId.make("first");
const second = UserSessionId.make("second");

const logIn = Effect.gen(function* () {
	const authentications = yield* AuthenticationRepositoryService;
	return yield* authentications.findOrCreateAuthentication(
		{ issuer: "dev", subject: "alice", displayName: "Alice" },
		0,
	);
});

const storedSessions = Effect.gen(function* () {
	const db = yield* DrizzleSqliteDatabaseService;
	return (yield* db.select().from(sessions)).toSorted((a, b) =>
		a.id.localeCompare(b.id),
	);
});

describe("create", () => {
	test(
		"stores a session under the given id for the authentication",
		Effect.gen(function* () {
			const repository = yield* SessionRepositoryService;
			const authentication = yield* logIn;
			yield* repository.create(first, authentication, 1000);
			expect(yield* storedSessions).toStrictEqual([
				{ id: first, authenticationId: authentication, expiresAt: 1000 },
			]);
		}),
	);

	test(
		"fails with KeyTaken and keeps the stored session when the id is taken",
		Effect.gen(function* () {
			const repository = yield* SessionRepositoryService;
			const authentication = yield* logIn;
			yield* repository.create(first, authentication, 1000);
			const error = yield* repository
				.create(first, authentication, 2000)
				.pipe(Effect.flip);
			expect(error).toStrictEqual(KeyTaken.make());
			expect(yield* storedSessions).toStrictEqual([
				{ id: first, authenticationId: authentication, expiresAt: 1000 },
			]);
		}),
	);

	test(
		"fails with a backend error for an authentication that does not exist",
		Effect.gen(function* () {
			const repository = yield* SessionRepositoryService;
			const error = yield* repository
				.create(first, AuthenticationId.make("ghost"), 1000)
				.pipe(Effect.flip);
			assert(Schema.is(BackendError)(error));
			expect(error.message).toContain("FOREIGN KEY");
		}),
	);
});

describe("refreshTTL", () => {
	test(
		"moves the expiry of a live session",
		Effect.gen(function* () {
			const repository = yield* SessionRepositoryService;
			const authentication = yield* logIn;
			yield* repository.create(first, authentication, 1000);
			yield* repository.refreshTTL(first, 5000, 999);
			expect(yield* storedSessions).toStrictEqual([
				{ id: first, authenticationId: authentication, expiresAt: 5000 },
			]);
		}),
	);

	test(
		"leaves a session that expired by now as it is",
		Effect.gen(function* () {
			const repository = yield* SessionRepositoryService;
			const authentication = yield* logIn;
			yield* repository.create(first, authentication, 1000);
			yield* repository.refreshTTL(first, 5000, 1000);
			expect(yield* storedSessions).toStrictEqual([
				{ id: first, authenticationId: authentication, expiresAt: 1000 },
			]);
		}),
	);
});

describe("revoke", () => {
	test(
		"deletes only the given session",
		Effect.gen(function* () {
			const repository = yield* SessionRepositoryService;
			const authentication = yield* logIn;
			yield* repository.create(first, authentication, 1000);
			yield* repository.create(second, authentication, 1000);
			yield* repository.revoke(first);
			expect(yield* storedSessions).toStrictEqual([
				{ id: second, authenticationId: authentication, expiresAt: 1000 },
			]);
		}),
	);
});
