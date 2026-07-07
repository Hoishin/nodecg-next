import {
	defineNamespace,
	extendNamespace,
	type NamespaceManifest,
	type FieldManifest,
	StateEncodeError,
} from "@nodecg/core";
import { CurrentIdentity, AnonymousIdentitySchema } from "@nodecg/internal";
import { testEffect } from "@nodecg/internal/test-utils";
import {
	Cause,
	Chunk,
	Effect,
	Fiber,
	Layer,
	Option,
	Queue,
	Schema,
	Stream,
} from "effect";
import type { Promisable } from "type-fest";
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
import { InMemoryTopicBroker } from "./services/topic-broker/in-memory-topic-broker.ts";
import {
	type TopicBroker,
	type TopicMessage,
	TopicBrokerService,
} from "./services/topic-broker/topic-broker.ts";

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

const createBrokerStub = () =>
	({
		publish: vi.fn<TopicBroker["publish"]>(() => Effect.void),
		subscribe: vi.fn<TopicBroker["subscribe"]>(() =>
			Effect.succeed(Stream.empty),
		),
	}) satisfies TopicBroker;

const anonymous = AnonymousIdentitySchema.make();

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
				}).pipe(
					Effect.provideService(StateStorageService, storageStub),
					Effect.provide(InMemoryTopicBroker),
				);

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
				}).pipe(
					Effect.provideService(StateStorageService, storageStub),
					Effect.provide(InMemoryTopicBroker),
				);

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
				}).pipe(
					Effect.provideService(StateStorageService, storageStub),
					Effect.provide(InMemoryTopicBroker),
				);

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
					Effect.provide(InMemoryTopicBroker),
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
				}).pipe(
					Effect.provideService(StateStorageService, storageStub),
					Effect.provide(InMemoryTopicBroker),
				);

				expect(
					yield* loaded.state.count
						.get()
						.pipe(
							Effect.provideService(StateStorageService, storageStub),
							Effect.provide(InMemoryTopicBroker),
						),
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
				}).pipe(
					Effect.provideService(StateStorageService, storageStub),
					Effect.provide(InMemoryTopicBroker),
				);

				const cause = yield* loaded.state.count
					.get()
					.pipe(
						Effect.provideService(StateStorageService, storageStub),
						Effect.provide(InMemoryTopicBroker),
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
				}).pipe(
					Effect.provideService(StateStorageService, storageStub),
					Effect.provide(InMemoryTopicBroker),
				);

				expect(
					yield* loaded.state.when
						.get()
						.pipe(
							Effect.provideService(StateStorageService, storageStub),
							Effect.provide(InMemoryTopicBroker),
						),
				).toEqual(new Date("2026-05-14T00:00:00.000Z"));
			}),
		),
	);
});

