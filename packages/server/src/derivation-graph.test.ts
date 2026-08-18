import { makeTestEffect } from "@nodecg/internal/test-utils";
import {
	Cause,
	Context,
	Effect,
	Exit,
	Layer,
	Runtime,
	Schema,
	Scope,
	Stream,
} from "effect";
import type { JsonValue } from "type-fest";
import { afterEach, assert, describe, expect, test, vi } from "vitest";

import {
	ComputedComputeError,
	DerivationEngineService,
	type ReplicantFrame,
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

describe("readReplicant", () => {
	test(
		"fails for an unregistered replicant",
		testEngine(
			Effect.gen(function* () {
				const engine = yield* DerivationEngineService;
				const error = yield* engine
					.readReplicant("ns", "missing")
					.pipe(Effect.flip);
				expect(error._tag).toBe("UnknownReplicant");
			}),
		),
	);
});

describe("commit", () => {
	test(
		"commits a whole value, read back with the revision bumped",
		testEngine(
			Effect.gen(function* () {
				const engine = yield* DerivationEngineService;
				yield* engine.initializeReplicant("ns", "a", 1);
				expect(yield* engine.readReplicant("ns", "a")).toEqual({
					value: 1,
					revision: 0,
				});
				const committed = yield* engine.commit("ns", "a", () =>
					Effect.succeed(2),
				);
				expect(committed).toEqual({ value: 2, revision: 1 });
				expect(yield* engine.readReplicant("ns", "a")).toEqual({
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
				yield* engine.commit("ns", "a", () => Effect.succeed({ x: 2 }));
				const before = yield* engine.readReplicant("ns", "a");
				const committed = yield* engine.commit("ns", "a", () =>
					Effect.succeed({ x: 2 }),
				);
				expect(committed).toEqual(before);
				expect(yield* engine.readReplicant("ns", "a")).toEqual(before);
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
						engine.readReplicant("ns", "a").pipe(
							Effect.map((r) => r.value),
							Effect.orDie,
							Effect.exit,
						),
					);
				});
				yield* engine.subscribeComputed("ns", "c");
				expect(evaluations).toBe(1);
				yield* engine.commit("ns", "a", () => Effect.succeed({ x: 1 }));
				expect(evaluations).toBe(1);
				yield* engine.commit("ns", "a", () => Effect.succeed({ x: 2 }));
				expect(evaluations).toBe(2);
			}),
		),
	);

	test(
		"produces the next value from the current one and bumps the revision",
		testEngine(
			Effect.gen(function* () {
				const engine = yield* DerivationEngineService;
				yield* engine.initializeReplicant("ns", "a", 1);
				const committed = yield* engine.commit("ns", "a", (current) =>
					Effect.succeed(typeof current === "number" ? current + 1 : 0),
				);
				expect(committed).toEqual({ value: 2, revision: 1 });
				expect(yield* engine.readReplicant("ns", "a")).toEqual({
					value: 2,
					revision: 1,
				});
			}),
		),
	);

	test(
		"a produce yielding the current value does not bump the revision",
		testEngine(
			Effect.gen(function* () {
				const engine = yield* DerivationEngineService;
				yield* engine.initializeReplicant("ns", "a", { x: 1 });
				const committed = yield* engine.commit("ns", "a", () =>
					Effect.succeed({ x: 1 }),
				);
				expect(committed).toEqual({ value: { x: 1 }, revision: 0 });
			}),
		),
	);

	test(
		"an updater may synchronously write another replicant mid-produce",
		testEngine(
			Effect.gen(function* () {
				const engine = yield* DerivationEngineService;
				const runtime = yield* Effect.runtime<never>();
				yield* engine.initializeReplicant("ns", "a", 1);
				yield* engine.initializeReplicant("ns", "b", 1);
				const committed = yield* engine.commit("ns", "a", (current) =>
					Effect.sync(() => {
						Runtime.runSync(
							runtime,
							engine.commit("ns", "b", () => Effect.succeed(5)),
						);
						return typeof current === "number" ? current + 1 : 0;
					}),
				);
				expect(committed.value).toBe(2);
				expect((yield* engine.readReplicant("ns", "b")).value).toBe(5);
			}),
		),
	);

	test(
		"a single attempt fails CommitContended when a concurrent commit lands between produce and commit",
		testEngine(
			Effect.gen(function* () {
				const engine = yield* DerivationEngineService;
				const runtime = yield* Effect.runtime<never>();
				yield* engine.initializeReplicant("ns", "a", 1);
				const error = yield* engine
					.commit("ns", "a", (current) =>
						Effect.sync(() => {
							Runtime.runSync(
								runtime,
								engine.commit("ns", "a", () => Effect.succeed(100)),
							);
							return typeof current === "number" ? current + 1 : 0;
						}),
					)
					.pipe(Effect.flip);
				expect(error._tag).toBe("CommitContended");
				// The concurrent write landed, the losing attempt did not overwrite it.
				expect((yield* engine.readReplicant("ns", "a")).value).toBe(100);
			}),
		),
	);

	test(
		"fails for an unregistered replicant",
		testEngine(
			Effect.gen(function* () {
				const engine = yield* DerivationEngineService;
				const error = yield* engine
					.commit("ns", "missing", () => Effect.succeed(1))
					.pipe(Effect.flip);
				expect(error._tag).toBe("UnknownReplicant");
			}),
		),
	);
});

