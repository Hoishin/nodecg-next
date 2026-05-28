import { testEffect } from "@nodecg/private";
import { Effect, Option, Stream } from "effect";
import { assert, describe, expect, test } from "vitest";

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

describe("changes", () => {
	test(
		"emits a StateChange when update succeeds",
		testEffect(
			Effect.gen(function* () {
				const storage = yield* StateStorageService;
				yield* storage.create("ns", "a", 1);

				const [head] = yield* Effect.all(
					[
						Stream.runHead(storage.changes),
						Effect.gen(function* () {
							yield* Effect.yieldNow();
							yield* storage.update("ns", "a", 2);
						}),
					],
					{ concurrency: "unbounded" },
				);

				assert(Option.isSome(head));
				expect(head.value).toEqual({
					namespace: "ns",
					name: "a",
					value: 2,
				});
			}).pipe(Effect.provide(InMemoryStateStorage)),
		),
	);

	test(
		"does not emit on create or failed update",
		testEffect(
			Effect.gen(function* () {
				const storage = yield* StateStorageService;

				const [head] = yield* Effect.all(
					[
						Stream.runHead(storage.changes),
						Effect.gen(function* () {
							yield* Effect.yieldNow();
							yield* storage.create("ns", "a", 1);
							yield* storage
								.update("missing-ns", "x", 99)
								.pipe(Effect.flip);
							yield* storage.update("ns", "a", 2);
						}),
					],
					{ concurrency: "unbounded" },
				);

				assert(Option.isSome(head));
				expect(head.value).toEqual({
					namespace: "ns",
					name: "a",
					value: 2,
				});
			}).pipe(Effect.provide(InMemoryStateStorage)),
		),
	);

	test(
		"delivers events to multiple concurrent subscribers",
		testEffect(
			Effect.gen(function* () {
				const storage = yield* StateStorageService;
				yield* storage.create("ns", "a", 0);

				const [a, b] = yield* Effect.all(
					[
						Stream.runHead(storage.changes),
						Stream.runHead(storage.changes),
						Effect.gen(function* () {
							yield* Effect.yieldNow();
							yield* storage.update("ns", "a", 7);
						}),
					],
					{ concurrency: "unbounded" },
				);

				assert(Option.isSome(a));
				assert(Option.isSome(b));
				const expected = { namespace: "ns", name: "a", value: 7 };
				expect(a.value).toEqual(expected);
				expect(b.value).toEqual(expected);
			}).pipe(Effect.provide(InMemoryStateStorage)),
		),
	);
});
