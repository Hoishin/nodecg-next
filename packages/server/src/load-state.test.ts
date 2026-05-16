import {
	defineState,
	StateValidationError,
	type StateDefinition,
	type StateManifest,
} from "@nodecg/core";
import { testEffect } from "@nodecg/private";
import { Effect, Schema } from "effect";
import { describe, expect, test, vi } from "vitest";

import { loadState, loadStateEffect } from "./load-state";
import {
	StateNotFound,
	type StateStorage,
	StateStorageService,
} from "./state-storage";

const createStorageStub = () =>
	({
		read: vi.fn<StateStorage["read"]>(),
		create: vi.fn<StateStorage["create"]>(() => Effect.void),
		update: vi.fn<StateStorage["update"]>(() => Effect.void),
		persistInterval: 0,
	}) satisfies StateStorage;

describe("loadStateEffect seeding", () => {
	test(
		"writes the encoded initial value when storage has none",
		testEffect(
			Effect.gen(function* () {
				const storageStub = createStorageStub();
				storageStub.read.mockReturnValue(
					Effect.fail(new StateNotFound({ namespace: "ns", name: "count" })),
				);
				const manifest = defineState("ns", {
					count: { schema: Schema.Number },
				});

				yield* loadStateEffect({
					manifest,
					initialValues: { count: () => 42 },
				}).pipe(Effect.provideService(StateStorageService, storageStub));

				expect(storageStub.create).toHaveBeenCalledWith("ns", "count", 42);
				expect(storageStub.create).toHaveBeenCalledTimes(1);
			}),
		),
	);

	test(
		"supports an async thunk",
		testEffect(
			Effect.gen(function* () {
				const storageStub = createStorageStub();
				storageStub.read.mockReturnValue(
					Effect.fail(new StateNotFound({ namespace: "ns", name: "count" })),
				);
				const manifest = defineState("ns", {
					count: { schema: Schema.Number },
				});

				yield* loadStateEffect({
					manifest,
					initialValues: {
						count: async () => {
							await new Promise((resolve) => setTimeout(resolve, 1));
							return 7;
						},
					},
				}).pipe(Effect.provideService(StateStorageService, storageStub));

				expect(storageStub.create).toHaveBeenCalledWith("ns", "count", 7);
			}),
		),
	);

	test(
		"skips seeding when storage already has a value",
		testEffect(
			Effect.gen(function* () {
				const storageStub = createStorageStub();
				storageStub.read.mockReturnValue(Effect.succeed(5));
				const manifest = defineState("ns", {
					count: { schema: Schema.Number },
				});

				yield* loadStateEffect({
					manifest,
					initialValues: { count: () => 0 },
				}).pipe(Effect.provideService(StateStorageService, storageStub));

				expect(storageStub.create).not.toHaveBeenCalled();
			}),
		),
	);

	test(
		"fails if encode rejects the initial value",
		testEffect(
			Effect.gen(function* () {
				const storageStub = createStorageStub();
				storageStub.read.mockReturnValue(
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

				const error = yield* loadStateEffect({
					manifest,
					initialValues: { broken: () => 42 },
				}).pipe(
					Effect.provideService(StateStorageService, storageStub),
					Effect.flip,
				);
				expect(error._tag).toBe("StateValidationError");
			}),
		),
	);
});

describe("getValue", () => {
	test(
		"decodes the value returned by storage",
		testEffect(
			Effect.gen(function* () {
				const storageStub = createStorageStub();
				storageStub.read.mockReturnValue(Effect.succeed(42));
				const manifest = defineState("ns", {
					count: { schema: Schema.Number },
				});

				const state = yield* loadStateEffect({
					manifest,
					initialValues: { count: () => 0 },
				}).pipe(Effect.provideService(StateStorageService, storageStub));

				expect(
					yield* state.count
						.get()
						.pipe(Effect.provideService(StateStorageService, storageStub)),
				).toBe(42);
			}),
		),
	);

	test(
		"fails when the stored value does not match the schema",
		testEffect(
			Effect.gen(function* () {
				const storageStub = createStorageStub();
				storageStub.read.mockReturnValue(Effect.succeed("not a number"));
				const manifest = defineState("ns", {
					count: { schema: Schema.Number },
				});

				const state = yield* loadStateEffect({
					manifest,
					initialValues: { count: () => 0 },
				}).pipe(Effect.provideService(StateStorageService, storageStub));

				const error = yield* state.count
					.get()
					.pipe(
						Effect.provideService(StateStorageService, storageStub),
						Effect.flip,
					);
				expect(error._tag).toBe("GetStateError");
			}),
		),
	);

	test(
		"reads a stored string back into a Date",
		testEffect(
			Effect.gen(function* () {
				const storageStub = createStorageStub();
				storageStub.read.mockReturnValue(
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
						.get()
						.pipe(Effect.provideService(StateStorageService, storageStub)),
				).toEqual(new Date("2026-05-14T00:00:00.000Z"));
			}),
		),
	);
});

describe("set", () => {
	test(
		"encodes the value and writes it to storage",
		testEffect(
			Effect.gen(function* () {
				const storageStub = createStorageStub();
				storageStub.read.mockReturnValue(Effect.succeed(0));
				const manifest = defineState("ns", {
					count: { schema: Schema.Number },
				});

				const state = yield* loadStateEffect({
					manifest,
					initialValues: { count: () => 0 },
				}).pipe(Effect.provideService(StateStorageService, storageStub));

				yield* state.count
					.set(7)
					.pipe(Effect.provideService(StateStorageService, storageStub));
				expect(storageStub.update).toHaveBeenCalledWith("ns", "count", 7);
			}),
		),
	);

	test(
		"fails when the value fails schema validation",
		testEffect(
			Effect.gen(function* () {
				const storageStub = createStorageStub();
				storageStub.read.mockReturnValue(Effect.succeed(0));
				const manifest = defineState("ns", {
					count: { schema: Schema.Number },
				});

				const state = yield* loadStateEffect({
					manifest,
					initialValues: { count: () => 0 },
				}).pipe(Effect.provideService(StateStorageService, storageStub));

				const error = yield* state.count
					.set("not a number" as unknown as number)
					.pipe(
						Effect.provideService(StateStorageService, storageStub),
						Effect.flip,
					);
				expect(error._tag).toBe("UpdateStateError");
			}),
		),
	);

	test(
		"writes a Date to storage as a string",
		testEffect(
			Effect.gen(function* () {
				const storageStub = createStorageStub();
				storageStub.read.mockReturnValue(
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
				expect(storageStub.update).toHaveBeenLastCalledWith(
					"ns",
					"when",
					"2026-05-14T00:00:00.000Z",
				);
			}),
		),
	);
});

describe("update", () => {
	test(
		"reads the current value, applies the fn, and writes the result",
		testEffect(
			Effect.gen(function* () {
				const storageStub = createStorageStub();
				storageStub.read.mockReturnValue(Effect.succeed(10));
				const manifest = defineState("ns", {
					count: { schema: Schema.Number },
				});

				const state = yield* loadStateEffect({
					manifest,
					initialValues: { count: () => 0 },
				}).pipe(Effect.provideService(StateStorageService, storageStub));

				yield* state.count
					.update((v) => v + 3)
					.pipe(Effect.provideService(StateStorageService, storageStub));
				expect(storageStub.update).toHaveBeenLastCalledWith("ns", "count", 13);
			}),
		),
	);
});

describe("loadState (Promise wrapper)", () => {
	test("forwards to the injected storage", async () => {
		const storageStub = createStorageStub();
		storageStub.read.mockReturnValue(Effect.succeed(42));
		const manifest = defineState("ns", { count: { schema: Schema.Number } });

		const state = await loadState({
			manifest,
			initialValues: { count: () => 0 },
			storage: storageStub,
		});

		expect(await state.count.get()).toBe(42);
		await state.count.set(9);
		expect(storageStub.update).toHaveBeenCalledWith("ns", "count", 9);
	});
});
