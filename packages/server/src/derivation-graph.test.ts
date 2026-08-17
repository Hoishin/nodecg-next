import { makeTestEffect } from "@nodecg/internal/test-utils";
import {
	Cause,
	Context,
	Effect,
	Exit,
	Layer,
	Schema,
	Scope,
	Stream,
} from "effect";
import type { JsonValue } from "type-fest";
import { afterEach, assert, describe, expect, test, vi } from "vitest";

import {
	ComputedComputeError,
	DerivationEngineService,
} from "./derivation-graph.ts";
import { InMemoryReplicantStorage } from "./services/replicant-storage/in-memory-replicant-storage.ts";
import { createStorageStub } from "./services/replicant-storage/replicant-storage.stub.ts";
import {
	ReplicantNotFound,
	ReplicantStorageService,
} from "./services/replicant-storage/replicant-storage.ts";

const testEngine = makeTestEffect(
	DerivationEngineService.Default.pipe(Layer.provide(InMemoryReplicantStorage)),
);

const { stub: storage, reset } = createStorageStub();
afterEach(reset);

const stubbedStorage = Layer.succeed(ReplicantStorageService, storage);

const testPersistence = makeTestEffect(stubbedStorage);

const waitFor = (assertion: () => void) =>
	Effect.promise(() => vi.waitFor(assertion));

const engineIn = (scope: Scope.Scope) =>
	Layer.build(DerivationEngineService.Default).pipe(
		Effect.map((context) => Context.get(context, DerivationEngineService)),
		Scope.extend(scope),
	);

describe("commitValue", () => {
	test(
		"commits a whole value, read back with the revision bumped",
		testEngine(
			Effect.gen(function* () {
				const engine = yield* DerivationEngineService;
				yield* engine.initializeReplicant("ns", "a", 1);
				expect(yield* engine.readReplicant("ns", "a")).toEqual(1);
				expect(yield* engine.readRevisioned("ns", "a")).toEqual({
					value: 1,
					revision: 0,
				});
				const committed = yield* engine.commitValue("ns", "a", 2);
				expect(committed).toEqual({ value: 2, revision: 1 });
				expect(yield* engine.readReplicant("ns", "a")).toEqual(2);
				expect(yield* engine.readRevisioned("ns", "a")).toEqual({
					value: 2,
					revision: 1,
				});
			}),
		),
	);

	test(
		"a value-equal commit does not bump the revision",
		testEngine(
			Effect.gen(function* () {
				const engine = yield* DerivationEngineService;
				yield* engine.initializeReplicant("ns", "a", { x: 1 });
				yield* engine.commitValue("ns", "a", { x: 2 });
				const before = yield* engine.readRevisioned("ns", "a");
				const committed = yield* engine.commitValue("ns", "a", { x: 2 });
				expect(committed).toEqual(before);
				expect(yield* engine.readRevisioned("ns", "a")).toEqual(before);
			}),
		),
	);

	test(
		"a value-equal commit does not re-evaluate dependents",
		testEngine(
			Effect.gen(function* () {
				const engine = yield* DerivationEngineService;
				yield* engine.initializeReplicant("ns", "a", { x: 1 });
				let evaluations = 0;
				yield* engine.initializeComputed("ns", "c", () => {
					evaluations += 1;
					return Effect.runSync(
						engine.readReplicant("ns", "a").pipe(Effect.orDie, Effect.exit),
					);
				});
				yield* engine.subscribeComputed("ns", "c");
				expect(evaluations).toBe(1);
				yield* engine.commitValue("ns", "a", { x: 1 });
				expect(evaluations).toBe(1);
				yield* engine.commitValue("ns", "a", { x: 2 });
				expect(evaluations).toBe(2);
			}),
		),
	);

	test(
		"fails for an unregistered replicant",
		testEngine(
			Effect.gen(function* () {
				const engine = yield* DerivationEngineService;
				const read = yield* engine
					.readReplicant("ns", "missing")
					.pipe(Effect.flip);
				expect(read._tag).toBe("UnknownReplicant");
				const revisioned = yield* engine
					.readRevisioned("ns", "missing")
					.pipe(Effect.flip);
				expect(revisioned._tag).toBe("UnknownReplicant");
			}),
		),
	);
});

