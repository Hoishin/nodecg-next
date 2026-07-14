import { defineNamespace } from "@nodecg/core";
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

import { buildNamespace, fieldInternal } from "./build-namespace.ts";
import { type RpcContext } from "./implement-namespace.ts";
import { InMemoryReplicantStorage } from "./services/replicant-storage/in-memory-replicant-storage.ts";
import {
	type ReplicantChange,
	type ReplicantStorage,
	ReplicantStorageService,
} from "./services/replicant-storage/replicant-storage.ts";
import { InMemoryTopicBroker } from "./services/topic-broker/in-memory-topic-broker.ts";
import {
	type TopicBroker,
	type TopicMessage,
	TopicBrokerService,
} from "./services/topic-broker/topic-broker.ts";

const createStorageStub = () =>
	({
		read: vi.fn<ReplicantStorage["read"]>(() => Option.none()),
		create: vi.fn<ReplicantStorage["create"]>(() => Effect.void),
		update: vi.fn<ReplicantStorage["update"]>(() => Effect.void),
		subscribe: vi.fn<ReplicantStorage["subscribe"]>(() =>
			Queue.unbounded<ReplicantChange>(),
		),
		flush: vi.fn<ReplicantStorage["flush"]>(() => Effect.void),
	}) satisfies ReplicantStorage;

const createBrokerStub = () =>
	({
		publish: vi.fn<TopicBroker["publish"]>(() => Effect.void),
		subscribe: vi.fn<TopicBroker["subscribe"]>(() =>
			Effect.succeed(Stream.empty),
		),
	}) satisfies TopicBroker;

const stubbed = (
	storage: ReplicantStorage,
	broker: TopicBroker = createBrokerStub(),
) =>
	Layer.merge(
		Layer.succeed(ReplicantStorageService, storage),
		Layer.succeed(TopicBrokerService, broker),
	);

const inMemory = Layer.merge(InMemoryReplicantStorage, InMemoryTopicBroker);

const anonymous = AnonymousIdentitySchema.make();

// Different encoded and decoded
const countManifest = defineNamespace("ns", {
	replicant: { count: { schema: Schema.NumberFromString } },
});

describe("buildNamespace seeding", () => {
	test(
		"encodes the seed value and creates it when storage has none",
		testEffect(
			Effect.gen(function* () {
				const storage = createStorageStub();
				storage.read.mockReturnValue(Option.none());

				yield* buildNamespace(countManifest, {
					seedReplicant: { count: () => 42 },
				}).pipe(Effect.provide(stubbed(storage)));

				expect(storage.create).toHaveBeenCalledWith("ns", "count", "42");
				expect(storage.create).toHaveBeenCalledTimes(1);
			}),
		),
	);

	test(
		"supports an async thunk",
		testEffect(
			Effect.gen(function* () {
				const storage = createStorageStub();
				storage.read.mockReturnValue(Option.none());

				yield* buildNamespace(countManifest, {
					seedReplicant: {
						count: async () => {
							await new Promise((resolve) => setTimeout(resolve, 1));
							return 7;
						},
					},
				}).pipe(Effect.provide(stubbed(storage)));

				expect(storage.create).toHaveBeenCalledWith("ns", "count", "7");
			}),
		),
	);

	test(
		"skips seeding when storage already has a value",
		testEffect(
			Effect.gen(function* () {
				const storage = createStorageStub();
				storage.read.mockReturnValue(Option.some("5"));

				yield* buildNamespace(countManifest, {
					seedReplicant: { count: () => 0 },
				}).pipe(Effect.provide(stubbed(storage)));

				expect(storage.create).not.toHaveBeenCalled();
			}),
		),
	);

	test(
		"fails if encode rejects the seed value",
		testEffect(
			Effect.gen(function* () {
				const storage = createStorageStub();
				storage.read.mockReturnValue(Option.none());

				const error = yield* buildNamespace(countManifest, {
					seedReplicant: { count: () => "nope" as unknown as number },
				}).pipe(Effect.provide(stubbed(storage)), Effect.flip);

				expect(error._tag).toBe("FieldEncodeError");
				expect(storage.create).not.toHaveBeenCalled();
			}),
		),
	);
});

