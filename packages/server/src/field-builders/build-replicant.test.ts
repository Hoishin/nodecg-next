import { defineNamespace } from "@nodecg/core";
import {
	AnonymousIdentitySchema,
	CurrentIdentity,
	HumanAccountSchema,
	HumanIdentitySchema,
	RoleName,
	ServerIdentitySchema,
} from "@nodecg/internal";
import { computeTestHash } from "@nodecg/internal/occ";
import { makeTestEffect } from "@nodecg/internal/test-utils";
import {
	Cause,
	Chunk,
	Effect,
	Layer,
	Option,
	Runtime,
	Schema,
	Stream,
} from "effect";
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

const stubbedStorage = Layer.succeed(ReplicantStorageService, storage);

const testStubbed = makeTestEffect(
	Layer.mergeAll(
		stubbedStorage,
		DerivationEngineService.Default.pipe(Layer.provide(stubbedStorage)),
		identity,
	),
);

const testInMemory = makeTestEffect(
	Layer.mergeAll(
		InMemoryReplicantStorage,
		DerivationEngineService.Default.pipe(
			Layer.provide(InMemoryReplicantStorage),
		),
		identity,
	),
);

// Different encoded and decoded
const manifest = defineNamespace("ns", {
	roles: { scorer: { permission: ["replicant-read", "replicant-write"] } },
	replicant: {
		count: { schema: Schema.NumberFromString },
		other: { schema: Schema.NumberFromString },
		locked: {
			schema: Schema.NumberFromString,
			permission: { write: { deny: ["scorer"] } },
		},
	},
});

const scorer = Layer.succeed(
	CurrentIdentity,
	HumanIdentitySchema.make({
		account: HumanAccountSchema.make({
			issuer: "test",
			subject: "subject",
			displayName: "Scorer",
		}),
		roles: new Set([RoleName("scorer")]),
	}),
);

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
				yield* engine.commit("ns", "count", () =>
					Effect.succeed("not a number"),
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
		"encodes the value and writes it to the engine",
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
				expect((yield* engine.readReplicant("ns", "count")).value).toBe("7");
			}),
		),
	);

	test(
		"fails when the value fails schema validation",
		testStubbed(
			Effect.gen(function* () {
				const engine = yield* DerivationEngineService;
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
				expect((yield* engine.readReplicant("ns", "count")).value).toBe("0");
			}),
		),
	);

	test(
		"fails FieldPermissionDenied for a caller whose role the write denies",
		testStubbed(
			Effect.gen(function* () {
				const engine = yield* DerivationEngineService;
				const field = yield* buildReplicant(
					"ns",
					"locked",
					manifest.replicant.locked,
					0,
				);
				const error = yield* field
					.set(1)
					.pipe(Effect.provide(scorer), Effect.flip);
				expect(error._tag).toBe("FieldPermissionDenied");
				expect((yield* engine.readReplicant("ns", "locked")).value).toBe("0");
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
				const engine = yield* DerivationEngineService;
				yield* field.update((v) => v + 3);
				expect((yield* engine.readReplicant("ns", "count")).value).toBe("13");
			}),
		),
	);

	test(
		"surfaces a throwing update fn as ReplicantUpdateFnError without writing",
		testStubbed(
			Effect.gen(function* () {
				const engine = yield* DerivationEngineService;
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
				expect((yield* engine.readReplicant("ns", "count")).value).toBe("10");
			}),
		),
	);

	test(
		"mutating the draft in place writes the encoded mutated value",
		testStubbed(
			Effect.gen(function* () {
				const box = defineNamespace("ns", {
					replicant: {
						box: { schema: Schema.Struct({ n: Schema.NumberFromString }) },
					},
				});
				const engine = yield* DerivationEngineService;
				const field = yield* buildReplicant("ns", "box", box.replicant.box, {
					n: 1,
				});
				yield* field.update((draft) => {
					draft.n = 5;
				});
				expect((yield* engine.readReplicant("ns", "box")).value).toEqual({
					n: "5",
				});
			}),
		),
	);

	test(
		"retries against the fresh value when a concurrent commit lands mid-produce",
		testStubbed(
			Effect.gen(function* () {
				const engine = yield* DerivationEngineService;
				const runtime = yield* Effect.runtime<never>();
				const field = yield* buildReplicant(
					"ns",
					"count",
					manifest.replicant.count,
					10,
				);
				let raced = false;
				yield* field.update((v) => {
					if (!raced) {
						raced = true;
						Runtime.runSync(
							runtime,
							engine.commit("ns", "count", () => Effect.succeed("100")),
						);
					}
					return v + 3;
				});

				expect((yield* engine.readReplicant("ns", "count")).value).toBe("103");
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
				yield* storage.write("ns", "count", "0", true);
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
				yield* storage.write("ns", "count", "0", true);
				yield* storage.write("ns", "other", "0", true);
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
		"[fieldInternal].subscribeRevisioned streams this field's frames",
		testInMemory(
			Effect.gen(function* () {
				const storage = yield* ReplicantStorageService;
				yield* storage.write("ns", "count", "0", true);
				const field = yield* buildReplicant(
					"ns",
					"count",
					manifest.replicant.count,
					0,
				);

				const stream = yield* field[fieldInternal].subscribeRevisioned();
				yield* field.set(42);

				const events = yield* stream.pipe(Stream.take(2), Stream.runCollect);
				expect(Chunk.toArray(events)).toEqual([
					{ value: "0", revision: 0, delta: Option.none() },
					{ value: "42", revision: 1, delta: Option.none() },
				]);
			}),
		),
	);
});

describe("derivation engine write-through", () => {
	test(
		"set, commitPatch, and update feed the engine replicant",
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
				expect((yield* engine.readReplicant("ns", "count")).value).toEqual("7");

				yield* field[fieldInternal].commitPatch([
					{ op: "replace", path: "", value: "8" },
				]);
				expect((yield* engine.readReplicant("ns", "count")).value).toEqual("8");

				yield* field.update((v) => v + 3);
				expect((yield* engine.readReplicant("ns", "count")).value).toEqual(
					"11",
				);
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
				yield* field.set(1).pipe(Effect.provide(scorer), Effect.flip);
				expect((yield* engine.readReplicant("ns", "locked")).value).toEqual(
					"0",
				);
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
		"getRevisioned returns the raw stored value and revision for an allowed caller",
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
						.getRevisioned()
						.pipe(Effect.provide(anonymous)),
				).toEqual({ value: 42, revision: 0 });
			}),
		),
	);

	test(
		"getRevisioned fails FieldPermissionDenied for a denied caller",
		testStubbed(
			Effect.gen(function* () {
				const field = yield* buildReplicant(
					"ns",
					"locked",
					permissioned.replicant.locked,
					0,
				);
				const error = yield* field[fieldInternal]
					.getRevisioned()
					.pipe(Effect.provide(anonymous), Effect.flip);
				expect(error._tag).toBe("FieldPermissionDenied");
			}),
		),
	);

	test(
		"commitPatch validates and writes for an allowed caller",
		testStubbed(
			Effect.gen(function* () {
				const field = yield* buildReplicant(
					"ns",
					"open",
					permissioned.replicant.open,
					0,
				);
				const engine = yield* DerivationEngineService;
				const committed = yield* field[fieldInternal]
					.commitPatch([{ op: "replace", path: "", value: 7 }])
					.pipe(Effect.provide(anonymous));
				expect(committed).toEqual({ value: 7, revision: 1 });
				expect((yield* engine.readReplicant("ns", "open")).value).toBe(7);
			}),
		),
	);

	test(
		"commitPatch fails FieldDecodeError and does not write for an invalid applied document",
		testStubbed(
			Effect.gen(function* () {
				const engine = yield* DerivationEngineService;
				const field = yield* buildReplicant(
					"ns",
					"open",
					permissioned.replicant.open,
					0,
				);
				const error = yield* field[fieldInternal]
					.commitPatch([{ op: "replace", path: "", value: "not a number" }])
					.pipe(Effect.provide(anonymous), Effect.flip);
				expect(error._tag).toBe("FieldDecodeError");
				expect((yield* engine.readReplicant("ns", "open")).value).toBe(0);
			}),
		),
	);

	test(
		"commitPatch fails FieldPermissionDenied and does not write for a denied caller",
		testStubbed(
			Effect.gen(function* () {
				const engine = yield* DerivationEngineService;
				const field = yield* buildReplicant(
					"ns",
					"locked",
					permissioned.replicant.locked,
					0,
				);
				const error = yield* field[fieldInternal]
					.commitPatch([{ op: "replace", path: "", value: 7 }])
					.pipe(Effect.provide(anonymous), Effect.flip);
				expect(error._tag).toBe("FieldPermissionDenied");
				expect((yield* engine.readReplicant("ns", "locked")).value).toBe(0);
			}),
		),
	);
});

