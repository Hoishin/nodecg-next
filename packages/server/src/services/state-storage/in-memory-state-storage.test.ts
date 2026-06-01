import { testEffect } from "@nodecg/private";
import { Effect, Exit, Queue, Scope } from "effect";
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

describe("subscribe", () => {
	test(
		"emits a StateChange when update succeeds",
		testEffect(
			Effect.gen(function* () {
				const storage = yield* StateStorageService;
				yield* storage.create("ns", "a", 1);
				const dequeue = yield* storage.subscribe();

				yield* storage.update("ns", "a", 2);

				expect(yield* Queue.take(dequeue)).toEqual({
					namespace: "ns",
					name: "a",
					value: 2,
				});
			}).pipe(Effect.provide(InMemoryStateStorage)),
		),
	);

	test(
		"emits on create but not on a failed update",
		testEffect(
			Effect.gen(function* () {
				const storage = yield* StateStorageService;
				const dequeue = yield* storage.subscribe();

				yield* storage.create("ns", "a", 1);
				yield* storage.update("missing-ns", "x", 99).pipe(Effect.flip);
				yield* storage.update("ns", "a", 2);

				expect(yield* Queue.take(dequeue)).toEqual({
					namespace: "ns",
					name: "a",
					value: 1,
				});
				expect(yield* Queue.take(dequeue)).toEqual({
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
				const a = yield* storage.subscribe();
				const b = yield* storage.subscribe();

				yield* storage.update("ns", "a", 7);

				const expected = { namespace: "ns", name: "a", value: 7 };
				expect(yield* Queue.take(a)).toEqual(expected);
				expect(yield* Queue.take(b)).toEqual(expected);
			}).pipe(Effect.provide(InMemoryStateStorage)),
		),
	);

	test(
		"releases a subscription when its scope closes, leaving others intact",
		testEffect(
			Effect.gen(function* () {
				const storage = yield* StateStorageService;
				yield* storage.create("ns", "a", 0);
				const scope = yield* Scope.make();
				const scoped = yield* storage.subscribe().pipe(Scope.extend(scope));
				const other = yield* storage.subscribe();

				yield* storage.update("ns", "a", 1);
				const expected1 = { namespace: "ns", name: "a", value: 1 };
				expect(yield* Queue.take(scoped)).toEqual(expected1);
				expect(yield* Queue.take(other)).toEqual(expected1);

				yield* Scope.close(scope, Exit.void);
				expect(yield* Queue.isShutdown(scoped)).toBe(true);

				yield* storage.update("ns", "a", 2);
				expect(yield* Queue.take(other)).toEqual({
					namespace: "ns",
					name: "a",
					value: 2,
				});
				expect(
					Exit.isInterrupted(yield* Queue.take(scoped).pipe(Effect.exit)),
				).toBe(true);
			}).pipe(Effect.provide(InMemoryStateStorage)),
		),
	);
});