describe("commitPatch", () => {
	const noValidate = () => Effect.void;

	test(
		"applies a field-level patch and bumps the revision",
		testEngine(
			Effect.gen(function* () {
				const engine = yield* DerivationEngineService;
				yield* engine.initializeReplicant("ns", "a", { a: 1, b: 2 });
				const committed = yield* engine.commitPatch(
					"ns",
					"a",
					[{ op: "replace", path: "/a", value: 5 }],
					noValidate,
				);
				expect(committed).toEqual({ value: { a: 5, b: 2 }, revision: 1 });
				expect(yield* engine.readReplicant("ns", "a")).toEqual({
					value: { a: 5, b: 2 },
					revision: 1,
				});
			}),
		),
	);

	test(
		"fails PatchNotApplicable and leaves the value untouched",
		testEngine(
			Effect.gen(function* () {
				const engine = yield* DerivationEngineService;
				yield* engine.initializeReplicant("ns", "a", { a: 1 });
				const error = yield* engine
					.commitPatch(
						"ns",
						"a",
						[{ op: "replace", path: "/missing", value: 5 }],
						noValidate,
					)
					.pipe(Effect.flip);
				assert(error._tag === "PatchNotApplicable");
				expect(error.path).toBe("/missing");
				expect(error.reason).toBe("MissingKey");
				expect(yield* engine.readReplicant("ns", "a")).toEqual({
					value: { a: 1 },
					revision: 0,
				});
			}),
		),
	);

	test(
		"a validate failure propagates and nothing is written",
		testEngine(
			Effect.gen(function* () {
				const engine = yield* DerivationEngineService;
				yield* engine.initializeReplicant("ns", "a", { a: 1 });
				const error = yield* engine
					.commitPatch(
						"ns",
						"a",
						[{ op: "replace", path: "/a", value: 5 }],
						() => Effect.fail(new Error("invalid")),
					)
					.pipe(Effect.flip);
				assert(error instanceof Error);
				expect(error.message).toBe("invalid");
				expect(yield* engine.readReplicant("ns", "a")).toEqual({
					value: { a: 1 },
					revision: 0,
				});
			}),
		),
	);

	test(
		"a patch applying to the current value does not bump the revision",
		testEngine(
			Effect.gen(function* () {
				const engine = yield* DerivationEngineService;
				yield* engine.initializeReplicant("ns", "a", { a: 1 });
				const committed = yield* engine.commitPatch(
					"ns",
					"a",
					[{ op: "replace", path: "/a", value: 1 }],
					noValidate,
				);
				expect(committed).toEqual({ value: { a: 1 }, revision: 0 });
			}),
		),
	);

	test(
		"fails for an unregistered replicant",
		testEngine(
			Effect.gen(function* () {
				const engine = yield* DerivationEngineService;
				const error = yield* engine
					.commitPatch(
						"ns",
						"missing",
						[{ op: "replace", path: "", value: 1 }],
						noValidate,
					)
					.pipe(Effect.flip);
				expect(error._tag).toBe("UnknownReplicant");
			}),
		),
	);
});

