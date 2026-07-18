import { defineNamespace } from "@nodecg/core";
import {
	AnonymousIdentitySchema,
	CurrentIdentity,
	ServerIdentitySchema,
} from "@nodecg/internal";
import { makeTestEffect } from "@nodecg/internal/test-utils";
import { Effect, Layer, Queue, Schema, Stream } from "effect";
import {
	afterEach,
	assert,
	describe,
	expect,
	expectTypeOf,
	test,
	vi,
} from "vitest";

import type { ComputeContext } from "../implement-namespace.ts";
import { createStorageStub } from "../services/replicant-storage/replicant-storage.stub.ts";
import {
	type ReplicantChange,
	ReplicantNotFound,
	ReplicantStorageService,
} from "../services/replicant-storage/replicant-storage.ts";
import { buildComputed } from "./build-computed.ts";
import { fieldInternal } from "./field-internal-key.ts";

const serverIdentity = Layer.succeed(
	CurrentIdentity,
	ServerIdentitySchema.make(),
);
const anonymousIdentity = Layer.succeed(
	CurrentIdentity,
	AnonymousIdentitySchema.make(),
);

const { stub: storage, reset } = createStorageStub();
afterEach(reset);

const testStubbed = makeTestEffect(
	Layer.merge(Layer.succeed(ReplicantStorageService, storage), serverIdentity),
);

const manifest = defineNamespace("ns", {
	replicant: {
		games: { schema: Schema.Array(Schema.Struct({ id: Schema.String })) },
	},
	computed: {
		firstGameId: { schema: Schema.NullOr(Schema.String) },
		open: {
			schema: Schema.NullOr(Schema.String),
			permission: { read: { allow: ["everyone"] } },
		},
	},
});

type Sources = { readonly games: readonly { readonly id: string }[] };

const firstGameId = (sources: Sources) => sources.games[0]?.id ?? null;

const dummyContext: ComputeContext = {
	use: () => {
		throw new Error("not used in these tests");
	},
};

const build = (
	compute: (sources: Sources, ctx: ComputeContext) => string | null,
	snapshot: Effect.Effect<Sources, ReplicantNotFound, ReplicantStorageService>,
) =>
	buildComputed(
		"ns",
		"firstGameId",
		manifest.computed.firstGameId,
		compute,
		snapshot,
		dummyContext,
	);

describe("get", () => {
	test(
		"computes from the source snapshot",
		testStubbed(
			Effect.gen(function* () {
				const field = yield* build(
					firstGameId,
					Effect.succeed({ games: [{ id: "a" }, { id: "b" }] }),
				);
				expect(yield* field.get()).toBe("a");
			}),
		),
	);

	test(
		"passes the decoded sources and the compute context to the compute fn",
		testStubbed(
			Effect.gen(function* () {
				let received: { sources: Sources; ctx: ComputeContext } | undefined;
				const field = yield* build(
					(sources, ctx) => {
						expectTypeOf(sources).toEqualTypeOf<Sources>();
						expectTypeOf(ctx).toEqualTypeOf<ComputeContext>();
						received = { sources, ctx };
						return firstGameId(sources);
					},
					Effect.succeed({ games: [{ id: "a" }] }),
				);
				yield* field.get();

				assert(received);
				expect(received.sources).toEqual({ games: [{ id: "a" }] });
				expect(received.ctx.use).toBeTypeOf("function");
			}),
		),
	);

	test(
		"surfaces a throwing compute fn as ComputedComputeError",
		testStubbed(
			Effect.gen(function* () {
				const field = yield* build(
					() => {
						throw new Error("boom");
					},
					Effect.succeed({ games: [] }),
				);
				const error = yield* field.get().pipe(Effect.flip);
				expect(error._tag).toBe("ComputedComputeError");
				expect(error.message).toContain("boom");
			}),
		),
	);

	test(
		"fails FieldPermissionDenied for a denied caller",
		testStubbed(
			Effect.gen(function* () {
				const field = yield* build(firstGameId, Effect.succeed({ games: [] }));
				const error = yield* field
					.get()
					.pipe(Effect.provide(anonymousIdentity), Effect.flip);
				expect(error._tag).toBe("FieldPermissionDenied");
			}),
		),
	);
});