describe("persistence", () => {
	test(
		"persists each written value, in write order",
		testPersistence(
			Effect.gen(function* () {
				const scope = yield* Scope.make();
				const engine = yield* engineIn(scope);
				yield* engine.initializeReplicant("ns", "a", 0);
				storage.write.mockClear();

				yield* engine.commitValue("ns", "a", 1);
				yield* engine.commitValue("ns", "a", 2);
				yield* engine.commitValue("ns", "a", 3);

				yield* waitFor(() => expect(storage.write).toHaveBeenCalledTimes(3));
				expect(storage.write.mock.calls).toEqual([
					["ns", "a", 1],
					["ns", "a", 2],
					["ns", "a", 3],
				]);
			}),
		),
	);

	test(
		"closing the scope writes every replicant, so an unreached write is not lost",
		testPersistence(
			Effect.gen(function* () {
				const scope = yield* Scope.make();
				const engine = yield* engineIn(scope);
				yield* engine.initializeReplicant("ns", "a", 0);
				yield* engine.initializeReplicant("ns", "b", 0);
				storage.write.mockClear();

				yield* engine.commitValue("ns", "a", 9);
				yield* engine.commitValue("ns", "b", 8);
				yield* waitFor(() => expect(storage.write).toHaveBeenCalledTimes(2));
				storage.write.mockClear();

				yield* Scope.close(scope, Exit.void);
				expect(storage.write.mock.calls).toEqual([
					["ns", "a", 9],
					["ns", "b", 8],
				]);
			}),
		),
	);

	test(
		"a failed write is logged, not surfaced to the writer",
		testPersistence(
			Effect.gen(function* () {
				const scope = yield* Scope.make();
				const engine = yield* engineIn(scope);
				yield* engine.initializeReplicant("ns", "a", 0);
				storage.write.mockClear();
				storage.write.mockReturnValue(
					new ReplicantNotFound({ namespace: "ns", name: "a" }),
				);

				yield* engine.commitValue("ns", "a", 1);

				yield* waitFor(() => expect(storage.write).toHaveBeenCalledTimes(1));
				expect(yield* engine.readReplicant("ns", "a")).toBe(1);
			}),
		),
	);
});

describe("initializeReplicant", () => {
	test(
		"persists the seed when nothing is stored",
		testPersistence(
			Effect.gen(function* () {
				const scope = yield* Scope.make();
				const engine = yield* engineIn(scope);
				yield* engine.initializeReplicant("ns", "a", 0);

				expect(storage.read).toHaveBeenCalledWith("ns", "a");
				expect(storage.write).toHaveBeenCalledWith("ns", "a", 0, true);
				expect(yield* engine.readReplicant("ns", "a")).toBe(0);
			}),
		),
	);

	test(
		"adopts the stored value and does not write it back",
		testPersistence(
			Effect.gen(function* () {
				const scope = yield* Scope.make();
				storage.read.mockReturnValue(Effect.succeed(42));
				const engine = yield* engineIn(scope);
				yield* engine.initializeReplicant("ns", "a", 0);

				expect(yield* engine.readReplicant("ns", "a")).toBe(42);
				expect(storage.write).not.toHaveBeenCalled();
			}),
		),
	);

	test(
		"fails the load when the seed write fails",
		testPersistence(
			Effect.gen(function* () {
				const scope = yield* Scope.make();
				storage.write.mockReturnValue(
					new ReplicantNotFound({ namespace: "ns", name: "a" }),
				);
				const engine = yield* engineIn(scope);
				const error = yield* engine
					.initializeReplicant("ns", "a", 0)
					.pipe(Effect.flip);

				expect(error._tag).toBe("ReplicantNotFound");
			}),
		),
	);
});

