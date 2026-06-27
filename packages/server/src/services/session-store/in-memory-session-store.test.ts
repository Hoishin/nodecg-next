import { HumanIdentitySchema } from "@nodecg/internal";
import { testEffect } from "@nodecg/private";
import {
	ConfigProvider,
	Effect,
	Layer,
	Option,
	TestClock,
	TestContext,
} from "effect";
import { assert, describe, expect, test } from "vitest";

import { InMemorySessionStore } from "./in-memory-session-store.ts";
import { SessionStoreService } from "./session-store.ts";

const alice = HumanIdentitySchema.make({
	issuer: "https://idp.test",
	subject: "alice",
	displayName: "Alice",
});

const config = Layer.setConfigProvider(
	ConfigProvider.fromJson({ SESSION_TTL: "1 hour" }),
);

const layer = InMemorySessionStore.pipe(
	Layer.provide(config),
	Layer.merge(TestContext.TestContext),
);

describe("create / lookup", () => {
	test(
		"resolves a created session to its identity",
		testEffect(
			Effect.gen(function* () {
				const sessions = yield* SessionStoreService;
				const id = yield* sessions.create(alice);
				const resolved = yield* sessions.lookup(id);
				assert(Option.isSome(resolved));
				expect(resolved.value).toEqual(alice);
			}).pipe(Effect.provide(layer)),
		),
	);

	test(
		"returns None for an unknown session id",
		testEffect(
			Effect.gen(function* () {
				const sessions = yield* SessionStoreService;
				expect(Option.isNone(yield* sessions.lookup("ghost"))).toBe(true);
			}).pipe(Effect.provide(layer)),
		),
	);
});

describe("refreshTTL", () => {
	test(
		"keeps an active session alive past the original TTL",
		testEffect(
			Effect.gen(function* () {
				const sessions = yield* SessionStoreService;
				const id = yield* sessions.create(alice);
				yield* TestClock.adjust("50 minutes");
				yield* sessions.refreshTTL(id);
				yield* TestClock.adjust("50 minutes");
				assert(Option.isSome(yield* sessions.lookup(id)));
			}).pipe(Effect.provide(layer)),
		),
	);

	test(
		"lookup alone does not renew the TTL",
		testEffect(
			Effect.gen(function* () {
				const sessions = yield* SessionStoreService;
				const id = yield* sessions.create(alice);
				yield* TestClock.adjust("50 minutes");
				assert(Option.isSome(yield* sessions.lookup(id)));
				yield* TestClock.adjust("50 minutes");
				expect(Option.isNone(yield* sessions.lookup(id))).toBe(true);
			}).pipe(Effect.provide(layer)),
		),
	);

	test(
		"expires after the TTL elapses without a refresh",
		testEffect(
			Effect.gen(function* () {
				const sessions = yield* SessionStoreService;
				const id = yield* sessions.create(alice);
				yield* TestClock.adjust("61 minutes");
				expect(Option.isNone(yield* sessions.lookup(id))).toBe(true);
			}).pipe(Effect.provide(layer)),
		),
	);
});

describe("revoke", () => {
	test(
		"a revoked session no longer resolves",
		testEffect(
			Effect.gen(function* () {
				const sessions = yield* SessionStoreService;
				const id = yield* sessions.create(alice);
				yield* sessions.revoke(id);
				expect(Option.isNone(yield* sessions.lookup(id))).toBe(true);
			}).pipe(Effect.provide(layer)),
		),
	);

	test(
		"revoking an unknown session is a no-op",
		testEffect(
			Effect.gen(function* () {
				const sessions = yield* SessionStoreService;
				yield* sessions.revoke("ghost");
			}).pipe(Effect.provide(layer)),
		),
	);
});
