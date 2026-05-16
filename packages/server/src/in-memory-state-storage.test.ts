import { testEffect } from "@nodecg/private";
import { Effect } from "effect";
import { expect, test } from "vitest";

import { InMemoryStateStorage } from "./in-memory-state-storage";
import { StateStorageService } from "./state-storage";

test(
	"get on a missing key fails with StateNotFound",
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

test(
	"set then get round-trips the value (and creates the namespace)",
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
	"set overwrites an existing value",
	testEffect(
		Effect.gen(function* () {
			const storage = yield* StateStorageService;
			yield* storage.set("ns", "a", 1);
			yield* storage.set("ns", "a", 2);
			expect(yield* storage.get("ns", "a")).toBe(2);
		}).pipe(Effect.provide(InMemoryStateStorage)),
	),
);

test(
	"update overwrites an existing value",
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
	"update on a missing key fails with StateNotFound",
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

test(
	"exposes a persistInterval",
	testEffect(
		Effect.gen(function* () {
			const storage = yield* StateStorageService;
			expect(storage.persistInterval).toBe(0);
		}).pipe(Effect.provide(InMemoryStateStorage)),
	),
);
