import { testEffect } from "@nodecg/private";
import { Effect } from "effect";
import { describe, expect, test } from "vitest";

import { InMemoryStateStorage } from "./in-memory-state-storage.ts";
import { StateStorageService } from "./state-storage.ts";

describe("read", () => {
	test(
		"fails with StateNotFound on a missing key",
		testEffect(
			Effect.gen(function* () {
				const storage = yield* StateStorageService;
				const error = yield* storage.read("ns", "missing").pipe(Effect.flip);
				expect(error._tag).toBe("StateNotFound");
			}).pipe(Effect.provide(InMemoryStateStorage)),
		),
	);
});

describe("create", () => {
	test(
		"stores new values that read returns (creating the namespace)",
		testEffect(
			Effect.gen(function* () {
				const storage = yield* StateStorageService;
				yield* storage.create("ns", "a", 1);
				yield* storage.create("ns", "b", "two");
				expect(yield* storage.read("ns", "a")).toBe(1);
				expect(yield* storage.read("ns", "b")).toBe("two");
			}).pipe(Effect.provide(InMemoryStateStorage)),
		),
	);

	test(
		"fails with StateAlreadyExists when the key already exists",
		testEffect(
			Effect.gen(function* () {
				const storage = yield* StateStorageService;
				yield* storage.create("ns", "a", 1);
				const error = yield* storage.create("ns", "a", 2).pipe(Effect.flip);
				expect(error._tag).toBe("StateAlreadyExists");
				expect(yield* storage.read("ns", "a")).toBe(1);
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
				yield* storage.create("ns", "a", 1);
				yield* storage.update("ns", "a", 2);
				expect(yield* storage.read("ns", "a")).toBe(2);
			}).pipe(Effect.provide(InMemoryStateStorage)),
		),
	);

	test(
		"fails with StateNotFound on a missing key",
		testEffect(
			Effect.gen(function* () {
				const storage = yield* StateStorageService;
				const error = yield* storage.update("ns", "x", 1).pipe(Effect.flip);
				expect(error._tag).toBe("StateNotFound");
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
