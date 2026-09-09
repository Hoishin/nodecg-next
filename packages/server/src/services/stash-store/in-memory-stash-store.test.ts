import { testLayer } from "@nodecg-next/test-utils";
import { Effect, Option } from "effect";
import { TestClock } from "effect/testing";
import { assert, describe, expect } from "vitest";

import { InMemoryStashStore } from "./in-memory-stash-store.ts";
import { type AuthStash, StashStoreService } from "./stash-store.ts";

const test = testLayer(InMemoryStashStore);

const stash: AuthStash = {
	provider: "dev",
	state: "abc123",
	returnTo: "/dashboard",
};

describe("create / lookup", () => {
	test(
		"resolves a created stash by id",
		Effect.gen(function* () {
			const stashes = yield* StashStoreService;
			const id = yield* stashes.create(stash);
			const resolved = yield* stashes.lookup(id);
			assert(Option.isSome(resolved));
			expect(resolved.value).toEqual(stash);
		}),
	);

	test(
		"returns None for an unknown id",
		Effect.gen(function* () {
			const stashes = yield* StashStoreService;
			expect(Option.isNone(yield* stashes.lookup("ghost"))).toBe(true);
		}),
	);
});

describe("expiry", () => {
	test(
		"expires after the TTL elapses",
		Effect.gen(function* () {
			const stashes = yield* StashStoreService;
			const id = yield* stashes.create(stash);
			yield* TestClock.adjust("11 minutes");
			expect(Option.isNone(yield* stashes.lookup(id))).toBe(true);
		}),
	);
});

describe("revoke", () => {
	test(
		"a revoked stash no longer resolves",
		Effect.gen(function* () {
			const stashes = yield* StashStoreService;
			const id = yield* stashes.create(stash);
			yield* stashes.revoke(id);
			expect(Option.isNone(yield* stashes.lookup(id))).toBe(true);
		}),
	);
});
