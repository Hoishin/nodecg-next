import {
	defineState,
	StateEncodeError,
	type StateDefinition,
	type StateManifest,
} from "@nodecg/core";
import { testEffect } from "@nodecg/private";
import {
	Cause,
	Chunk,
	Effect,
	Fiber,
	Option,
	Queue,
	Schema,
	Stream,
} from "effect";
import { assert, describe, expect, test, vi } from "vitest";

import { loadState, loadStateEffect } from "./load-state.ts";
import { InMemoryStateStorage } from "./services/state-storage/in-memory-state-storage.ts";
import {
	type StateChange,
	type StateStorage,
	StateStorageService,
} from "./services/state-storage/state-storage.ts";
import { stateFieldInternal } from "./state-field.ts";

const createStorageStub = () =>
	({
		read: vi.fn<StateStorage["read"]>(() => Option.none()),
		create: vi.fn<StateStorage["create"]>(() => Effect.void),
		update: vi.fn<StateStorage["update"]>(() => Effect.void),
		subscribe: vi.fn<StateStorage["subscribe"]>(() =>
			Queue.unbounded<StateChange>(),
		),
		flush: vi.fn<StateStorage["flush"]>(() => Effect.void),
	}) satisfies StateStorage;

describe("loadStateEffect seeding", () => {
	test(
		"writes the encoded initial value when storage has none",
		testEffect(
			Effect.gen(function* () {
				const storageStub = createStorageStub();
				storageStub.read.mockReturnValue(Option.none());
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
				storageStub.read.mockReturnValue(Option.none());
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
				storageStub.read.mockReturnValue(Option.some(5));
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
				storageStub.read.mockReturnValue(Option.none());
				const definition: StateDefinition<number> = {
					name: "broken",
					encode: () =>
						Effect.fail(
							new StateEncodeError({
								fieldName: "broken",
								value: 42,
								cause: new Error("rejected on seed"),
							}),
						),
					decode: () => Effect.succeed(0),
				};
				const manifest: StateManifest<{ broken: typeof Schema.Number }> = {
					namespace: "ns",
					definitions: { broken: definition },
					computed: {},
				};

				const error = yield* loadStateEffect({
					manifest,
					initialValues: { broken: () => 42 },
				}).pipe(
					Effect.provideService(StateStorageService, storageStub),
					Effect.flip,
				);
				expect(error._tag).toBe("StateEncodeError");
			}),
		),
	);
});