describe("get", () => {
	test(
		"decodes the value returned by storage",
		testEffect(
			Effect.gen(function* () {
				const storage = createStorageStub();
				storage.read.mockReturnValue(Option.some("42"));

				const built = yield* buildNamespace(countManifest, {
					seedReplicant: { count: () => 0 },
				}).pipe(Effect.provide(stubbed(storage)));

				expect(yield* built.replicant.count.get()).toBe(42);
			}),
		),
	);

	test(
		"dies when the stored value does not match the schema",
		testEffect(
			Effect.gen(function* () {
				const storage = createStorageStub();
				storage.read.mockReturnValue(Option.some("not a number"));

				const built = yield* buildNamespace(countManifest, {
					seedReplicant: { count: () => 0 },
				}).pipe(Effect.provide(stubbed(storage)));

				const cause = yield* built.replicant.count
					.get()
					.pipe(Effect.sandbox, Effect.flip);

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
				const storage = createStorageStub();
				storage.read.mockReturnValue(Option.some("0"));

				const built = yield* buildNamespace(countManifest, {
					seedReplicant: { count: () => 0 },
				}).pipe(Effect.provide(stubbed(storage)));

				yield* built.replicant.count.set(7);

				expect(storage.update).toHaveBeenCalledWith("ns", "count", "7");
			}),
		),
	);

	test(
		"fails when the value fails schema validation",
		testEffect(
			Effect.gen(function* () {
				const storage = createStorageStub();
				storage.read.mockReturnValue(Option.some("0"));

				const built = yield* buildNamespace(countManifest, {
					seedReplicant: { count: () => 0 },
				}).pipe(Effect.provide(stubbed(storage)));

				const error = yield* built.replicant.count
					.set("not a number" as unknown as number)
					.pipe(Effect.flip);

				expect(error._tag).toBe("FieldEncodeError");
				expect(storage.update).not.toHaveBeenCalled();
			}),
		),
	);
});

describe("update", () => {
	test(
		"reads the current value, applies the fn, and writes the result",
		testEffect(
			Effect.gen(function* () {
				const storage = createStorageStub();
				storage.read.mockReturnValue(Option.some("10"));

				const built = yield* buildNamespace(countManifest, {
					seedReplicant: { count: () => 0 },
				}).pipe(Effect.provide(stubbed(storage)));

				yield* built.replicant.count.update((v) => v + 3);

				expect(storage.update).toHaveBeenLastCalledWith("ns", "count", "13");
			}),
		),
	);
});

describe("computed", () => {
	const computedManifest = defineNamespace("ns", {
		replicant: {
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
				const built = yield* buildNamespace(computedManifest, {
					seedReplicant: { games: () => [] },
					implementComputed: { firstGameId },
				}).pipe(Effect.provide(inMemory));

				expect(yield* built.computed.firstGameId.get()).toBe(null);

				yield* built.replicant.games.set([{ id: "a" }, { id: "b" }]);
				expect(yield* built.computed.firstGameId.get()).toBe("a");
			}),
		),
	);

	test(
		"subscribe seeds, recomputes on source change, and dedupes unchanged values",
		testEffect(
			Effect.gen(function* () {
				const built = yield* buildNamespace(computedManifest, {
					seedReplicant: { games: () => [] },
					implementComputed: { firstGameId },
				}).pipe(Effect.provide(inMemory));

				const received: (string | null)[] = [];
				const fiber = yield* built.computed.firstGameId.subscribe().pipe(
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
				yield* built.replicant.games.set([{ id: "a" }]);
				yield* Effect.promise(() =>
					vi.waitFor(() => expect(received).toEqual([null, "a"])),
				);
				yield* built.replicant.games.set([{ id: "a" }, { id: "c" }]);
				yield* built.replicant.games.set([{ id: "b" }]);
				yield* Effect.promise(() =>
					vi.waitFor(() => expect(received).toEqual([null, "a", "b"])),
				);

				yield* Fiber.interrupt(fiber);
			}),
		),
	);

	test(
		"eager compute at load fails fast when compute throws",
		testEffect(
			Effect.gen(function* () {
				const error = yield* buildNamespace(computedManifest, {
					seedReplicant: { games: () => [] },
					implementComputed: {
						firstGameId: () => {
							throw new Error("boom");
						},
					},
				}).pipe(Effect.provide(inMemory), Effect.flip);

				expect(error._tag).toBe("ComputedComputeError");
			}),
		),
	);

	test(
		"eager compute at load fails fast when the computed value fails its schema",
		testEffect(
			Effect.gen(function* () {
				const error = yield* buildNamespace(computedManifest, {
					seedReplicant: { games: () => [] },
					implementComputed: { firstGameId: () => 42 as unknown as string },
				}).pipe(Effect.provide(inMemory), Effect.flip);

				expect(error._tag).toBe("FieldEncodeError");
			}),
		),
	);
});

