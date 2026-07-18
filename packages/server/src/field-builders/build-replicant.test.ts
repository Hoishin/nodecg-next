import { defineNamespace } from "@nodecg/core";
import {
	AnonymousIdentitySchema,
	CurrentIdentity,
	ServerIdentitySchema,
} from "@nodecg/internal";
import { makeTestEffect } from "@nodecg/internal/test-utils";
import { Cause, Chunk, Effect, Layer, Option, Schema, Stream } from "effect";
import { afterEach, assert, describe, expect, test } from "vitest";

import { DerivationEngineService } from "../derivation-graph.ts";
import { InMemoryReplicantStorage } from "../services/replicant-storage/in-memory-replicant-storage.ts";
import { createStorageStub } from "../services/replicant-storage/replicant-storage.stub.ts";
import { ReplicantStorageService } from "../services/replicant-storage/replicant-storage.ts";
import { buildReplicant } from "./build-replicant.ts";
import { fieldInternal } from "./field-internal-key.ts";

const anonymous = Layer.succeed(
	CurrentIdentity,
	AnonymousIdentitySchema.make(),
);
const identity = Layer.succeed(CurrentIdentity, ServerIdentitySchema.make());

const { stub: storage, reset } = createStorageStub();
afterEach(reset);

const testStubbed = makeTestEffect(
	Layer.mergeAll(
		Layer.succeed(ReplicantStorageService, storage),
		DerivationEngineService.Default,
		identity,
	),
);

const testInMemory = makeTestEffect(
	Layer.mergeAll(
		InMemoryReplicantStorage,
		DerivationEngineService.Default,
		identity,
	),
);

// Different encoded and decoded
const manifest = defineNamespace("ns", {
	replicant: {
		count: { schema: Schema.NumberFromString },
		other: { schema: Schema.NumberFromString },
		locked: {
			schema: Schema.NumberFromString,
			permission: { write: { server: "deny" } },
		},
	},
});

describe("get", () => {
	test(
		"decodes the value held by the engine",
		testStubbed(
			Effect.gen(function* () {
				const field = yield* buildReplicant(
					"ns",
					"count",
					manifest.replicant.count,
					42,
				);
				expect(yield* field.get()).toBe(42);
			}),
		),
	);

	test(
		"dies when the stored value does not match the schema",
		testStubbed(
			Effect.gen(function* () {
				const engine = yield* DerivationEngineService;
				const field = yield* buildReplicant(
					"ns",
					"count",
					manifest.replicant.count,
					0,
				);
				yield* engine.setReplicant("ns", "count", "not a number");
				const cause = yield* field.get().pipe(Effect.sandbox, Effect.flip);
				const defect = Cause.dieOption(cause);
				assert(Option.isSome(defect));
				assert(typeof defect.value === "string");
				expect(defect.value).toContain("Migration is not supported yet");
			}),
		),
	);
});

describe("set", () => {
	test(
		"encodes the value and writes it to storage",
		testStubbed(
			Effect.gen(function* () {
				const field = yield* buildReplicant(
					"ns",
					"count",
					manifest.replicant.count,
					0,
				);
				yield* field.set(7);
				expect(storage.update).toHaveBeenCalledWith("ns", "count", "7");
			}),
		),
	);

	test(
		"fails when the value fails schema validation",
		testStubbed(
			Effect.gen(function* () {
				const field = yield* buildReplicant(
					"ns",
					"count",
					manifest.replicant.count,
					0,
				);
				const error = yield* field
					.set("not a number" as unknown as number)
					.pipe(Effect.flip);
				expect(error._tag).toBe("FieldEncodeError");
				expect(storage.update).not.toHaveBeenCalled();
			}),
		),
	);

	test(
		"fails FieldPermissionDenied when the field's write denies the server",
		testStubbed(
			Effect.gen(function* () {
				const field = yield* buildReplicant(
					"ns",
					"locked",
					manifest.replicant.locked,
					0,
				);
				const error = yield* field.set(1).pipe(Effect.flip);
				expect(error._tag).toBe("FieldPermissionDenied");
				expect(storage.update).not.toHaveBeenCalled();
			}),
		),
	);
});

describe("update", () => {
	test(
		"reads the current value, applies the fn, and writes the result",
		testStubbed(
			Effect.gen(function* () {
				const field = yield* buildReplicant(
					"ns",
					"count",
					manifest.replicant.count,
					10,
				);
				yield* field.update((v) => v + 3);
				expect(storage.update).toHaveBeenLastCalledWith("ns", "count", "13");
			}),
		),
	);

	test(
		"surfaces a throwing update fn as ReplicantUpdateFnError without writing",
		testStubbed(
			Effect.gen(function* () {
				const field = yield* buildReplicant(
					"ns",
					"count",
					manifest.replicant.count,
					10,
				);
				const error = yield* field
					.update(() => {
						throw new Error("boom");
					})
					.pipe(Effect.flip);
				expect(error._tag).toBe("ReplicantUpdateFnError");
				expect(error.message).toContain("boom");
				expect(storage.update).not.toHaveBeenCalled();
			}),
		),
	);
});

describe("validate", () => {
	test(
		"encodes a valid value and fails an invalid one",
		testStubbed(
			Effect.gen(function* () {
				const field = yield* buildReplicant(
					"ns",
					"count",
					manifest.replicant.count,
					0,
				);
				expect(yield* field.validate(7)).toBe("7");
				const error = yield* field
					.validate("nope" as unknown as number)
					.pipe(Effect.flip);
				expect(error._tag).toBe("FieldEncodeError");
			}),
		),
	);
});

