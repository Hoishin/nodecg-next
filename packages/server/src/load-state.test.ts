import {
	defineState,
	StateValidationError,
	type StateDefinition,
	type StateManifest,
} from "@nodecg/core";
import { testEffect } from "@nodecg/private";
import { Effect, Schema } from "effect";
import { expect, test, vi } from "vitest";

import { loadState, loadStateEffect } from "./load-state";
import {
	StateNotFound,
	type StateStorage,
	StateStorageService,
} from "./state-storage";

const createStorageStub = () =>
	({
		get: vi.fn<StateStorage["get"]>(),
		set: vi.fn<StateStorage["set"]>(() => Effect.void),
		update: vi.fn<StateStorage["update"]>(() => Effect.void),
		persistInterval: 0,
	}) satisfies StateStorage;

test(
	"seeds: encodes the initial value and writes it when storage has none",
	testEffect(
		Effect.gen(function* () {
			const storageStub = createStorageStub();
			storageStub.get.mockReturnValue(
				Effect.fail(new StateNotFound({ namespace: "ns", name: "count" })),
			);
			const manifest = defineState("ns", { count: { schema: Schema.Number } });

			yield* loadStateEffect({
				manifest,
				initialValues: { count: () => 42 },
			}).pipe(Effect.provideService(StateStorageService, storageStub));

			expect(storageStub.set).toHaveBeenCalledWith("ns", "count", 42);
			expect(storageStub.set).toHaveBeenCalledTimes(1);
		}),
	),
);

test(
	"seeds via an async thunk",
	testEffect(
		Effect.gen(function* () {
			const storageStub = createStorageStub();
			storageStub.get.mockReturnValue(
				Effect.fail(new StateNotFound({ namespace: "ns", name: "count" })),
			);
			const manifest = defineState("ns", { count: { schema: Schema.Number } });

			yield* loadStateEffect({
				manifest,
				initialValues: {
					count: async () => {
						await new Promise((resolve) => setTimeout(resolve, 1));
						return 7;
					},
				},
			}).pipe(Effect.provideService(StateStorageService, storageStub));

			expect(storageStub.set).toHaveBeenCalledWith("ns", "count", 7);
		}),
	),
);

test(
	"does not seed when storage already has a value",
	testEffect(
		Effect.gen(function* () {
			const storageStub = createStorageStub();
			storageStub.get.mockReturnValue(Effect.succeed(5));
			const manifest = defineState("ns", { count: { schema: Schema.Number } });

			yield* loadStateEffect({
				manifest,
				initialValues: { count: () => 0 },
			}).pipe(Effect.provideService(StateStorageService, storageStub));

			expect(storageStub.set).not.toHaveBeenCalled();
		}),
	),
);

test(
	"seeding fails if encode rejects the initial value",
	testEffect(
		Effect.gen(function* () {
			const storageStub = createStorageStub();
			storageStub.get.mockReturnValue(
				Effect.fail(new StateNotFound({ namespace: "ns", name: "broken" })),
			);
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
				namespace: "ns",
				definitions: { broken: definition },
			};

			const result = yield* Effect.either(
				loadStateEffect({
					manifest,
					initialValues: { broken: () => 42 },
				}).pipe(Effect.provideService(StateStorageService, storageStub)),
			);
			expect(result._tag).toBe("Left");
		}),
	),
);

test(
	"getValue decodes the value returned by storage",
	testEffect(
		Effect.gen(function* () {
			const storageStub = createStorageStub();
			storageStub.get.mockReturnValue(Effect.succeed(42));
			const manifest = defineState("ns", { count: { schema: Schema.Number } });

			const state = yield* loadStateEffect({
				manifest,
				initialValues: { count: () => 0 },
			}).pipe(Effect.provideService(StateStorageService, storageStub));

			expect(
				yield* state.count
					.getValue()
					.pipe(Effect.provideService(StateStorageService, storageStub)),
			).toBe(42);
		}),
	),
);

test(
	"getValue fails when storage returns undecodable data",
	testEffect(
		Effect.gen(function* () {
			const storageStub = createStorageStub();
			storageStub.get.mockReturnValue(Effect.succeed("not a number"));
			const manifest = defineState("ns", { count: { schema: Schema.Number } });

			const state = yield* loadStateEffect({
				manifest,
				initialValues: { count: () => 0 },
			}).pipe(Effect.provideService(StateStorageService, storageStub));

			const result = yield* Effect.either(
				state.count
					.getValue()
					.pipe(Effect.provideService(StateStorageService, storageStub)),
			);
			expect(result._tag).toBe("Left");
		}),
	),
);