describe("field subscribe", () => {
	const manifest = defineNamespace("ns", {
		replicant: {
			count: { schema: Schema.NumberFromString },
			other: { schema: Schema.NumberFromString },
		},
	});

	const load = () =>
		buildNamespace(manifest, {
			seedReplicant: { count: () => 0, other: () => 0 },
		}).pipe(Effect.provide(inMemory));

	test(
		"[fieldInternal].subscribeEncoded emits raw JsonValue on set",
		testEffect(
			Effect.gen(function* () {
				const built = yield* load();

				const stream =
					yield* built.replicant.count[fieldInternal].subscribeEncoded();
				yield* built.replicant.count.set(42);

				const events = yield* stream.pipe(Stream.take(2), Stream.runCollect);
				expect(Chunk.toArray(events)).toEqual(["0", "42"]);
			}),
		),
	);

	test(
		"subscribe emits decoded values on set",
		testEffect(
			Effect.gen(function* () {
				const built = yield* load();

				const stream = yield* built.replicant.count.subscribe();
				yield* built.replicant.count.set(7);

				const events = yield* stream.pipe(Stream.take(2), Stream.runCollect);
				expect(Chunk.toArray(events)).toEqual([0, 7]);
			}),
		),
	);

	test(
		"subscribe filters out updates to other fields",
		testEffect(
			Effect.gen(function* () {
				const built = yield* load();

				const stream = yield* built.replicant.count.subscribe();
				yield* built.replicant.other.set(99);
				yield* built.replicant.count.set(3);

				const events = yield* stream.pipe(Stream.take(2), Stream.runCollect);
				expect(Chunk.toArray(events)).toEqual([0, 3]);
			}),
		),
	);
});