describe("get", () => {
	test(
		"decodes the value returned by storage",
		testEffect(
			Effect.gen(function* () {
				const storageStub = createStorageStub();
				storageStub.read.mockReturnValue(Option.some(42));
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
				storageStub.read.mockReturnValue(Option.some("not a number"));
				const manifest = defineState("ns", {
					count: { schema: Schema.Number },
				});

				const state = yield* loadStateEffect({
					manifest,
					initialValues: { count: () => 0 },
				}).pipe(Effect.provideService(StateStorageService, storageStub));

				const cause = yield* state.count
					.get()
					.pipe(
						Effect.provideService(StateStorageService, storageStub),
						Effect.sandbox,
						Effect.flip,
					);
				const defect = Cause.dieOption(cause);
				assert(Option.isSome(defect));
				assert(defect.value instanceof Error);
				expect(defect.value.message).toContain(
					"Migration is not supported yet",
				);
			}),
		),
	);

	test(
		"reads a stored string back into a Date",
		testEffect(
			Effect.gen(function* () {
				const storageStub = createStorageStub();
				storageStub.read.mockReturnValue(
					Option.some("2026-05-14T00:00:00.000Z"),
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

describe("getEncoded", () => {
	test(
		"returns the re-encoded value after validating",
		testEffect(
			Effect.gen(function* () {
				const storageStub = createStorageStub();
				storageStub.read.mockReturnValue(
					Option.some("2026-05-14T00:00:00.000Z"),
				);
				const manifest = defineState("ns", {
					when: { schema: Schema.DateFromString },
				});

				const state = yield* loadStateEffect({
					manifest,
					initialValues: { when: () => new Date(0) },
				}).pipe(Effect.provideService(StateStorageService, storageStub));

				expect(
					yield* state.when[stateFieldInternal]
						.getEncoded()
						.pipe(Effect.provideService(StateStorageService, storageStub)),
				).toBe("2026-05-14T00:00:00.000Z");
			}),
		),
	);

	test(
		"dies when storage holds an unmatched value",
		testEffect(
			Effect.gen(function* () {
				const storageStub = createStorageStub();
				storageStub.read.mockReturnValue(Option.some("not a number"));
				const manifest = defineState("ns", {
					count: { schema: Schema.Number },
				});

				const state = yield* loadStateEffect({
					manifest,
					initialValues: { count: () => 0 },
				}).pipe(Effect.provideService(StateStorageService, storageStub));

				const cause = yield* state.count[stateFieldInternal]
					.getEncoded()
					.pipe(
						Effect.provideService(StateStorageService, storageStub),
						Effect.sandbox,
						Effect.flip,
					);
				const defect = Cause.dieOption(cause);
				assert(Option.isSome(defect));
				assert(defect.value instanceof Error);
				expect(defect.value.message).toContain(
					"Migration is not supported yet",
				);
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
				storageStub.read.mockReturnValue(Option.some(0));
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
				storageStub.read.mockReturnValue(Option.some(0));
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
				expect(error._tag).toBe("StateEncodeError");
			}),
		),
	);

	test(
		"writes a Date to storage as a string",
		testEffect(
			Effect.gen(function* () {
				const storageStub = createStorageStub();
				storageStub.read.mockReturnValue(
					Option.some("1970-01-01T00:00:00.000Z"),
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
				storageStub.read.mockReturnValue(Option.some(10));
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
		storageStub.read.mockReturnValue(Option.some(42));
		const manifest = defineState("ns", { count: { schema: Schema.Number } });

		const state = await loadState({
			manifest,
			initialValues: { count: () => 0 },
			storage: storageStub,
		});

		expect(state.count.get()).toBe(42);
		state.count.set(9);
		expect(storageStub.update).toHaveBeenCalledWith("ns", "count", 9);
	});
});

describe("computed", () => {
	const computedManifest = defineState(
		"ns",
		{
			games: {
				schema: Schema.Array(Schema.Struct({ id: Schema.String })),
			},
		},
		{ computed: { firstGameId: { schema: Schema.NullOr(Schema.String) } } },
	);

	const firstGameId = (sources: {
		readonly games: readonly { readonly id: string }[];
	}) => sources.games[0]?.id ?? null;

	test(
		"get computes from the decoded source snapshot",
		testEffect(
			Effect.gen(function* () {
				const state = yield* loadStateEffect({
					manifest: computedManifest,
					initialValues: { games: () => [] },
					computed: { firstGameId },
				});

				expect(yield* state.firstGameId.get()).toBe(null);

				yield* state.games.set([{ id: "a" }, { id: "b" }]);
				expect(yield* state.firstGameId.get()).toBe("a");
			}).pipe(Effect.provide(InMemoryStateStorage)),
		),
	);

	test("is read-only (no set/update)", () => {
		expect("set" in computedManifest.computed).toBe(false);
	});

	test(
		"subscribe seeds, recomputes on source change, and dedupes unchanged values",
		testEffect(
			Effect.gen(function* () {
				const state = yield* loadStateEffect({
					manifest: computedManifest,
					initialValues: { games: () => [] },
					computed: { firstGameId },
				});

				const received: (string | null)[] = [];
				const fiber = yield* state.firstGameId.subscribe().pipe(
					Effect.flatMap((stream) =>
						Stream.runForEach(stream, (value) =>
							Effect.sync(() => received.push(value)),
						),
					),
					Effect.fork,
				);

				yield* Effect.promise(() =>
					vi.waitFor(() => expect(received).toEqual([null])),
				);
				yield* state.games.set([{ id: "a" }]);
				yield* Effect.promise(() =>
					vi.waitFor(() => expect(received).toEqual([null, "a"])),
				);
				// firstGameId stays "a" — this change must be deduped away.
				yield* state.games.set([{ id: "a" }, { id: "c" }]);
				yield* state.games.set([{ id: "b" }]);
				yield* Effect.promise(() =>
					vi.waitFor(() => expect(received).toEqual([null, "a", "b"])),
				);

				yield* Fiber.interrupt(fiber);
			}).pipe(Effect.provide(InMemoryStateStorage)),
		),
	);

	test(
		"eager compute at load fails fast when compute throws",
		testEffect(
			Effect.gen(function* () {
				const error = yield* loadStateEffect({
					manifest: computedManifest,
					initialValues: { games: () => [] },
					computed: {
						firstGameId: () => {
							throw new Error("boom");
						},
					},
				}).pipe(Effect.flip);
				expect(error._tag).toBe("StateComputeError");
			}).pipe(Effect.provide(InMemoryStateStorage)),
		),
	);

	test(
		"eager compute at load fails fast when the computed value fails its schema",
		testEffect(
			Effect.gen(function* () {
				const error = yield* loadStateEffect({
					manifest: computedManifest,
					initialValues: { games: () => [] },
					computed: { firstGameId: () => 42 as unknown as string },
				}).pipe(Effect.flip);
				expect(error._tag).toBe("StateEncodeError");
			}).pipe(Effect.provide(InMemoryStateStorage)),
		),
	);
});

describe("field subscribe", () => {
	const manifest = defineState("ns", {
		count: { schema: Schema.NumberFromString },
		other: { schema: Schema.NumberFromString },
	});

	test(
		"[stateFieldInternal].subscribeEncoded emits raw JsonValue on set",
		testEffect(
			Effect.gen(function* () {
				const state = yield* loadStateEffect({
					manifest,
					initialValues: { count: () => 0, other: () => 0 },
				});

				const stream =
					yield* state.count[stateFieldInternal].subscribeEncoded();
				yield* state.count.set(42);

				const events = yield* stream.pipe(Stream.take(2), Stream.runCollect);
				expect(Chunk.toArray(events)).toEqual(["0", "42"]);
			}).pipe(Effect.provide(InMemoryStateStorage)),
		),
	);

	test(
		"public subscribe emits decoded values on set",
		testEffect(
			Effect.gen(function* () {
				const state = yield* loadStateEffect({
					manifest,
					initialValues: { count: () => 0, other: () => 0 },
				});

				const stream = yield* state.count.subscribe();
				yield* state.count.set(7);

				const events = yield* stream.pipe(Stream.take(2), Stream.runCollect);
				expect(Chunk.toArray(events)).toEqual([0, 7]);
			}).pipe(Effect.provide(InMemoryStateStorage)),
		),
	);

	test(
		"subscribe filters out updates to other fields",
		testEffect(
			Effect.gen(function* () {
				const state = yield* loadStateEffect({
					manifest,
					initialValues: { count: () => 0, other: () => 0 },
				});

				const stream = yield* state.count.subscribe();
				yield* state.other.set(99);
				yield* state.count.set(3);

				const events = yield* stream.pipe(Stream.take(2), Stream.runCollect);
				expect(Chunk.toArray(events)).toEqual([0, 3]);
			}).pipe(Effect.provide(InMemoryStateStorage)),
		),
	);

	test(
		"subscribe emits update results too",
		testEffect(
			Effect.gen(function* () {
				const state = yield* loadStateEffect({
					manifest,
					initialValues: { count: () => 5, other: () => 0 },
				});

				const stream = yield* state.count.subscribe();
				yield* state.count.update((v) => v + 3);

				const events = yield* stream.pipe(Stream.take(2), Stream.runCollect);
				expect(Chunk.toArray(events)).toEqual([5, 8]);
			}).pipe(Effect.provide(InMemoryStateStorage)),
		),
	);
});
