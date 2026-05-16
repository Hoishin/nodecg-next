import { testEffect } from "@nodecg/private";
import { Effect } from "effect";
import { describe, expect, test } from "vitest";

import { InMemoryStateStorage } from "./in-memory-state-storage";
import { StateStorageService } from "./state-storage";

describe("get", () => {
	test(
		"fails with StateNotFound on a missing key",
		testEffect(
			Effect.gen(function* () {
				const storage = yield* StateStorageService;
				const result = yield* Effect.either(storage.get("ns", "missing"));
				expect(result._tag).toBe("Left");
				if (result._tag === "Left") {
					expect(result.left._tag).toBe("StateNotFound");
				}
			}).pipe(Effect.provide(InMemoryStateStorage)),
		),
	);
});

describe("set", () => {
	test(
		"stores values that get returns (creating the namespace)",
		testEffect(
			Effect.gen(function* () {
				const storage = yield* StateStorageService;
				yield* storage.set("ns", "a", 1);
				yield* storage.set("ns", "b", "two");
				expect(yield* storage.get("ns", "a")).toBe(1);
				expect(yield* storage.get("ns", "b")).toBe("two");
			}).pipe(Effect.provide(InMemoryStateStorage)),
		),
	);

	test(
		"overwrites an existing value",
		testEffect(
			Effect.gen(function* () {
				const storage = yield* StateStorageService;
				yield* storage.set("ns", "a", 1);
				yield* storage.set("ns", "a", 2);
				expect(yield* storage.get("ns", "a")).toBe(2);
			}).pipe(Effect.provide(InMemoryStateStorage)),
		),
	);
});

describe("update", () => {
	test(
		"overwrites an existing value",
		testEffect(
			Effect.gen(function* () {
				const storage = yield* StateStorageService;
				yield* storage.set("ns", "a", 1);
				yield* storage.update("ns", "a", 2);
				expect(yield* storage.get("ns", "a")).toBe(2);
			}).pipe(Effect.provide(InMemoryStateStorage)),
		),
	);

	test(
		"fails with StateNotFound on a missing key",
		testEffect(
			Effect.gen(function* () {
				const storage = yield* StateStorageService;
				const result = yield* Effect.either(storage.update("ns", "x", 1));
				expect(result._tag).toBe("Left");
				if (result._tag === "Left") {
					expect(result.left._tag).toBe("StateNotFound");
				}
			}).pipe(Effect.provide(InMemoryStateStorage)),
		),
	);
});

describe("persistInterval", () => {
	test(
		"is exposed",
		testEffect(
			Effect.gen(function* () {
				const storage = yield* StateStorageService;
				expect(storage.persistInterval).toBe(0);
			}).pipe(Effect.provide(InMemoryStateStorage)),
		),
	);
});