describe("getEncodedNoAuth", () => {
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
				}).pipe(
					Effect.provideService(StateStorageService, storageStub),
					Effect.provide(InMemoryTopicBroker),
				);

				expect(
					yield* loaded.state.when[stateFieldInternal]
						.getEncodedNoAuth()
						.pipe(
							Effect.provideService(StateStorageService, storageStub),
							Effect.provide(InMemoryTopicBroker),
						),
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
				}).pipe(
					Effect.provideService(StateStorageService, storageStub),
					Effect.provide(InMemoryTopicBroker),
				);

				const cause = yield* loaded.state.count[stateFieldInternal]
					.getEncodedNoAuth()
					.pipe(
						Effect.provideService(StateStorageService, storageStub),
						Effect.provide(InMemoryTopicBroker),
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
				}).pipe(
					Effect.provideService(StateStorageService, storageStub),
					Effect.provide(InMemoryTopicBroker),
				);

				yield* loaded.state.count
					.set(7)
					.pipe(
						Effect.provideService(StateStorageService, storageStub),
						Effect.provide(InMemoryTopicBroker),
					);
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
				}).pipe(
					Effect.provideService(StateStorageService, storageStub),
					Effect.provide(InMemoryTopicBroker),
				);

				const error = yield* loaded.state.count
					.set("not a number" as unknown as number)
					.pipe(
						Effect.provideService(StateStorageService, storageStub),
						Effect.provide(InMemoryTopicBroker),
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
				}).pipe(
					Effect.provideService(StateStorageService, storageStub),
					Effect.provide(InMemoryTopicBroker),
				);

				yield* loaded.state.when
					.set(new Date("2026-05-14T00:00:00.000Z"))
					.pipe(
						Effect.provideService(StateStorageService, storageStub),
						Effect.provide(InMemoryTopicBroker),
					);
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
				}).pipe(
					Effect.provideService(StateStorageService, storageStub),
					Effect.provide(InMemoryTopicBroker),
				);

				yield* loaded.state.count
					.update((v) => v + 3)
					.pipe(
						Effect.provideService(StateStorageService, storageStub),
						Effect.provide(InMemoryTopicBroker),
					);
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
			}).pipe(
				Effect.provide(Layer.merge(InMemoryStateStorage, InMemoryTopicBroker)),
			),
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
			}).pipe(
				Effect.provide(Layer.merge(InMemoryStateStorage, InMemoryTopicBroker)),
			),
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
			}).pipe(
				Effect.provide(Layer.merge(InMemoryStateStorage, InMemoryTopicBroker)),
			),
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
			}).pipe(
				Effect.provide(Layer.merge(InMemoryStateStorage, InMemoryTopicBroker)),
			),
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
			}).pipe(
				Effect.provide(Layer.merge(InMemoryStateStorage, InMemoryTopicBroker)),
			),
		),
	);

	test(
		"anonymous subscribe emits decoded values on set",
		testEffect(
			Effect.gen(function* () {
				const loaded = yield* loadNamespaceEffect(manifest, {
					seedState: { count: () => 0, other: () => 0 },
				});

				const stream = yield* loaded.state.count.subscribe();
				yield* loaded.state.count.set(7);

				const events = yield* stream.pipe(Stream.take(2), Stream.runCollect);
				expect(Chunk.toArray(events)).toEqual([0, 7]);
			}).pipe(
				Effect.provide(Layer.merge(InMemoryStateStorage, InMemoryTopicBroker)),
			),
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
			}).pipe(
				Effect.provide(Layer.merge(InMemoryStateStorage, InMemoryTopicBroker)),
			),
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
			}).pipe(
				Effect.provide(Layer.merge(InMemoryStateStorage, InMemoryTopicBroker)),
			),
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
			}).pipe(
				Effect.provide(Layer.merge(InMemoryStateStorage, InMemoryTopicBroker)),
			),
		),
	);
});

describe("encoded read/write enforce permission", () => {
	const manifest = defineNamespace("ns", {
		state: {
			open: {
				schema: Schema.Number,
				permission: {
					read: { allow: ["anonymous"] },
					write: { allow: ["anonymous"] },
				},
			},
			locked: { schema: Schema.Number },
		},
		computed: {
			openComputed: {
				schema: Schema.Number,
				permission: { read: { allow: ["anonymous"] } },
			},
			lockedComputed: { schema: Schema.Number },
		},
	});

	const load = (storageStub: ReturnType<typeof createStorageStub>) =>
		loadNamespaceEffect(manifest, {
			seedState: { open: () => 0, locked: () => 0 },
			implementComputed: {
				openComputed: (sources) => sources.open,
				lockedComputed: (sources) => sources.locked,
			},
		}).pipe(
			Effect.provideService(StateStorageService, storageStub),
			Effect.provide(InMemoryTopicBroker),
		);

	test(
		"getEncoded returns the value for an allowed caller",
		testEffect(
			Effect.gen(function* () {
				const storageStub = createStorageStub();
				storageStub.read.mockReturnValue(Option.some(42));
				const loaded = yield* load(storageStub);
				expect(
					yield* loaded.state.open[stateFieldInternal]
						.getEncoded()
						.pipe(
							Effect.provideService(StateStorageService, storageStub),
							Effect.provide(InMemoryTopicBroker),
							Effect.provideService(CurrentIdentity, anonymous),
						),
				).toBe(42);
			}),
		),
	);

	test(
		"getEncoded fails PermissionDenied for a denied caller",
		testEffect(
			Effect.gen(function* () {
				const storageStub = createStorageStub();
				storageStub.read.mockReturnValue(Option.some(42));
				const loaded = yield* load(storageStub);
				const error = yield* loaded.state.locked[stateFieldInternal]
					.getEncoded()
					.pipe(
						Effect.provideService(StateStorageService, storageStub),
						Effect.provide(InMemoryTopicBroker),
						Effect.provideService(CurrentIdentity, anonymous),
						Effect.flip,
					);
				expect(error._tag).toBe("PermissionDenied");
			}),
		),
	);

	test(
		"setEncoded writes for an allowed caller",
		testEffect(
			Effect.gen(function* () {
				const storageStub = createStorageStub();
				storageStub.read.mockReturnValue(Option.some(0));
				const loaded = yield* load(storageStub);
				yield* loaded.state.open[stateFieldInternal]
					.setEncoded(7)
					.pipe(
						Effect.provideService(StateStorageService, storageStub),
						Effect.provide(InMemoryTopicBroker),
						Effect.provideService(CurrentIdentity, anonymous),
					);
				expect(storageStub.update).toHaveBeenCalledWith("ns", "open", 7);
			}),
		),
	);

	test(
		"setEncoded fails PermissionDenied and does not write for a denied caller",
		testEffect(
			Effect.gen(function* () {
				const storageStub = createStorageStub();
				storageStub.read.mockReturnValue(Option.some(0));
				const loaded = yield* load(storageStub);
				const error = yield* loaded.state.locked[stateFieldInternal]
					.setEncoded(7)
					.pipe(
						Effect.provideService(StateStorageService, storageStub),
						Effect.provide(InMemoryTopicBroker),
						Effect.provideService(CurrentIdentity, anonymous),
						Effect.flip,
					);
				expect(error._tag).toBe("PermissionDenied");
				expect(storageStub.update).not.toHaveBeenCalledWith("ns", "locked", 7);
			}),
		),
	);

	test(
		"computed getEncoded fails PermissionDenied for a denied caller",
		testEffect(
			Effect.gen(function* () {
				const storageStub = createStorageStub();
				storageStub.read.mockReturnValue(Option.some(0));
				const loaded = yield* load(storageStub);
				const error = yield* loaded.computed.lockedComputed[stateFieldInternal]
					.getEncoded()
					.pipe(
						Effect.provideService(StateStorageService, storageStub),
						Effect.provide(InMemoryTopicBroker),
						Effect.provideService(CurrentIdentity, anonymous),
						Effect.flip,
					);
				expect(error._tag).toBe("PermissionDenied");
			}),
		),
	);
});