describe("subscribe", () => {
	test(
		"emits decoded values on set",
		testInMemory(
			Effect.gen(function* () {
				const storage = yield* ReplicantStorageService;
				yield* storage.create("ns", "count", "0");
				const field = yield* buildReplicant(
					"ns",
					"count",
					manifest.replicant.count,
					0,
				);

				const stream = yield* field.subscribe();
				yield* field.set(7);

				const events = yield* stream.pipe(Stream.take(2), Stream.runCollect);
				expect(Chunk.toArray(events)).toEqual([0, 7]);
			}),
		),
	);

	test(
		"filters out updates to other fields",
		testInMemory(
			Effect.gen(function* () {
				const storage = yield* ReplicantStorageService;
				yield* storage.create("ns", "count", "0");
				yield* storage.create("ns", "other", "0");
				const count = yield* buildReplicant(
					"ns",
					"count",
					manifest.replicant.count,
					0,
				);
				const other = yield* buildReplicant(
					"ns",
					"other",
					manifest.replicant.other,
					0,
				);

				const stream = yield* count.subscribe();
				yield* other.set(99);
				yield* count.set(3);

				const events = yield* stream.pipe(Stream.take(2), Stream.runCollect);
				expect(Chunk.toArray(events)).toEqual([0, 3]);
			}),
		),
	);

	test(
		"[fieldInternal].subscribeEncoded emits raw JsonValue on set",
		testInMemory(
			Effect.gen(function* () {
				const storage = yield* ReplicantStorageService;
				yield* storage.create("ns", "count", "0");
				const field = yield* buildReplicant(
					"ns",
					"count",
					manifest.replicant.count,
					0,
				);

				const stream = yield* field[fieldInternal].subscribeEncoded();
				yield* field.set(42);

				const events = yield* stream.pipe(Stream.take(2), Stream.runCollect);
				expect(Chunk.toArray(events)).toEqual(["0", "42"]);
			}),
		),
	);
});

describe("derivation engine write-through", () => {
	test(
		"set, setEncoded, and update feed the engine replicant",
		testStubbed(
			Effect.gen(function* () {
				const engine = yield* DerivationEngineService;
				const field = yield* buildReplicant(
					"ns",
					"count",
					manifest.replicant.count,
					0,
				);

				yield* field.set(7);
				expect(yield* engine.readReplicant("ns", "count")).toEqual("7");

				yield* field[fieldInternal].setEncoded("8");
				expect(yield* engine.readReplicant("ns", "count")).toEqual("8");

				yield* field.update((v) => v + 3);
				expect(yield* engine.readReplicant("ns", "count")).toEqual("11");
			}),
		),
	);

	test(
		"a failed write leaves the replicant untouched",
		testStubbed(
			Effect.gen(function* () {
				const engine = yield* DerivationEngineService;
				const field = yield* buildReplicant(
					"ns",
					"locked",
					manifest.replicant.locked,
					0,
				);
				yield* field.set(1).pipe(Effect.flip);
				expect(yield* engine.readReplicant("ns", "locked")).toEqual("0");
			}),
		),
	);
});

describe("encoded read/write enforce permission", () => {
	const permissioned = defineNamespace("ns", {
		replicant: {
			open: {
				schema: Schema.Number,
				permission: {
					read: { everyone: "allow" },
					write: { everyone: "allow" },
				},
			},
			locked: { schema: Schema.Number },
		},
	});

	test(
		"getEncoded returns the raw stored value for an allowed caller",
		testStubbed(
			Effect.gen(function* () {
				const field = yield* buildReplicant(
					"ns",
					"open",
					permissioned.replicant.open,
					42,
				);
				expect(
					yield* field[fieldInternal]
						.getEncoded()
						.pipe(Effect.provide(anonymous)),
				).toBe(42);
			}),
		),
	);

	test(
		"getEncoded fails FieldPermissionDenied for a denied caller",
		testStubbed(
			Effect.gen(function* () {
				const field = yield* buildReplicant(
					"ns",
					"locked",
					permissioned.replicant.locked,
					0,
				);
				const error = yield* field[fieldInternal]
					.getEncoded()
					.pipe(Effect.provide(anonymous), Effect.flip);
				expect(error._tag).toBe("FieldPermissionDenied");
			}),
		),
	);

	test(
		"setEncoded validates and writes for an allowed caller",
		testStubbed(
			Effect.gen(function* () {
				const field = yield* buildReplicant(
					"ns",
					"open",
					permissioned.replicant.open,
					0,
				);
				yield* field[fieldInternal]
					.setEncoded(7)
					.pipe(Effect.provide(anonymous));
				expect(storage.update).toHaveBeenCalledWith("ns", "open", 7);
			}),
		),
	);

	test(
		"setEncoded fails FieldDecodeError and does not write for an invalid value",
		testStubbed(
			Effect.gen(function* () {
				const field = yield* buildReplicant(
					"ns",
					"open",
					permissioned.replicant.open,
					0,
				);
				const error = yield* field[fieldInternal]
					.setEncoded("not a number")
					.pipe(Effect.provide(anonymous), Effect.flip);
				expect(error._tag).toBe("FieldDecodeError");
				expect(storage.update).not.toHaveBeenCalled();
			}),
		),
	);

	test(
		"setEncoded fails FieldPermissionDenied and does not write for a denied caller",
		testStubbed(
			Effect.gen(function* () {
				const field = yield* buildReplicant(
					"ns",
					"locked",
					permissioned.replicant.locked,
					0,
				);
				const error = yield* field[fieldInternal]
					.setEncoded(7)
					.pipe(Effect.provide(anonymous), Effect.flip);
				expect(error._tag).toBe("FieldPermissionDenied");
				expect(storage.update).not.toHaveBeenCalled();
			}),
		),
	);
});