describe("getEncoded", () => {
	test(
		"encodes the computed value for an allowed caller",
		testStubbed(
			Effect.gen(function* () {
				const field = yield* buildComputed(
					"ns",
					"open",
					manifest.computed.open,
					firstGameId,
					Effect.succeed<Sources>({ games: [{ id: "a" }] }),
					dummyContext,
				);
				expect(
					yield* field[fieldInternal]
						.getEncoded()
						.pipe(Effect.provide(anonymousIdentity)),
				).toBe("a");
			}),
		),
	);

	test(
		"fails FieldPermissionDenied for a denied caller",
		testStubbed(
			Effect.gen(function* () {
				const field = yield* build(firstGameId, Effect.succeed({ games: [] }));
				const error = yield* field[fieldInternal]
					.getEncoded()
					.pipe(Effect.provide(anonymousIdentity), Effect.flip);
				expect(error._tag).toBe("FieldPermissionDenied");
			}),
		),
	);

	test(
		"fails FieldEncodeError when the computed value fails its schema",
		testStubbed(
			Effect.gen(function* () {
				const field = yield* build(
					() => 42 as unknown as string,
					Effect.succeed({ games: [] }),
				);
				const error = yield* field[fieldInternal]
					.getEncodedNoAuth()
					.pipe(Effect.flip);
				expect(error._tag).toBe("FieldEncodeError");
			}),
		),
	);
});

describe("subscribe", () => {
	const change: ReplicantChange = { namespace: "any", name: "any", value: 0 };

	test(
		"seeds with the current value, recomputes on any change, and dedupes",
		testStubbed(
			Effect.gen(function* () {
				const queue = yield* Queue.unbounded<ReplicantChange>();
				storage.subscribe.mockReturnValue(
					Effect.succeed(Stream.fromQueue(queue)),
				);
				let games: Sources["games"] = [];
				const field = yield* build(
					firstGameId,
					Effect.sync(() => ({ games })),
				);

				const received: (string | null)[] = [];
				yield* field.subscribe().pipe(
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
				games = [{ id: "a" }];
				yield* Queue.offer(queue, change);
				yield* Effect.promise(() =>
					vi.waitFor(() => expect(received).toEqual([null, "a"])),
				);
				yield* Queue.offer(queue, change);
				games = [{ id: "b" }];
				yield* Queue.offer(queue, change);
				yield* Effect.promise(() =>
					vi.waitFor(() => expect(received).toEqual([null, "a", "b"])),
				);
			}),
		),
	);

	test(
		"logs and skips a compute failure without ending the stream",
		testStubbed(
			Effect.gen(function* () {
				const queue = yield* Queue.unbounded<ReplicantChange>();
				storage.subscribe.mockReturnValue(
					Effect.succeed(Stream.fromQueue(queue)),
				);
				let games: Sources["games"] = [{ id: "a" }];
				let shouldThrow = false;
				const field = yield* build(
					(sources) => {
						if (shouldThrow) {
							throw new Error("boom");
						}
						return firstGameId(sources);
					},
					Effect.sync(() => ({ games })),
				);

				const received: (string | null)[] = [];
				yield* field.subscribe().pipe(
					Effect.flatMap((stream) =>
						Stream.runForEach(stream, (value) =>
							Effect.sync(() => received.push(value)),
						),
					),
					Effect.fork,
				);

				yield* Effect.promise(() =>
					vi.waitFor(() => expect(received).toEqual(["a"])),
				);
				shouldThrow = true;
				yield* Queue.offer(queue, change);
				shouldThrow = false;
				games = [{ id: "b" }];
				yield* Queue.offer(queue, change);
				yield* Effect.promise(() =>
					vi.waitFor(() => expect(received).toEqual(["a", "b"])),
				);
			}),
		),
	);
});
