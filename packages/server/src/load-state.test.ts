import {
	defineState,
	StateValidationError,
	type StateDefinition,
	type StateManifest,
} from "@nodecg/core";
import { testEffect } from "@nodecg/private";
import { Effect, Schema } from "effect";
import { expect, test } from "vitest";

import {
	createInMemoryStateStorage,
	InMemoryStateStorage,
} from "./in-memory-state-storage";
import { loadState, loadStateEffect } from "./load-state";
import { StateStorageService } from "./state-storage-service";

// Basic loadState smoke test (Promise wrapper)
test("loadState — Promise wrapper end-to-end", async () => {
	const manifest = defineState("test-loadstate-basic", {
		count: { schema: Schema.Number },
	});
	const state = await loadState({
		manifest,
		initialValues: { count: () => 42 },
	});

	expect(await state.count.getValue()).toBe(42);
});

// Detailed behavior tests use loadStateEffect
test(
	"loadStateEffect seeds the initial value from the provided thunk",
	testEffect(
		Effect.gen(function* () {
			const manifest = defineState("test-default", {
				count: { schema: Schema.Number },
			});
			const state = yield* loadStateEffect({
				manifest,
				initialValues: { count: () => 42 },
			});

			const value = yield* state.count.getValue();
			expect(value).toBe(42);
		}).pipe(Effect.provide(InMemoryStateStorage)),
	),
);

test(
	"loadStateEffect seeds via an async thunk",
	testEffect(
		Effect.gen(function* () {
			const manifest = defineState("test-async-seed", {
				count: { schema: Schema.Number },
			});
			const state = yield* loadStateEffect({
				manifest,
				initialValues: {
					count: async () => {
						await new Promise((resolve) => setTimeout(resolve, 1));
						return 7;
					},
				},
			});

			const value = yield* state.count.getValue();
			expect(value).toBe(7);
		}).pipe(Effect.provide(InMemoryStateStorage)),
	),
);

test(
	"set overrides the seeded value",
	testEffect(
		Effect.gen(function* () {
			const manifest = defineState("test-set", {
				count: { schema: Schema.Number },
			});
			const state = yield* loadStateEffect({
				manifest,
				initialValues: { count: () => 0 },
			});

			yield* state.count.set(7);
			expect(yield* state.count.getValue()).toBe(7);
		}).pipe(Effect.provide(InMemoryStateStorage)),
	),
);

test(
	"update transforms the current value",
	testEffect(
		Effect.gen(function* () {
			const manifest = defineState("test-update", {
				count: { schema: Schema.Number },
			});
			const state = yield* loadStateEffect({
				manifest,
				initialValues: { count: () => 10 },
			});

			yield* state.count.update((v) => v + 3);
			expect(yield* state.count.getValue()).toBe(13);
		}).pipe(Effect.provide(InMemoryStateStorage)),
	),
);

test(
	"set fails with Effect failure when value fails schema validation",
	testEffect(
		Effect.gen(function* () {
			const manifest = defineState("test-validate-effect", {
				count: { schema: Schema.Number },
			});
			const state = yield* loadStateEffect({
				manifest,
				initialValues: { count: () => 0 },
			});

			const result = yield* Effect.either(
				state.count.set("not a number" as unknown as number),
			);
			expect(result._tag).toBe("Left");
		}).pipe(Effect.provide(InMemoryStateStorage)),
	),
);

test(
	"getValue fails with Effect failure when store has bad data",
	testEffect(
		Effect.gen(function* () {
			const storage = createInMemoryStateStorage();
			const provideStorage = Effect.provideService(
				StateStorageService,
				storage,
			);
			const manifest = defineState("test-effect-decode-fail", {
				count: { schema: Schema.Number },
			});
			const state = yield* loadStateEffect({
				manifest,
				initialValues: { count: () => 0 },
			}).pipe(provideStorage);

			yield* storage.set(
				"test-effect-decode-fail",
				"count",
				"not a number",
			);

			const result = yield* Effect.either(
				state.count.getValue().pipe(provideStorage),
			);
			expect(result._tag).toBe("Left");
		}),
	),
);

test(
	"loadStateEffect fails if encode rejects the initial value",
	testEffect(
		Effect.gen(function* () {
			const definition: StateDefinition<number> = {
				name: "broken",
				encode: () =>
					Effect.fail(
						new StateValidationError({
							name: "broken",
							cause: "rejected on seed",
						}),
					),
				decode: () => Effect.succeed(0),
			};
			const manifest: StateManifest<{ broken: typeof Schema.Number }> = {
				namespace: "test-encode-seed-fail",
				definitions: { broken: definition },
			};

			const result = yield* Effect.either(
				loadStateEffect({
					manifest,
					initialValues: { broken: () => 42 },
				}),
			);
			expect(result._tag).toBe("Left");
		}).pipe(Effect.provide(InMemoryStateStorage)),
	),
);

test(
	"bidirectional codec round-trips via wire storage",
	testEffect(
		Effect.gen(function* () {
			const storage = createInMemoryStateStorage();
			const provideStorage = Effect.provideService(
				StateStorageService,
				storage,
			);
			const manifest = defineState("test-codec", {
				when: { schema: Schema.DateFromString },
			});
			const state = yield* loadStateEffect({
				manifest,
				initialValues: { when: () => new Date(0) },
			}).pipe(provideStorage);

			expect(yield* state.when.getValue().pipe(provideStorage)).toEqual(
				new Date(0),
			);

			const newDate = new Date("2026-05-14T00:00:00.000Z");
			yield* state.when.set(newDate).pipe(provideStorage);

			const wire = yield* storage.get("test-codec", "when");
			expect(wire).toBe("2026-05-14T00:00:00.000Z");
			expect(yield* state.when.getValue().pipe(provideStorage)).toEqual(
				newDate,
			);
		}),
	),
);
