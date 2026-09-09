import { HumanAccountSchema } from "@nodecg-next/internal";
import { testLayer } from "@nodecg-next/test-utils";
import { ConfigProvider, Effect, Layer, Option } from "effect";
import { TestClock } from "effect/testing";
import { assert, describe, expect } from "vitest";

import { InMemorySessionStore } from "./in-memory-session-store.ts";
import { SessionStoreService } from "./session-store.ts";

const alice = HumanAccountSchema.make({
	issuer: "https://idp.test",
	subject: "alice",
	displayName: "Alice",
});

const config = ConfigProvider.layer(
	ConfigProvider.fromEnvRecord({ SESSION_TTL: "1 hour" }),
);

const test = testLayer(InMemorySessionStore.pipe(Layer.provide(config)));

describe("create / lookup", () => {
	test(
		"resolves a created session to its identity",
		Effect.gen(function* () {
			const sessions = yield* SessionStoreService;
			const id = yield* sessions.create(alice);
			const resolved = yield* sessions.lookup(id);
			assert(Option.isSome(resolved));
			expect(resolved.value).toEqual(alice);
		}),
	);

	test(
		"returns None for an unknown session id",
		Effect.gen(function* () {
			const sessions = yield* SessionStoreService;
			expect(Option.isNone(yield* sessions.lookup("ghost"))).toBe(true);
		}),
	);
});

describe("refreshTTL", () => {
	test(
		"keeps an active session alive past the original TTL",
		Effect.gen(function* () {
			const sessions = yield* SessionStoreService;
			const id = yield* sessions.create(alice);
			yield* TestClock.adjust("50 minutes");
			yield* sessions.refreshTTL(id);
			yield* TestClock.adjust("50 minutes");
			assert(Option.isSome(yield* sessions.lookup(id)));
		}),
	);

	test(
		"lookup alone does not renew the TTL",
		Effect.gen(function* () {
			const sessions = yield* SessionStoreService;
			const id = yield* sessions.create(alice);
			yield* TestClock.adjust("50 minutes");
			assert(Option.isSome(yield* sessions.lookup(id)));
			yield* TestClock.adjust("50 minutes");
			expect(Option.isNone(yield* sessions.lookup(id))).toBe(true);
		}),
	);

	test(
		"expires after the TTL elapses without a refresh",
		Effect.gen(function* () {
			const sessions = yield* SessionStoreService;
			const id = yield* sessions.create(alice);
			yield* TestClock.adjust("61 minutes");
			expect(Option.isNone(yield* sessions.lookup(id))).toBe(true);
		}),
	);
});

describe("revoke", () => {
	test(
		"a revoked session no longer resolves",
		Effect.gen(function* () {
			const sessions = yield* SessionStoreService;
			const id = yield* sessions.create(alice);
			yield* sessions.revoke(id);
			expect(Option.isNone(yield* sessions.lookup(id))).toBe(true);
		}),
	);

	test(
		"revoking an unknown session is a no-op",
		Effect.gen(function* () {
			const sessions = yield* SessionStoreService;
			yield* sessions.revoke("ghost");
		}),
	);
});
