import {
	defineNamespace,
	extendNamespace,
	type NamespaceManifest,
	type FieldManifest,
	StateEncodeError,
} from "@nodecg/core";
import { testEffect } from "@nodecg/internal/test-utils";
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

import {
	implementNamespace,
	loadExtendedNamespace,
	loadNamespace,
	loadNamespaceEffect,
} from "./load-namespace.ts";
import { stateFieldInternal } from "./load-namespace.ts";
import { InMemoryStateStorage } from "./services/state-storage/in-memory-state-storage.ts";
import {
	type StateChange,
	type StateStorage,
	StateStorageService,
} from "./services/state-storage/state-storage.ts";

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

describe("loadNamespaceEffect seeding", () => {
	test(
		"writes the encoded seed value when storage has none",
		testEffect(
			Effect.gen(function* () {
				const storageStub = createStorageStub();
				storageStub.read.mockReturnValue(Option.none());
				const manifest = defineNamespace("ns", {
					state: { count: { schema: Schema.Number } },
				});

				yield* loadNamespaceEffect(manifest, {
					seedState: { count: () => 42 },
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
				const manifest = defineNamespace("ns", {
					state: { count: { schema: Schema.Number } },
				});

				yield* loadNamespaceEffect(manifest, {
					seedState: {
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
				const manifest = defineNamespace("ns", {
					state: { count: { schema: Schema.Number } },
				});

				yield* loadNamespaceEffect(manifest, {
					seedState: { count: () => 0 },
				}).pipe(Effect.provideService(StateStorageService, storageStub));

				expect(storageStub.create).not.toHaveBeenCalled();
			}),
		),
	);

	test(
		"fails if encode rejects the seed value",
		testEffect(
			Effect.gen(function* () {
				const storageStub = createStorageStub();
				storageStub.read.mockReturnValue(Option.none());
				const field: FieldManifest<number> = {
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
					permission: {
						read: new Set(),
						write: new Set(),
						canRead: () => false,
						canWrite: () => false,
					},
				};
				const base = defineNamespace("ns", {
					state: { broken: { schema: Schema.Number } },
				});
				const manifest: NamespaceManifest<{ broken: number }, {}, {}> = {
					...base,
					state: { broken: field },
				};

				const error = yield* loadNamespaceEffect(manifest, {
					seedState: { broken: () => 42 },
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
				const manifest = defineNamespace("ns", {
					state: { count: { schema: Schema.Number } },
				});

				const loaded = yield* loadNamespaceEffect(manifest, {
					seedState: { count: () => 0 },
				}).pipe(Effect.provideService(StateStorageService, storageStub));

				expect(
					yield* loaded.state.count
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
				const manifest = defineNamespace("ns", {
					state: { count: { schema: Schema.Number } },
				});

				const loaded = yield* loadNamespaceEffect(manifest, {
					seedState: { count: () => 0 },
				}).pipe(Effect.provideService(StateStorageService, storageStub));

				const cause = yield* loaded.state.count
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
				const manifest = defineNamespace("ns", {
					state: { when: { schema: Schema.DateFromString } },
				});

				const loaded = yield* loadNamespaceEffect(manifest, {
					seedState: { when: () => new Date(0) },
				}).pipe(Effect.provideService(StateStorageService, storageStub));

				expect(
					yield* loaded.state.when
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
				const manifest = defineNamespace("ns", {
					state: { when: { schema: Schema.DateFromString } },
				});

				const loaded = yield* loadNamespaceEffect(manifest, {
					seedState: { when: () => new Date(0) },
				}).pipe(Effect.provideService(StateStorageService, storageStub));

				expect(
					yield* loaded.state.when[stateFieldInternal]
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
				const manifest = defineNamespace("ns", {
					state: { count: { schema: Schema.Number } },
				});

				const loaded = yield* loadNamespaceEffect(manifest, {
					seedState: { count: () => 0 },
				}).pipe(Effect.provideService(StateStorageService, storageStub));

				const cause = yield* loaded.state.count[stateFieldInternal]
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
				const manifest = defineNamespace("ns", {
					state: { count: { schema: Schema.Number } },
				});

				const loaded = yield* loadNamespaceEffect(manifest, {
					seedState: { count: () => 0 },
				}).pipe(Effect.provideService(StateStorageService, storageStub));

				yield* loaded.state.count
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
				const manifest = defineNamespace("ns", {
					state: { count: { schema: Schema.Number } },
				});

				const loaded = yield* loadNamespaceEffect(manifest, {
					seedState: { count: () => 0 },
				}).pipe(Effect.provideService(StateStorageService, storageStub));

				const error = yield* loaded.state.count
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
				const manifest = defineNamespace("ns", {
					state: { when: { schema: Schema.DateFromString } },
				});

				const loaded = yield* loadNamespaceEffect(manifest, {
					seedState: { when: () => new Date(0) },
				}).pipe(Effect.provideService(StateStorageService, storageStub));

				yield* loaded.state.when
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
				const manifest = defineNamespace("ns", {
					state: { count: { schema: Schema.Number } },
				});

				const loaded = yield* loadNamespaceEffect(manifest, {
					seedState: { count: () => 0 },
				}).pipe(Effect.provideService(StateStorageService, storageStub));

				yield* loaded.state.count
					.update((v) => v + 3)
					.pipe(Effect.provideService(StateStorageService, storageStub));
				expect(storageStub.update).toHaveBeenLastCalledWith("ns", "count", 13);
			}),
		),
	);
});

describe("loadNamespace (Promise wrapper)", () => {
	test("forwards to the injected storage", async () => {
		const storageStub = createStorageStub();
		storageStub.read.mockReturnValue(Option.some(42));
		const manifest = defineNamespace("ns", {
			state: { count: { schema: Schema.Number } },
		});

		const loaded = await loadNamespace(manifest, {
			seedState: { count: () => 0 },
			storage: storageStub,
		});

		expect(loaded.state.count.get()).toBe(42);
		loaded.state.count.set(9);
		expect(storageStub.update).toHaveBeenCalledWith("ns", "count", 9);
	});
});

describe("computed", () => {
	const computedManifest = defineNamespace("ns", {
		state: {
			games: { schema: Schema.Array(Schema.Struct({ id: Schema.String })) },
		},
		computed: { firstGameId: { schema: Schema.NullOr(Schema.String) } },
	});

	const firstGameId = (sources: {
		readonly games: readonly { readonly id: string }[];
	}) => sources.games[0]?.id ?? null;

	test(
		"get computes from the decoded source snapshot",
		testEffect(
			Effect.gen(function* () {
				const loaded = yield* loadNamespaceEffect(computedManifest, {
					seedState: { games: () => [] },
					implementComputed: { firstGameId },
				});

				expect(yield* loaded.computed.firstGameId.get()).toBe(null);

				yield* loaded.state.games.set([{ id: "a" }, { id: "b" }]);
				expect(yield* loaded.computed.firstGameId.get()).toBe("a");
			}).pipe(Effect.provide(InMemoryStateStorage)),
		),
	);

	test("is read-only (no set/update)", () => {
		expect("set" in computedManifest.computed.firstGameId).toBe(false);
	});

	test(
		"subscribe seeds, recomputes on source change, and dedupes unchanged values",
		testEffect(
			Effect.gen(function* () {
				const loaded = yield* loadNamespaceEffect(computedManifest, {
					seedState: { games: () => [] },
					implementComputed: { firstGameId },
				});

				const received: (string | null)[] = [];
				const fiber = yield* loaded.computed.firstGameId.subscribe().pipe(
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
				yield* loaded.state.games.set([{ id: "a" }]);
				yield* Effect.promise(() =>
					vi.waitFor(() => expect(received).toEqual([null, "a"])),
				);
				// Dedupes changes
				yield* loaded.state.games.set([{ id: "a" }, { id: "c" }]);
				yield* loaded.state.games.set([{ id: "b" }]);
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
				const error = yield* loadNamespaceEffect(computedManifest, {
					seedState: { games: () => [] },
					implementComputed: {
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
				const error = yield* loadNamespaceEffect(computedManifest, {
					seedState: { games: () => [] },
					implementComputed: { firstGameId: () => 42 as unknown as string },
				}).pipe(Effect.flip);
				expect(error._tag).toBe("StateEncodeError");
			}).pipe(Effect.provide(InMemoryStateStorage)),
		),
	);
});

describe("field subscribe", () => {
	const manifest = defineNamespace("ns", {
		state: {
			count: { schema: Schema.NumberFromString },
			other: { schema: Schema.NumberFromString },
		},
	});

	test(
		"[stateFieldInternal].subscribeEncoded emits raw JsonValue on set",
		testEffect(
			Effect.gen(function* () {
				const loaded = yield* loadNamespaceEffect(manifest, {
					seedState: { count: () => 0, other: () => 0 },
				});

				const stream =
					yield* loaded.state.count[stateFieldInternal].subscribeEncoded();
				yield* loaded.state.count.set(42);

				const events = yield* stream.pipe(Stream.take(2), Stream.runCollect);
				expect(Chunk.toArray(events)).toEqual(["0", "42"]);
			}).pipe(Effect.provide(InMemoryStateStorage)),
		),
	);

	test(
		"public subscribe emits decoded values on set",
		testEffect(
			Effect.gen(function* () {
				const loaded = yield* loadNamespaceEffect(manifest, {
					seedState: { count: () => 0, other: () => 0 },
				});

				const stream = yield* loaded.state.count.subscribe();
				yield* loaded.state.count.set(7);

				const events = yield* stream.pipe(Stream.take(2), Stream.runCollect);
				expect(Chunk.toArray(events)).toEqual([0, 7]);
			}).pipe(Effect.provide(InMemoryStateStorage)),
		),
	);

	test(
		"subscribe filters out updates to other fields",
		testEffect(
			Effect.gen(function* () {
				const loaded = yield* loadNamespaceEffect(manifest, {
					seedState: { count: () => 0, other: () => 0 },
				});

				const stream = yield* loaded.state.count.subscribe();
				yield* loaded.state.other.set(99);
				yield* loaded.state.count.set(3);

				const events = yield* stream.pipe(Stream.take(2), Stream.runCollect);
				expect(Chunk.toArray(events)).toEqual([0, 3]);
			}).pipe(Effect.provide(InMemoryStateStorage)),
		),
	);

	test(
		"subscribe emits update results too",
		testEffect(
			Effect.gen(function* () {
				const loaded = yield* loadNamespaceEffect(manifest, {
					seedState: { count: () => 5, other: () => 0 },
				});

				const stream = yield* loaded.state.count.subscribe();
				yield* loaded.state.count.update((v) => v + 3);

				const events = yield* stream.pipe(Stream.take(2), Stream.runCollect);
				expect(Chunk.toArray(events)).toEqual([5, 8]);
			}).pipe(Effect.provide(InMemoryStateStorage)),
		),
	);
});

describe("implementNamespace", () => {
	test("declares without storage, then load activates it", async () => {
		const ns = defineNamespace("ns", {
			state: { count: { schema: Schema.Number } },
		});

		const implemented = implementNamespace(ns, {
			seedState: { count: () => 7 },
		});

		const loaded = await implemented.load();
		expect(loaded.state.count.get()).toBe(7);
	});
});

describe("loadExtendedNamespace", () => {
	test("composes a base impl with the supplement and loads once", async () => {
		const base = defineNamespace("match", {
			state: {
				score: { schema: Schema.Number },
				label: { schema: Schema.String },
			},
		});
		const baseImplemented = implementNamespace(base, {
			seedState: { score: () => 10, label: () => "m1" },
		});

		const extended = extendNamespace(base, {
			state: { round: { schema: Schema.Number } },
			computed: { total: { schema: Schema.Number } },
		});

		const loaded = await loadExtendedNamespace(extended, baseImplemented, {
			seedState: { round: () => 3 },
			implementComputed: {
				total: (sources) => sources.score + sources.round,
			},
		});

		expect(loaded.state.score.get()).toBe(10);
		expect(loaded.state.round.get()).toBe(3);
		expect(loaded.computed.total.get()).toBe(13);
	});

	test("a new computed reads the original state", async () => {
		const base = defineNamespace("match", {
			state: { score: { schema: Schema.Number } },
		});
		const baseImplemented = implementNamespace(base, {
			seedState: { score: () => 5 },
		});

		const extended = extendNamespace(base, {
			computed: { doubled: { schema: Schema.Number } },
		});

		const loaded = await loadExtendedNamespace(extended, baseImplemented, {
			implementComputed: { doubled: (sources) => sources.score * 2 },
		});

		expect(loaded.computed.doubled.get()).toBe(10);
	});

	test("omitting impl for a newly-added field is a type error", async () => {
		const base = defineNamespace("match", {
			state: { score: { schema: Schema.Number } },
		});
		const baseImplemented = implementNamespace(base, {
			seedState: { score: () => 1 },
		});
		const extended = extendNamespace(base, {
			state: { round: { schema: Schema.Number } },
		});

		await expect(
			loadExtendedNamespace(extended, baseImplemented, {
				// @ts-expect-error missing seedState for the newly-added "round"
				seedState: {},
			}),
		).rejects.toThrow(/Missing seed value for state "round"/);
	});
});

describe("permission threading", () => {
	const manifest = defineNamespace("ns", {
		roles: { viewer: { permission: ["state-read", "computed-read"] } },
		state: {
			score: {
				schema: Schema.Number,
				permission: { read: { allow: ["viewer"] } },
			},
		},
		computed: { doubled: { schema: Schema.Number } },
	});

	test(
		"exposes each manifest field's baked permission on the loaded internal handle",
		testEffect(
			Effect.gen(function* () {
				const loaded = yield* loadNamespaceEffect(manifest, {
					seedState: { score: () => 1 },
					implementComputed: { doubled: (sources) => sources.score * 2 },
				});

				expect(loaded.state.score[stateFieldInternal].permission).toBe(
					manifest.state.score.permission,
				);
				expect(loaded.computed.doubled[stateFieldInternal].permission).toBe(
					manifest.computed.doubled.permission,
				);
			}).pipe(Effect.provide(InMemoryStateStorage)),
		),
	);
});
