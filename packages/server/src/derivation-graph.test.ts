import { makeTestEffect } from "@nodecg/internal/test-utils";
import { Cause, Effect, Exit, Schema, Stream } from "effect";
import type { JsonValue } from "type-fest";
import { assert, describe, expect, test, vi } from "vitest";

import {
	ComputedComputeError,
	DerivationEngineService,
} from "./derivation-graph.ts";

const testEngine = makeTestEffect(DerivationEngineService.Default);

const waitFor = (assertion: () => void) =>
	Effect.promise(() => vi.waitFor(assertion));

describe("replicant", () => {
	test(
		"readReplicant fails for an unregistered replicant and returns its value once registered",
		testEngine(
			Effect.gen(function* () {
				const engine = yield* DerivationEngineService;
				const missing = yield* engine
					.readReplicant("ns", "a")
					.pipe(Effect.exit);
				assert(Exit.isFailure(missing));
				yield* engine.initializeReplicant("ns", "a", 1);
				expect(yield* engine.readReplicant("ns", "a")).toEqual(1);
				yield* engine.writeReplicant("ns", "a", 2);
				expect(yield* engine.readReplicant("ns", "a")).toEqual(2);
			}),
		),
	);

	test(
		"a value-equal write does not re-evaluate dependents",
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
				yield* engine.writeReplicant("ns", "a", { x: 1 });
				expect(evaluations).toBe(1);
				yield* engine.writeReplicant("ns", "a", { x: 2 });
				expect(evaluations).toBe(2);
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
				yield* engine.writeReplicant("ns", "a", 15);
				yield* engine.writeReplicant("ns", "a", 27);
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
				yield* engine.writeReplicant("ns", "a", 2);
				yield* engine.writeReplicant("ns", "a", 3);
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
				yield* engine.writeReplicant("ns", "a", 2);
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