describe("encoded read/write enforce permission", () => {
	const manifest = defineNamespace("ns", {
		replicant: {
			open: {
				schema: Schema.Number,
				permission: {
					read: { allow: ["everyone"] },
					write: { allow: ["everyone"] },
				},
			},
			locked: { schema: Schema.Number },
		},
		computed: {
			openComputed: {
				schema: Schema.Number,
				permission: { read: { allow: ["everyone"] } },
			},
			lockedComputed: { schema: Schema.Number },
		},
	});

	const load = (storage: ReplicantStorage) =>
		buildNamespace(manifest, {
			seedReplicant: { open: () => 0, locked: () => 0 },
			implementComputed: {
				openComputed: (sources) => sources.open,
				lockedComputed: (sources) => sources.locked,
			},
		}).pipe(Effect.provide(stubbed(storage)));

	test(
		"getEncoded returns the value for an allowed caller",
		testEffect(
			Effect.gen(function* () {
				const storage = createStorageStub();
				storage.read.mockReturnValue(Option.some(42));
				const built = yield* load(storage);

				expect(
					yield* built.replicant.open[fieldInternal]
						.getEncoded()
						.pipe(Effect.provideService(CurrentIdentity, anonymous)),
				).toBe(42);
			}),
		),
	);

	test(
		"getEncoded fails FieldPermissionDenied for a denied caller",
		testEffect(
			Effect.gen(function* () {
				const storage = createStorageStub();
				storage.read.mockReturnValue(Option.some(42));
				const built = yield* load(storage);

				const error = yield* built.replicant.locked[fieldInternal]
					.getEncoded()
					.pipe(Effect.provideService(CurrentIdentity, anonymous), Effect.flip);

				expect(error._tag).toBe("FieldPermissionDenied");
			}),
		),
	);

	test(
		"setEncoded writes for an allowed caller",
		testEffect(
			Effect.gen(function* () {
				const storage = createStorageStub();
				storage.read.mockReturnValue(Option.some(0));
				const built = yield* load(storage);

				yield* built.replicant.open[fieldInternal]
					.setEncoded(7)
					.pipe(Effect.provideService(CurrentIdentity, anonymous));

				expect(storage.update).toHaveBeenCalledWith("ns", "open", 7);
			}),
		),
	);

	test(
		"setEncoded fails FieldPermissionDenied and does not write for a denied caller",
		testEffect(
			Effect.gen(function* () {
				const storage = createStorageStub();
				storage.read.mockReturnValue(Option.some(0));
				const built = yield* load(storage);

				const error = yield* built.replicant.locked[fieldInternal]
					.setEncoded(7)
					.pipe(Effect.provideService(CurrentIdentity, anonymous), Effect.flip);

				expect(error._tag).toBe("FieldPermissionDenied");
				expect(storage.update).not.toHaveBeenCalledWith("ns", "locked", 7);
			}),
		),
	);

	test(
		"computed getEncoded fails FieldPermissionDenied for a denied caller",
		testEffect(
			Effect.gen(function* () {
				const storage = createStorageStub();
				storage.read.mockReturnValue(Option.some(0));
				const built = yield* load(storage);

				const error = yield* built.computed.lockedComputed[fieldInternal]
					.getEncoded()
					.pipe(Effect.provideService(CurrentIdentity, anonymous), Effect.flip);

				expect(error._tag).toBe("FieldPermissionDenied");
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
					read: { allow: ["everyone"] },
					write: { allow: ["everyone"] },
				},
			},
			locked: { schema: Schema.NumberFromString },
		},
	});

	const load = (broker: TopicBroker) =>
		buildNamespace(manifest).pipe(
			Effect.provide(stubbed(createStorageStub(), broker)),
		);

	test(
		"publish encodes the value and forwards it to the broker",
		testEffect(
			Effect.gen(function* () {
				const broker = createBrokerStub();
				const built = yield* load(broker);

				yield* built.topic.open.publish(42);

				expect(broker.publish).toHaveBeenCalledWith("ns", "open", "42");
			}),
		),
	);

	test(
		"subscribeEncoded streams only the matching field's messages",
		testEffect(
			Effect.gen(function* () {
				const broker = createBrokerStub();
				broker.subscribe.mockReturnValue(
					Effect.succeed(
						Stream.fromIterable<TopicMessage>([
							{ namespace: "ns", name: "locked", value: "1" },
							{ namespace: "ns", name: "open", value: "2" },
							{ namespace: "other", name: "open", value: "3" },
						]),
					),
				);
				const built = yield* load(broker);

				const stream =
					yield* built.topic.open[fieldInternal].subscribeEncoded();
				const events = yield* stream.pipe(Stream.runCollect);

				expect(Chunk.toArray(events)).toEqual(["2"]);
			}),
		),
	);

	test(
		"subscribe decodes the matching messages",
		testEffect(
			Effect.gen(function* () {
				const broker = createBrokerStub();
				broker.subscribe.mockReturnValue(
					Effect.succeed(
						Stream.fromIterable<TopicMessage>([
							{ namespace: "ns", name: "open", value: "7" },
						]),
					),
				);
				const built = yield* load(broker);

				const stream = yield* built.topic.open.subscribe();
				const events = yield* stream.pipe(Stream.runCollect);

				expect(Chunk.toArray(events)).toEqual([7]);
			}),
		),
	);

	test(
		"publishEncoded forwards the value for an allowed caller",
		testEffect(
			Effect.gen(function* () {
				const broker = createBrokerStub();
				const built = yield* load(broker);

				yield* built.topic.open[fieldInternal]
					.publishEncoded("5")
					.pipe(Effect.provideService(CurrentIdentity, anonymous));

				expect(broker.publish).toHaveBeenCalledWith("ns", "open", "5");
			}),
		),
	);

	test(
		"publishEncoded fails FieldPermissionDenied and does not publish for a denied caller",
		testEffect(
			Effect.gen(function* () {
				const broker = createBrokerStub();
				const built = yield* load(broker);

				const error = yield* built.topic.locked[fieldInternal]
					.publishEncoded("5")
					.pipe(Effect.provideService(CurrentIdentity, anonymous), Effect.flip);

				expect(error._tag).toBe("FieldPermissionDenied");
				expect(broker.publish).not.toHaveBeenCalled();
			}),
		),
	);

	test(
		"publishEncoded fails when the value fails schema validation",
		testEffect(
			Effect.gen(function* () {
				const broker = createBrokerStub();
				const built = yield* load(broker);

				const error = yield* built.topic.open[fieldInternal]
					.publishEncoded(42)
					.pipe(Effect.provideService(CurrentIdentity, anonymous), Effect.flip);

				expect(error._tag).toBe("FieldDecodeError");
				expect(broker.publish).not.toHaveBeenCalled();
			}),
		),
	);
});

