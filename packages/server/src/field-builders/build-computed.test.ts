import { defineNamespace } from "@nodecg-next/core";
import {
	AnonymousIdentitySchema,
	CurrentIdentity,
	ServerIdentitySchema,
} from "@nodecg-next/internal";
import { testLayer } from "@nodecg-next/test-utils";
import { Effect, Layer, Schema, Stream } from "effect";
import { describe, expect, vi } from "vitest";

import {
	ComputedComputeError,
	DerivationEngineService,
} from "../derivation-graph.ts";
import { InMemoryReplicantStorage } from "../services/replicant-storage/in-memory-replicant-storage.ts";
import { ReplicantNotFound } from "../services/replicant-storage/replicant-storage.ts";
import { buildComputed } from "./build-computed.ts";
import { fieldInternal } from "./field-internal-key.ts";

const serverIdentity = Layer.succeed(
	CurrentIdentity,
	ServerIdentitySchema.make({}),
);
const anonymousIdentity = Layer.succeed(
	CurrentIdentity,
	AnonymousIdentitySchema.make({}),
);

const test = testLayer(
	Layer.merge(
		DerivationEngineService.layer.pipe(Layer.provide(InMemoryReplicantStorage)),
		serverIdentity,
	),
);

const manifest = defineNamespace("ns", {
	replicant: {
		count: { schema: Schema.FiniteFromString },
	},
	computed: {
		doubled: { schema: Schema.FiniteFromString },
		open: {
			schema: Schema.FiniteFromString,
			permission: { read: { everyone: "allow" } },
		},
		positive: {
			schema: Schema.FiniteFromString.check(Schema.isGreaterThan(0)),
		},
	},
});

const doubledCount = Effect.gen(function* () {
	const engine = yield* DerivationEngineService;
	const encoded = yield* engine.readReplicant("ns", "count").pipe(
		Effect.map((r) => r.value),
		Effect.catchTag(
			"UnknownReplicant",
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
		engine.commit("ns", "count", () => Effect.succeed(value)),
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
		Effect.gen(function* () {
			yield* initCount("3");
			const field = yield* build;
			expect(yield* field.get()).toBe(6);
		}),
	);

	test(
		"propagates a compute failure",
		Effect.gen(function* () {
			const field = yield* build;
			const error = yield* field.get().pipe(Effect.flip);
			expect(error._tag).toBe("ReplicantNotFound");
		}),
	);

	test(
		"fails FieldPermissionDenied for a denied caller",
		Effect.gen(function* () {
			yield* initCount("3");
			const field = yield* build;
			const error = yield* field
				.get()
				.pipe(Effect.provide(anonymousIdentity), Effect.flip);
			expect(error._tag).toBe("FieldPermissionDenied");
		}),
	);
});

describe("getEncoded", () => {
	test(
		"encodes the computed value for an allowed caller",
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
	);

	test(
		"fails FieldPermissionDenied for a denied caller",
		Effect.gen(function* () {
			yield* initCount("3");
			const field = yield* build;
			const error = yield* field[fieldInternal]
				.getEncoded()
				.pipe(Effect.provide(anonymousIdentity), Effect.flip);
			expect(error._tag).toBe("FieldPermissionDenied");
		}),
	);

	test(
		"fails FieldEncodeError when the computed value fails its schema",
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
	);
});

describe("subscribe", () => {
	test(
		"seeds with the current value, recomputes on a source change, and dedupes",
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
				Effect.forkChild,
			);

			yield* waitFor(() => expect(received).toEqual([6]));
			yield* setCount("5");
			yield* waitFor(() => expect(received).toEqual([6, 10]));
			yield* setCount("5");
			yield* setCount("7");
			yield* waitFor(() => expect(received).toEqual([6, 10, 14]));
		}),
	);

	test(
		"logs and skips a compute failure without ending the stream",
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
				Effect.forkChild,
			);

			yield* waitFor(() => expect(received).toEqual([6]));
			yield* setCount("boom");
			yield* setCount("5");
			yield* waitFor(() => expect(received).toEqual([6, 10]));
		}),
	);

	test(
		"fails when the seed cannot be computed",
		Effect.gen(function* () {
			yield* initCount("boom");
			const field = yield* build;
			const error = yield* field.subscribe().pipe(Effect.flip);
			expect(error._tag).toBe("ComputedComputeError");
		}),
	);
});