describe("subscribeValues", () => {
	test(
		"seeds with the current value then emits each written value",
		testEngine(
			Effect.gen(function* () {
				const engine = yield* DerivationEngineService;
				yield* engine.initializeReplicant("ns", "a", 1);
				yield* engine.commitValue("ns", "a", 2);
				const stream = yield* engine.subscribeValues("ns", "a");
				const received: JsonValue[] = [];
				yield* Stream.runForEach(stream, (value) =>
					Effect.sync(() => received.push(value)),
				).pipe(Effect.fork);

				yield* waitFor(() => expect(received).toEqual([2]));
				yield* engine.commitValue("ns", "a", 3);
				yield* waitFor(() => expect(received).toEqual([2, 3]));
			}),
		),
	);

	test(
		"emits nothing for a write of the current value",
		testEngine(
			Effect.gen(function* () {
				const engine = yield* DerivationEngineService;
				yield* engine.initializeReplicant("ns", "a", { x: 1 });
				const stream = yield* engine.subscribeValues("ns", "a");
				const received: JsonValue[] = [];
				yield* Stream.runForEach(stream, (value) =>
					Effect.sync(() => received.push(value)),
				).pipe(Effect.fork);

				yield* waitFor(() => expect(received).toEqual([{ x: 1 }]));
				yield* engine.commitValue("ns", "a", { x: 1 });
				yield* engine.commitValue("ns", "a", { x: 2 });
				yield* waitFor(() => expect(received).toEqual([{ x: 1 }, { x: 2 }]));
			}),
		),
	);

	test(
		"filters out writes to other replicants",
		testEngine(
			Effect.gen(function* () {
				const engine = yield* DerivationEngineService;
				yield* engine.initializeReplicant("ns", "a", 1);
				yield* engine.initializeReplicant("ns", "b", 1);
				const stream = yield* engine.subscribeValues("ns", "a");
				const received: JsonValue[] = [];
				yield* Stream.runForEach(stream, (value) =>
					Effect.sync(() => received.push(value)),
				).pipe(Effect.fork);

				yield* waitFor(() => expect(received).toEqual([1]));
				yield* engine.commitValue("ns", "b", 99);
				yield* engine.commitValue("ns", "a", 2);
				yield* waitFor(() => expect(received).toEqual([1, 2]));
			}),
		),
	);

	test(
		"fails for an unregistered replicant",
		testEngine(
			Effect.gen(function* () {
				const engine = yield* DerivationEngineService;
				const error = yield* engine
					.subscribeValues("ns", "missing")
					.pipe(Effect.flip);
				expect(error._tag).toBe("UnknownReplicant");
			}),
		),
	);
});

describe("computed", () => {
	test(
		"readComputed fails for an unregistered computed",
		testEngine(
			Effect.gen(function* () {
				const engine = yield* DerivationEngineService;
				const exit = yield* engine
					.readComputed("ns", "missing")
					.pipe(Effect.exit);
				assert(Exit.isFailure(exit));
			}),
		),
	);

	test(
		"dies when a computed is initialized twice",
		testEngine(
			Effect.gen(function* () {
				const engine = yield* DerivationEngineService;
				yield* engine.initializeComputed("ns", "c", () =>
					Exit.succeed("first"),
				);
				const exit = yield* engine
					.initializeComputed("ns", "c", () => Exit.succeed("second"))
					.pipe(Effect.exit);
				assert(Exit.isFailure(exit));
				expect(Cause.pretty(exit.cause)).toContain("already registered");
			}),
		),
	);

	test(
		"never computes until read or subscribed",
		testEngine(
			Effect.gen(function* () {
				const engine = yield* DerivationEngineService;
				let evaluations = 0;
				yield* engine.initializeComputed("ns", "c", () => {
					evaluations += 1;
					return Exit.succeed(1);
				});
				expect(evaluations).toBe(0);
				yield* engine.readComputed("ns", "c");
				expect(evaluations).toBe(1);
			}),
		),
	);

	test(
		"a self-reading computed surfaces the read failure as a defect",
		testEngine(
			Effect.gen(function* () {
				const engine = yield* DerivationEngineService;
				yield* engine.initializeComputed("ns", "c", () =>
					Effect.runSyncExit(engine.readComputed("ns", "c").pipe(Effect.orDie)),
				);
				const exit = yield* engine.readComputed("ns", "c").pipe(Effect.exit);
				assert(Exit.isFailure(exit));
				expect(Cause.pretty(exit.cause)).toContain(
					'Reading value for "c" in "ns" failed',
				);
			}),
		),
	);
});

