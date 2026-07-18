import { testEffect } from "@nodecg/internal/test-utils";
import { Effect, Layer, Option, TestClock, TestContext } from "effect";
import { assert, describe, expect, test } from "vitest";

import { InMemoryStashStore } from "./in-memory-stash-store.ts";
import { type AuthStash, StashStoreService } from "./stash-store.ts";

const stash: AuthStash = {
	provider: "dev",
	state: "abc123",
	returnTo: "/dashboard",
};

const layer = InMemoryStashStore.pipe(Layer.merge(TestContext.TestContext));

describe("create / lookup", () => {
	test(
		"resolves a created stash by id",
		testEffect(
			Effect.gen(function* () {
				const stashes = yield* StashStoreService;
				const id = yield* stashes.create(stash);
				const resolved = yield* stashes.lookup(id);
				assert(Option.isSome(resolved));
				expect(resolved.value).toEqual(stash);
			}).pipe(Effect.provide(layer)),
		),
	);

	test(
		"returns None for an unknown id",
		testEffect(
			Effect.gen(function* () {
				const stashes = yield* StashStoreService;
				expect(Option.isNone(yield* stashes.lookup("ghost"))).toBe(true);
			}).pipe(Effect.provide(layer)),
		),
	);
});

describe("expiry", () => {
	test(
		"expires after the TTL elapses",
		testEffect(
			Effect.gen(function* () {
				const stashes = yield* StashStoreService;
				const id = yield* stashes.create(stash);
				yield* TestClock.adjust("11 minutes");
				expect(Option.isNone(yield* stashes.lookup(id))).toBe(true);
			}).pipe(Effect.provide(layer)),
		),
	);
});

describe("revoke", () => {
	test(
		"a revoked stash no longer resolves",
		testEffect(
			Effect.gen(function* () {
				const stashes = yield* StashStoreService;
				const id = yield* stashes.create(stash);
				yield* stashes.revoke(id);
				expect(Option.isNone(yield* stashes.lookup(id))).toBe(true);
			}).pipe(Effect.provide(layer)),
		),
	);
});