describe("commitPatch", () => {
	const nested = defineNamespace("ns", {
		replicant: {
			doc: {
				schema: Schema.Struct({
					a: Schema.NumberFromString,
					b: Schema.NumberFromString,
				}),
			},
		},
	});

	test(
		"applies a field-level replace and validates the applied document",
		testStubbed(
			Effect.gen(function* () {
				const engine = yield* DerivationEngineService;
				const field = yield* buildReplicant("ns", "doc", nested.replicant.doc, {
					a: 1,
					b: 2,
				});
				const committed = yield* field[fieldInternal].commitPatch([
					{ op: "replace", path: "/a", value: "5" },
				]);
				expect(committed).toEqual({ value: { a: "5", b: "2" }, revision: 1 });
				expect((yield* engine.readReplicant("ns", "doc")).value).toEqual({
					a: "5",
					b: "2",
				});
			}),
		),
	);

	test(
		"fails PatchNotApplicable when the patch fits no document",
		testStubbed(
			Effect.gen(function* () {
				const engine = yield* DerivationEngineService;
				const field = yield* buildReplicant("ns", "doc", nested.replicant.doc, {
					a: 1,
					b: 2,
				});
				const error = yield* field[fieldInternal]
					.commitPatch([{ op: "remove", path: "" }])
					.pipe(Effect.flip);
				assert(error._tag === "PatchNotApplicable");
				expect(error.path).toBe("");
				expect(error.reason).toBe("ImmovableRoot");
				expect((yield* engine.readReplicant("ns", "doc")).value).toEqual({
					a: "1",
					b: "2",
				});
			}),
		),
	);

	test(
		"fails RevisionConflict when a precondition no longer holds",
		testStubbed(
			Effect.gen(function* () {
				const field = yield* buildReplicant("ns", "doc", nested.replicant.doc, {
					a: 1,
					b: 2,
				});
				const error = yield* field[fieldInternal]
					.commitPatch([
						{ op: "test-hash", path: "/a", hash: computeTestHash("9") },
						{ op: "replace", path: "/a", value: "5" },
					])
					.pipe(Effect.flip);
				assert(error._tag === "RevisionConflict");
				expect(error.value).toEqual({ a: "1", b: "2" });
				expect(error.revision).toBe(0);
				expect(error.reason).toBe("HashMismatch");
			}),
		),
	);
});
