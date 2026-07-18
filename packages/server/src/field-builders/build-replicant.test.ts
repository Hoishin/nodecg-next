import { defineNamespace } from "@nodecg/core";
import {
	AnonymousIdentitySchema,
	CurrentIdentity,
	ServerIdentitySchema,
} from "@nodecg/internal";
import { makeTestEffect } from "@nodecg/internal/test-utils";
import { Cause, Chunk, Effect, Layer, Option, Schema, Stream } from "effect";
import { afterEach, assert, describe, expect, test } from "vitest";

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
	Layer.merge(Layer.succeed(ReplicantStorageService, storage), identity),
);

const testInMemory = makeTestEffect(
	Layer.merge(InMemoryReplicantStorage, identity),
);

// Different encoded and decoded
const manifest = defineNamespace("ns", {
	replicant: {
		count: { schema: Schema.NumberFromString },
		other: { schema: Schema.NumberFromString },
		locked: {
			schema: Schema.NumberFromString,
			permission: { write: { deny: ["server"] } },
		},
	},
});

describe("get", () => {
	test(
		"decodes the value returned by storage",
		testStubbed(
			Effect.gen(function* () {
				storage.read.mockReturnValue(Effect.succeed("42"));
				const field = yield* buildReplicant(
					"ns",
					"count",
					manifest.replicant.count,
				);
				expect(yield* field.get()).toBe(42);
				expect(storage.read).toHaveBeenCalledWith("ns", "count");
			}),
		),
	);

	test(
		"propagates ReplicantNotFound from storage",
		testStubbed(
			Effect.gen(function* () {
				const field = yield* buildReplicant(
					"ns",
					"count",
					manifest.replicant.count,
				);
				const error = yield* field.get().pipe(Effect.flip);
				expect(error._tag).toBe("ReplicantNotFound");
			}),
		),
	);

	test(
		"dies when the stored value does not match the schema",
		testStubbed(
			Effect.gen(function* () {
				storage.read.mockReturnValue(Effect.succeed("not a number"));
				const field = yield* buildReplicant(
					"ns",
					"count",
					manifest.replicant.count,
				);
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
				storage.read.mockReturnValue(Effect.succeed("10"));
				const field = yield* buildReplicant(
					"ns",
					"count",
					manifest.replicant.count,
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
				storage.read.mockReturnValue(Effect.succeed("10"));
				const field = yield* buildReplicant(
					"ns",
					"count",
					manifest.replicant.count,
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
				);
				const other = yield* buildReplicant(
					"ns",
					"other",
					manifest.replicant.other,
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
				);

				const stream = yield* field[fieldInternal].subscribeEncoded();
				yield* field.set(42);

				const events = yield* stream.pipe(Stream.take(2), Stream.runCollect);
				expect(Chunk.toArray(events)).toEqual(["0", "42"]);
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
					read: { allow: ["everyone"] },
					write: { allow: ["everyone"] },
				},
			},
			locked: { schema: Schema.Number },
		},
	});

	test(
		"getEncoded returns the validated value for an allowed caller",
		testStubbed(
			Effect.gen(function* () {
				storage.read.mockReturnValue(Effect.succeed(42));
				const field = yield* buildReplicant(
					"ns",
					"open",
					permissioned.replicant.open,
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
		"getEncoded dies when the stored value does not match the schema",
		testStubbed(
			Effect.gen(function* () {
				storage.read.mockReturnValue(Effect.succeed("corrupt"));
				const field = yield* buildReplicant(
					"ns",
					"open",
					permissioned.replicant.open,
				);
				const cause = yield* field[fieldInternal]
					.getEncoded()
					.pipe(Effect.provide(anonymous), Effect.sandbox, Effect.flip);
				const defect = Cause.dieOption(cause);
				assert(Option.isSome(defect));
				assert(typeof defect.value === "string");
				expect(defect.value).toContain("Migration is not supported yet");
			}),
		),
	);

	test(
		"getEncoded fails FieldPermissionDenied for a denied caller",
		testStubbed(
			Effect.gen(function* () {
				storage.read.mockReturnValue(Effect.succeed(42));
				const field = yield* buildReplicant(
					"ns",
					"locked",
					permissioned.replicant.locked,
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