describe("subscribeComputed", () => {
	test(
		"seeds immediately and dedupes on the encoded key",
		testEngine(
			Effect.gen(function* () {
				const engine = yield* DerivationEngineService;
				yield* engine.initializeReplicant("ns", "a", 12);
				yield* engine.initializeComputed("ns", "tens", () =>
					Effect.runSync(
						Effect.gen(function* () {
							const value = yield* engine.readReplicant("ns", "a");
							const number = yield* Schema.decodeUnknown(Schema.Number)(value);
							return Math.floor(number / 10);
						}).pipe(Effect.orDie, Effect.exit),
					),
				);
				const stream = yield* engine.subscribeComputed("ns", "tens");
				const received: JsonValue[] = [];
				yield* Stream.runForEach(stream, (value) =>
					Effect.sync(() => received.push(value)),
				).pipe(Effect.fork);

				yield* waitFor(() => expect(received).toEqual([1]));
				yield* engine.commitValue("ns", "a", 15);
				yield* engine.commitValue("ns", "a", 27);
				yield* waitFor(() => expect(received).toEqual([1, 2]));
			}),
		),
	);

	test(
		"a failing evaluation is skipped and the stream continues",
		testEngine(
			Effect.gen(function* () {
				const engine = yield* DerivationEngineService;
				yield* engine.initializeReplicant("ns", "a", 1);
				yield* engine.initializeComputed("ns", "c", () =>
					Effect.runSync(
						Effect.gen(function* () {
							const value = yield* engine
								.readReplicant("ns", "a")
								.pipe(Effect.orDie);
							if (value === 2) {
								return yield* new ComputedComputeError({
									namespace: "ns",
									name: "c",
									cause: new Error("boom"),
								});
							}
							return value;
						}).pipe(Effect.exit),
					),
				);
				const stream = yield* engine.subscribeComputed("ns", "c");
				const received: JsonValue[] = [];
				yield* Stream.runForEach(stream, (value) =>
					Effect.sync(() => received.push(value)),
				).pipe(Effect.fork);

				yield* waitFor(() => expect(received).toEqual([1]));
				yield* engine.commitValue("ns", "a", 2);
				yield* engine.commitValue("ns", "a", 3);
				yield* waitFor(() => expect(received).toEqual([1, 3]));
			}),
		),
	);

	test(
		"fails the subscribe when the current value cannot be produced",
		testEngine(
			Effect.gen(function* () {
				const engine = yield* DerivationEngineService;
				yield* engine.initializeReplicant("ns", "a", 2);
				yield* engine.initializeComputed("ns", "c", () =>
					Effect.runSync(
						Effect.gen(function* () {
							const value = yield* engine
								.readReplicant("ns", "a")
								.pipe(Effect.orDie);
							if (value === 2) {
								return yield* new ComputedComputeError({
									namespace: "ns",
									name: "c",
									cause: new Error("boom"),
								});
							}
							return value;
						}).pipe(Effect.exit),
					),
				);
				const exit = yield* Effect.scoped(
					engine.subscribeComputed("ns", "c"),
				).pipe(Effect.exit);
				assert(Exit.isFailure(exit));
				expect(Cause.pretty(exit.cause)).toContain("boom");
			}),
		),
	);

	test(
		"closing the subscription scope disarms the computed",
		testEngine(
			Effect.gen(function* () {
				const engine = yield* DerivationEngineService;
				yield* engine.initializeReplicant("ns", "a", 1);
				let evaluations = 0;
				yield* engine.initializeComputed("ns", "c", () => {
					evaluations += 1;
					return Effect.runSync(
						engine.readReplicant("ns", "a").pipe(Effect.orDie, Effect.exit),
					);
				});
				yield* Effect.scoped(engine.subscribeComputed("ns", "c"));
				expect(evaluations).toBe(1);
				yield* engine.commitValue("ns", "a", 2);
				expect(evaluations).toBe(1);
			}),
		),
	);

	test(
		"fails for an unregistered computed",
		testEngine(
			Effect.gen(function* () {
				const engine = yield* DerivationEngineService;
				const exit = yield* Effect.scoped(
					engine.subscribeComputed("ns", "missing"),
				).pipe(Effect.exit);
				assert(Exit.isFailure(exit));
				expect(Cause.pretty(exit.cause)).toContain("does not exist");
			}),
		),
	);
});