test(
	"set encodes the value and writes it to storage",
	testEffect(
		Effect.gen(function* () {
			const storageStub = createStorageStub();
			storageStub.get.mockReturnValue(Effect.succeed(0));
			const manifest = defineState("ns", { count: { schema: Schema.Number } });

			const state = yield* loadStateEffect({
				manifest,
				initialValues: { count: () => 0 },
			}).pipe(Effect.provideService(StateStorageService, storageStub));

			yield* state.count
				.set(7)
				.pipe(Effect.provideService(StateStorageService, storageStub));
			expect(storageStub.set).toHaveBeenCalledWith("ns", "count", 7);
		}),
	),
);

test(
	"set fails when the value fails schema validation",
	testEffect(
		Effect.gen(function* () {
			const storageStub = createStorageStub();
			storageStub.get.mockReturnValue(Effect.succeed(0));
			const manifest = defineState("ns", { count: { schema: Schema.Number } });

			const state = yield* loadStateEffect({
				manifest,
				initialValues: { count: () => 0 },
			}).pipe(Effect.provideService(StateStorageService, storageStub));

			const result = yield* Effect.either(
				state.count
					.set("not a number" as unknown as number)
					.pipe(Effect.provideService(StateStorageService, storageStub)),
			);
			expect(result._tag).toBe("Left");
		}),
	),
);

test(
	"update reads the current value, applies the fn, and writes the result",
	testEffect(
		Effect.gen(function* () {
			const storageStub = createStorageStub();
			storageStub.get.mockReturnValue(Effect.succeed(10));
			const manifest = defineState("ns", { count: { schema: Schema.Number } });

			const state = yield* loadStateEffect({
				manifest,
				initialValues: { count: () => 0 },
			}).pipe(Effect.provideService(StateStorageService, storageStub));

			yield* state.count
				.update((v) => v + 3)
				.pipe(Effect.provideService(StateStorageService, storageStub));
			expect(storageStub.set).toHaveBeenLastCalledWith("ns", "count", 13);
		}),
	),
);

test(
	"codec encodes to the wire form on write",
	testEffect(
		Effect.gen(function* () {
			const storageStub = createStorageStub();
			storageStub.get.mockReturnValue(
				Effect.succeed("1970-01-01T00:00:00.000Z"),
			);
			const manifest = defineState("ns", {
				when: { schema: Schema.DateFromString },
			});

			const state = yield* loadStateEffect({
				manifest,
				initialValues: { when: () => new Date(0) },
			}).pipe(Effect.provideService(StateStorageService, storageStub));

			yield* state.when
				.set(new Date("2026-05-14T00:00:00.000Z"))
				.pipe(Effect.provideService(StateStorageService, storageStub));
			expect(storageStub.set).toHaveBeenLastCalledWith(
				"ns",
				"when",
				"2026-05-14T00:00:00.000Z",
			);
		}),
	),
);

test(
	"codec decodes from the wire form on read",
	testEffect(
		Effect.gen(function* () {
			const storageStub = createStorageStub();
			storageStub.get.mockReturnValue(
				Effect.succeed("2026-05-14T00:00:00.000Z"),
			);
			const manifest = defineState("ns", {
				when: { schema: Schema.DateFromString },
			});

			const state = yield* loadStateEffect({
				manifest,
				initialValues: { when: () => new Date(0) },
			}).pipe(Effect.provideService(StateStorageService, storageStub));

			expect(
				yield* state.when
					.getValue()
					.pipe(Effect.provideService(StateStorageService, storageStub)),
			).toEqual(new Date("2026-05-14T00:00:00.000Z"));
		}),
	),
);

test("loadState — Promise wrapper forwards to the injected storage", async () => {
	const storageStub = createStorageStub();
	storageStub.get.mockReturnValue(Effect.succeed(42));
	const manifest = defineState("ns", { count: { schema: Schema.Number } });

	const state = await loadState({
		manifest,
		initialValues: { count: () => 0 },
		storage: storageStub,
	});

	expect(await state.count.getValue()).toBe(42);
	await state.count.set(9);
	expect(storageStub.set).toHaveBeenCalledWith("ns", "count", 9);
});