describe("topic", () => {
	const manifest = defineNamespace("ns", {
		roles: { chatter: { permission: ["topic-subscribe", "topic-publish"] } },
		topic: {
			open: {
				schema: Schema.NumberFromString,
				permission: {
					read: { allow: ["anonymous"] },
					write: { allow: ["anonymous"] },
				},
			},
			locked: { schema: Schema.NumberFromString },
		},
	});

	const load = (brokerStub: ReturnType<typeof createBrokerStub>) =>
		loadNamespaceEffect(manifest).pipe(
			Effect.provideService(StateStorageService, createStorageStub()),
			Effect.provideService(TopicBrokerService, brokerStub),
		);

	test(
		"publish encodes the value and forwards it to the broker",
		testEffect(
			Effect.gen(function* () {
				const brokerStub = createBrokerStub();
				const loaded = yield* load(brokerStub);
				yield* loaded.topic.open.publish(42);
				expect(brokerStub.publish).toHaveBeenCalledWith("ns", "open", "42");
			}),
		),
	);

	test(
		"subscribeEncoded streams only the matching field's messages",
		testEffect(
			Effect.gen(function* () {
				const brokerStub = createBrokerStub();
				brokerStub.subscribe.mockReturnValue(
					Effect.succeed(
						Stream.fromIterable<TopicMessage>([
							{ namespace: "ns", name: "locked", value: "1" },
							{ namespace: "ns", name: "open", value: "2" },
							{ namespace: "other", name: "open", value: "3" },
						]),
					),
				);
				const loaded = yield* load(brokerStub);
				const stream =
					yield* loaded.topic.open[stateFieldInternal].subscribeEncoded();
				const events = yield* stream.pipe(Stream.runCollect);
				expect(Chunk.toArray(events)).toEqual(["2"]);
			}),
		),
	);

	test(
		"subscribe decodes the matching messages",
		testEffect(
			Effect.gen(function* () {
				const brokerStub = createBrokerStub();
				brokerStub.subscribe.mockReturnValue(
					Effect.succeed(
						Stream.fromIterable<TopicMessage>([
							{ namespace: "ns", name: "open", value: "7" },
						]),
					),
				);
				const loaded = yield* load(brokerStub);
				const stream = yield* loaded.topic.open.subscribe();
				const events = yield* stream.pipe(Stream.runCollect);
				expect(Chunk.toArray(events)).toEqual([7]);
			}),
		),
	);

	test(
		"publishEncoded forwards the value for an allowed caller",
		testEffect(
			Effect.gen(function* () {
				const brokerStub = createBrokerStub();
				const loaded = yield* load(brokerStub);
				yield* loaded.topic.open[stateFieldInternal]
					.publishEncoded("5")
					.pipe(Effect.provideService(CurrentIdentity, anonymous));
				expect(brokerStub.publish).toHaveBeenCalledWith("ns", "open", "5");
			}),
		),
	);

	test(
		"publishEncoded fails PermissionDenied and does not publish for a denied caller",
		testEffect(
			Effect.gen(function* () {
				const brokerStub = createBrokerStub();
				const loaded = yield* load(brokerStub);
				const error = yield* loaded.topic.locked[stateFieldInternal]
					.publishEncoded("5")
					.pipe(Effect.provideService(CurrentIdentity, anonymous), Effect.flip);
				expect(error._tag).toBe("PermissionDenied");
				expect(brokerStub.publish).not.toHaveBeenCalled();
			}),
		),
	);

	test(
		"publishEncoded fails when the value fails schema validation",
		testEffect(
			Effect.gen(function* () {
				const brokerStub = createBrokerStub();
				const loaded = yield* load(brokerStub);
				const error = yield* loaded.topic.open[stateFieldInternal]
					.publishEncoded(42)
					.pipe(Effect.provideService(CurrentIdentity, anonymous), Effect.flip);
				expect(error._tag).toBe("StateDecodeError");
				expect(brokerStub.publish).not.toHaveBeenCalled();
			}),
		),
	);
});