describe("subscribeReplicant", () => {
	test(
		"seeds with a snapshot frame then emits a frame per commit",
		testEngine(
			Effect.gen(function* () {
				const engine = yield* DerivationEngineService;
				yield* engine.initializeReplicant("ns", "a", 1);
				yield* engine.commit("ns", "a", () => Effect.succeed(2));
				const stream = yield* engine.subscribeReplicant("ns", "a");
				const frames: ReplicantFrame[] = [];
				yield* Stream.runForEach(stream, (frame) =>
					Effect.sync(() => frames.push(frame)),
				).pipe(Effect.fork);

				yield* waitFor(() =>
					expect(frames).toEqual([{ kind: "snapshot", value: 2, revision: 1 }]),
				);
				yield* engine.commit("ns", "a", () => Effect.succeed(3));
				yield* waitFor(() =>
					expect(frames).toEqual([
						{ kind: "snapshot", value: 2, revision: 1 },
						{ kind: "snapshot", value: 3, revision: 2 },
					]),
				);
			}),
		),
	);

	test(
		"emits no frame for a commit of the current value",
		testEngine(
			Effect.gen(function* () {
				const engine = yield* DerivationEngineService;
				yield* engine.initializeReplicant("ns", "a", { x: 1 });
				const stream = yield* engine.subscribeReplicant("ns", "a");
				const frames: ReplicantFrame[] = [];
				yield* Stream.runForEach(stream, (frame) =>
					Effect.sync(() => frames.push(frame)),
				).pipe(Effect.fork);

				yield* waitFor(() =>
					expect(frames).toEqual([
						{ kind: "snapshot", value: { x: 1 }, revision: 0 },
					]),
				);
				yield* engine.commit("ns", "a", () => Effect.succeed({ x: 1 }));
				yield* engine.commit("ns", "a", () => Effect.succeed({ x: 2 }));
				yield* waitFor(() =>
					expect(frames).toEqual([
						{ kind: "snapshot", value: { x: 1 }, revision: 0 },
						{ kind: "snapshot", value: { x: 2 }, revision: 1 },
					]),
				);
			}),
		),
	);

	test(
		"filters out commits to other replicants",
		testEngine(
			Effect.gen(function* () {
				const engine = yield* DerivationEngineService;
				yield* engine.initializeReplicant("ns", "a", 1);
				yield* engine.initializeReplicant("ns", "b", 1);
				const stream = yield* engine.subscribeReplicant("ns", "a");
				const frames: ReplicantFrame[] = [];
				yield* Stream.runForEach(stream, (frame) =>
					Effect.sync(() => frames.push(frame)),
				).pipe(Effect.fork);

				yield* waitFor(() =>
					expect(frames).toEqual([{ kind: "snapshot", value: 1, revision: 0 }]),
				);
				yield* engine.commit("ns", "b", () => Effect.succeed(99));
				yield* engine.commit("ns", "a", () => Effect.succeed(2));
				yield* waitFor(() =>
					expect(frames).toEqual([
						{ kind: "snapshot", value: 1, revision: 0 },
						{ kind: "snapshot", value: 2, revision: 1 },
					]),
				);
			}),
		),
	);

	test(
		"fails for an unregistered replicant",
		testEngine(
			Effect.gen(function* () {
				const engine = yield* DerivationEngineService;
				const error = yield* engine
					.subscribeReplicant("ns", "missing")
					.pipe(Effect.flip);
				expect(error._tag).toBe("UnknownReplicant");
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

				yield* engine.commit("ns", "a", () => Effect.succeed(1));
				yield* engine.commit("ns", "a", () => Effect.succeed(2));
				yield* engine.commit("ns", "a", () => Effect.succeed(3));

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

				yield* engine.commit("ns", "a", () => Effect.succeed(9));
				yield* engine.commit("ns", "b", () => Effect.succeed(8));
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

				yield* engine.commit("ns", "a", () => Effect.succeed(1));

				yield* waitFor(() => expect(storage.write).toHaveBeenCalledTimes(1));
				expect((yield* engine.readReplicant("ns", "a")).value).toBe(1);
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
				expect((yield* engine.readReplicant("ns", "a")).value).toBe(0);
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

				expect((yield* engine.readReplicant("ns", "a")).value).toBe(42);
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
							const { value } = yield* engine.readReplicant("ns", "a");
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
				yield* engine.commit("ns", "a", () => Effect.succeed(15));
				yield* engine.commit("ns", "a", () => Effect.succeed(27));
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
							const { value } = yield* engine
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
				yield* engine.commit("ns", "a", () => Effect.succeed(2));
				yield* engine.commit("ns", "a", () => Effect.succeed(3));
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
							const { value } = yield* engine
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
						engine.readReplicant("ns", "a").pipe(
							Effect.map((r) => r.value),
							Effect.orDie,
							Effect.exit,
						),
					);
				});
				yield* Effect.scoped(engine.subscribeComputed("ns", "c"));
				expect(evaluations).toBe(1);
				yield* engine.commit("ns", "a", () => Effect.succeed(2));
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
