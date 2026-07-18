import { defineNamespace } from "@nodecg/core";
import {
	AnonymousIdentitySchema,
	CurrentIdentity,
	ServerIdentitySchema,
} from "@nodecg/internal";
import { makeTestEffect } from "@nodecg/internal/test-utils";
import { Effect, Layer, Schema, Stream } from "effect";
import { describe, expect, test, vi } from "vitest";

import {
	ComputedComputeError,
	DerivationEngineService,
} from "../derivation-graph.ts";
import { ReplicantNotFound } from "../services/replicant-storage/replicant-storage.ts";
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

const testGraph = makeTestEffect(
	Layer.merge(DerivationEngineService.Default, serverIdentity),
);

const manifest = defineNamespace("ns", {
	replicant: {
		count: { schema: Schema.NumberFromString },
	},
	computed: {
		doubled: { schema: Schema.NumberFromString },
		open: {
			schema: Schema.NumberFromString,
			permission: { read: { everyone: "allow" } },
		},
		positive: { schema: Schema.NumberFromString.pipe(Schema.positive()) },
	},
});

const doubledCount = Effect.gen(function* () {
	const engine = yield* DerivationEngineService;
	const encoded = yield* engine
		.readReplicant("ns", "count")
		.pipe(
			Effect.catchTag(
				"ReplicantNotFound2",
				() => new ReplicantNotFound({ namespace: "ns", name: "count" }),
			),
		);
	const count = Number(encoded);
	if (Number.isNaN(count)) {
		return yield* new ComputedComputeError({
			namespace: "ns",
			name: "doubled",
			cause: new Error(`not a number: ${JSON.stringify(encoded)}`),
		});
	}
	return count * 2;
});

const initCount = (value: string) =>
	Effect.flatMap(DerivationEngineService, (engine) =>
		engine.initializeReplicant("ns", "count", value),
	);

const setCount = (value: string) =>
	Effect.flatMap(DerivationEngineService, (engine) =>
		engine.setReplicant("ns", "count", value),
	);

const build = buildComputed(
	"ns",
	"doubled",
	manifest.computed.doubled,
	doubledCount,
);

const waitFor = (assertion: () => void) =>
	Effect.promise(() => vi.waitFor(assertion));

describe("get", () => {
	test(
		"returns the computed value",
		testGraph(
			Effect.gen(function* () {
				yield* initCount("3");
				const field = yield* build;
				expect(yield* field.get()).toBe(6);
			}),
		),
	);

	test(
		"propagates a compute failure",
		testGraph(
			Effect.gen(function* () {
				const field = yield* build;
				const error = yield* field.get().pipe(Effect.flip);
				expect(error._tag).toBe("ReplicantNotFound");
			}),
		),
	);

	test(
		"fails FieldPermissionDenied for a denied caller",
		testGraph(
			Effect.gen(function* () {
				yield* initCount("3");
				const field = yield* build;
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
		testGraph(
			Effect.gen(function* () {
				yield* initCount("3");
				const field = yield* buildComputed(
					"ns",
					"open",
					manifest.computed.open,
					doubledCount,
				);
				expect(
					yield* field[fieldInternal]
						.getEncoded()
						.pipe(Effect.provide(anonymousIdentity)),
				).toBe("6");
			}),
		),
	);

	test(
		"fails FieldPermissionDenied for a denied caller",
		testGraph(
			Effect.gen(function* () {
				yield* initCount("3");
				const field = yield* build;
				const error = yield* field[fieldInternal]
					.getEncoded()
					.pipe(Effect.provide(anonymousIdentity), Effect.flip);
				expect(error._tag).toBe("FieldPermissionDenied");
			}),
		),
	);

	test(
		"fails FieldEncodeError when the computed value fails its schema",
		testGraph(
			Effect.gen(function* () {
				const field = yield* buildComputed(
					"ns",
					"positive",
					manifest.computed.positive,
					Effect.succeed(-1),
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
	test(
		"seeds with the current value, recomputes on a source change, and dedupes",
		testGraph(
			Effect.gen(function* () {
				yield* initCount("3");
				const field = yield* build;

				const received: number[] = [];
				yield* field.subscribe().pipe(
					Effect.flatMap((stream) =>
						Stream.runForEach(stream, (value) =>
							Effect.sync(() => received.push(value)),
						),
					),
					Effect.fork,
				);

				yield* waitFor(() => expect(received).toEqual([6]));
				yield* setCount("5");
				yield* waitFor(() => expect(received).toEqual([6, 10]));
				yield* setCount("5");
				yield* setCount("7");
				yield* waitFor(() => expect(received).toEqual([6, 10, 14]));
			}),
		),
	);

	test(
		"logs and skips a compute failure without ending the stream",
		testGraph(
			Effect.gen(function* () {
				yield* initCount("3");
				const field = yield* build;

				const received: number[] = [];
				yield* field.subscribe().pipe(
					Effect.flatMap((stream) =>
						Stream.runForEach(stream, (value) =>
							Effect.sync(() => received.push(value)),
						),
					),
					Effect.fork,
				);

				yield* waitFor(() => expect(received).toEqual([6]));
				yield* setCount("boom");
				yield* setCount("5");
				yield* waitFor(() => expect(received).toEqual([6, 10]));
			}),
		),
	);

	test(
		"fails when the seed cannot be computed",
		testGraph(
			Effect.gen(function* () {
				yield* initCount("boom");
				const field = yield* build;
				const error = yield* field.subscribe().pipe(Effect.flip);
				expect(error._tag).toBe("ComputedComputeError");
			}),
		),
	);
});