describe("rpc", () => {
	const manifest = defineNamespace("ns", {
		rpc: {
			echo: {
				schema: {
					request: Schema.NumberFromString,
					response: Schema.NumberFromString,
				},
				permission: { write: { allow: ["anonymous"] } },
			},
			locked: {
				schema: { request: Schema.String, response: Schema.String },
			},
		},
	});

	const load = (handlers: {
		echo: (request: number) => Promisable<number>;
		locked: (request: string) => Promisable<string>;
	}) =>
		loadNamespaceEffect(manifest, { implementRpc: handlers }).pipe(
			Effect.provideService(StateStorageService, createStorageStub()),
			Effect.provideService(TopicBrokerService, createBrokerStub()),
		);

	test(
		"call decodes the request, runs the handler, and encodes the response",
		testEffect(
			Effect.gen(function* () {
				const echo = vi.fn((request: number) => request * 2);
				const loaded = yield* load({ echo, locked: (request) => request });
				const result = yield* loaded.rpc.echo[stateFieldInternal]
					.callEncoded("21")
					.pipe(Effect.provideService(CurrentIdentity, anonymous));
				expect(echo).toHaveBeenCalledWith(21);
				expect(result).toBe("42");
			}),
		),
	);

	test(
		"call awaits an async handler",
		testEffect(
			Effect.gen(function* () {
				const loaded = yield* load({
					echo: async (request) => {
						await new Promise((resolve) => setTimeout(resolve, 1));
						return request + 1;
					},
					locked: (request) => request,
				});
				const result = yield* loaded.rpc.echo[stateFieldInternal]
					.callEncoded("4")
					.pipe(Effect.provideService(CurrentIdentity, anonymous));
				expect(result).toBe("5");
			}),
		),
	);

	test(
		"call fails PermissionDenied for a caller without rpc-call",
		testEffect(
			Effect.gen(function* () {
				const loaded = yield* load({
					echo: (request) => request,
					locked: (request) => request,
				});
				const error = yield* loaded.rpc.locked[stateFieldInternal]
					.callEncoded("x")
					.pipe(Effect.provideService(CurrentIdentity, anonymous), Effect.flip);
				expect(error._tag).toBe("PermissionDenied");
			}),
		),
	);

	test(
		"call fails StateDecodeError when the request payload is invalid",
		testEffect(
			Effect.gen(function* () {
				const echo = vi.fn((request: number) => request);
				const loaded = yield* load({ echo, locked: (request) => request });
				const error = yield* loaded.rpc.echo[stateFieldInternal]
					.callEncoded("not a number")
					.pipe(Effect.provideService(CurrentIdentity, anonymous), Effect.flip);
				expect(error._tag).toBe("StateDecodeError");
				expect(echo).not.toHaveBeenCalled();
			}),
		),
	);

	test(
		"call surfaces a throwing handler as RpcHandlerFailure",
		testEffect(
			Effect.gen(function* () {
				const loaded = yield* load({
					echo: () => {
						throw new Error("boom");
					},
					locked: (request) => request,
				});
				const error = yield* loaded.rpc.echo[stateFieldInternal]
					.callEncoded("1")
					.pipe(Effect.provideService(CurrentIdentity, anonymous), Effect.flip);
				expect(error._tag).toBe("RpcHandlerFailure");
			}),
		),
	);
});