describe("rpc", () => {
	const manifest = defineNamespace("ns", {
		replicant: { count: { schema: Schema.Number } },
		computed: { doubled: { schema: Schema.Number } },
		topic: { cheer: { schema: Schema.String } },
		rpc: {
			echo: {
				schema: {
					request: Schema.NumberFromString,
					response: Schema.NumberFromString,
				},
				permission: { write: { allow: ["everyone"] } },
			},
			bump: {
				schema: { request: Schema.Number, response: Schema.Number },
				permission: { write: { allow: ["everyone"] } },
			},
			locked: {
				schema: { request: Schema.String, response: Schema.String },
			},
		},
	});

	type Ctx = RpcContext<
		{ count: number },
		{ doubled: number },
		{ cheer: string }
	>;

	type Handlers = {
		echo: (request: number, ctx: Ctx) => Promisable<number>;
		bump: (request: number, ctx: Ctx) => Promisable<number>;
		locked: (request: string, ctx: Ctx) => Promisable<string>;
	};

	const load = (
		handlers: Partial<Handlers>,
		broker: TopicBroker = createBrokerStub(),
	) =>
		buildNamespace(manifest, {
			seedReplicant: { count: () => 0 },
			implementComputed: { doubled: (sources) => sources.count * 2 },
			implementRpc: {
				echo: (request) => request,
				bump: (request) => request,
				locked: (request) => request,
				...handlers,
			},
		}).pipe(
			Effect.provide(
				Layer.merge(
					InMemoryReplicantStorage,
					Layer.succeed(TopicBrokerService, broker),
				),
			),
		);

	test(
		"call decodes the request, runs the handler, and encodes the response",
		testEffect(
			Effect.gen(function* () {
				const built = yield* load({ echo: (request) => request * 2 });

				const result = yield* built.rpc.echo[fieldInternal]
					.callEncoded("21")
					.pipe(Effect.provideService(CurrentIdentity, anonymous));

				expect(result).toBe("42");
			}),
		),
	);

	test(
		"call awaits an async handler",
		testEffect(
			Effect.gen(function* () {
				const built = yield* load({
					echo: async (request) => {
						await new Promise((resolve) => setTimeout(resolve, 1));
						return request + 1;
					},
				});

				const result = yield* built.rpc.echo[fieldInternal]
					.callEncoded("4")
					.pipe(Effect.provideService(CurrentIdentity, anonymous));

				expect(result).toBe("5");
			}),
		),
	);

	test(
		"a handler reads, writes, and publishes its own namespace through ctx",
		testEffect(
			Effect.gen(function* () {
				const broker = createBrokerStub();
				const built = yield* load(
					{
						bump: async (request, ctx) => {
							ctx.replicant.count.set(ctx.replicant.count.get() + request);
							ctx.replicant.count.update((count) => count + 1);
							await ctx.topic.cheer.publish("bumped");
							return ctx.computed.doubled.get();
						},
					},
					broker,
				);

				const result = yield* built.rpc.bump[fieldInternal]
					.callEncoded(5)
					.pipe(Effect.provideService(CurrentIdentity, anonymous));

				expect(yield* built.replicant.count.get()).toBe(6);
				expect(broker.publish).toHaveBeenCalledWith("ns", "cheer", "bumped");
				expect(result).toBe(12);
			}),
		),
	);

	test(
		"call fails FieldPermissionDenied for a caller without rpc-call",
		testEffect(
			Effect.gen(function* () {
				const built = yield* load({});

				const error = yield* built.rpc.locked[fieldInternal]
					.callEncoded("x")
					.pipe(Effect.provideService(CurrentIdentity, anonymous), Effect.flip);

				expect(error._tag).toBe("FieldPermissionDenied");
			}),
		),
	);

	test(
		"call fails FieldDecodeError when the request payload is invalid",
		testEffect(
			Effect.gen(function* () {
				const echo = vi.fn((request: number) => request);
				const built = yield* load({ echo });

				const error = yield* built.rpc.echo[fieldInternal]
					.callEncoded("not a number")
					.pipe(Effect.provideService(CurrentIdentity, anonymous), Effect.flip);

				expect(error._tag).toBe("FieldDecodeError");
				expect(echo).not.toHaveBeenCalled();
			}),
		),
	);

	test(
		"call surfaces a throwing handler as RpcCallFailed",
		testEffect(
			Effect.gen(function* () {
				const built = yield* load({
					echo: () => {
						throw new Error("boom");
					},
				});

				const error = yield* built.rpc.echo[fieldInternal]
					.callEncoded("1")
					.pipe(Effect.provideService(CurrentIdentity, anonymous), Effect.flip);

				expect(error._tag).toBe("RpcCallFailed");
			}),
		),
	);
});
