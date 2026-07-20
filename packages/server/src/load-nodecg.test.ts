import { defineNamespace, extendNamespace } from "@nodecg/core";
import { makeTestEffect } from "@nodecg/internal/test-utils";
import { Cause, Effect, Layer, Option, Queue, Schema } from "effect";
import { assert, describe, expect, test, vi } from "vitest";

import {
	implementExtendedNamespace,
	implementNamespace,
} from "./implement-namespace.ts";
import { loadNodeCG, loadNodeCGEffect } from "./load-nodecg.ts";
import { InMemoryReplicantStorage } from "./services/replicant-storage/in-memory-replicant-storage.ts";
import {
	type ReplicantChange,
	type ReplicantStorage,
	ReplicantNotFound,
} from "./services/replicant-storage/replicant-storage.ts";
import { InMemoryTopicBroker } from "./services/topic-broker/in-memory-topic-broker.ts";

const testEffect = makeTestEffect(
	Layer.merge(InMemoryReplicantStorage, InMemoryTopicBroker),
);

const counter = implementNamespace(
	defineNamespace("counter", {
		replicant: { count: { schema: Schema.NumberFromString } },
		rpc: {
			bump: {
				schema: { request: Schema.Number, response: Schema.Number },
				permission: { write: { everyone: "allow" } },
			},
		},
	}),
	{
		seedReplicant: { count: () => 1 },
		implementRpc: {
			bump: (by, ctx) => {
				ctx.replicant.count.update((count) => count + by);
				return ctx.replicant.count.get();
			},
		},
	},
);

const settings = implementNamespace(
	defineNamespace("settings", {
		replicant: { multiplier: { schema: Schema.NumberFromString } },
	}),
	{ seedReplicant: { multiplier: () => 3 } },
);

describe("namespaces", () => {
	test(
		"returns a concretely-typed plain handle per loaded namespace",
		testEffect(
			Effect.gen(function* () {
				const { namespaces } = yield* loadNodeCGEffect({
					namespaces: { counter },
				});

				const handle = namespaces.counter;
				expect(handle.replicant.count.get()).toBe(1);
				handle.replicant.count.set(5);
				expect(handle.replicant.count.get()).toBe(5);
				expect(yield* Effect.promise(() => handle.rpc.bump(2))).toBe(7);
			}),
		),
	);

	test(
		"a namespace that was not aggregated does not exist on the return",
		testEffect(
			Effect.gen(function* () {
				const { namespaces } = yield* loadNodeCGEffect({
					namespaces: { counter },
				});

				// @ts-expect-error settings was not passed to loadNodeCG
				void namespaces.settings;
				expect("settings" in namespaces).toBe(false);
			}),
		),
	);
});

describe("computed validation", () => {
	const manifest = defineNamespace("broken", {
		replicant: { value: { schema: Schema.NumberFromString } },
		computed: { derived: { schema: Schema.NumberFromString } },
	});

	test(
		"fails the load when a compute fn throws",
		testEffect(
			Effect.gen(function* () {
				const implemented = implementNamespace(manifest, {
					seedReplicant: { value: () => 0 },
					implementComputed: {
						derived: () => {
							throw new Error("boom");
						},
					},
				});

				const error = yield* loadNodeCGEffect({
					namespaces: { broken: implemented },
				}).pipe(Effect.flip);

				expect(error._tag).toBe("ComputedComputeError");
			}),
		),
	);

	test(
		"fails the load when a computed value fails its schema",
		testEffect(
			Effect.gen(function* () {
				const implemented = implementNamespace(manifest, {
					seedReplicant: { value: () => 0 },
					implementComputed: {
						derived: () => "nope" as unknown as number,
					},
				});

				const error = yield* loadNodeCGEffect({
					namespaces: { broken: implemented },
				}).pipe(Effect.flip);

				expect(error._tag).toBe("FieldEncodeError");
			}),
		),
	);

	test(
		"validates a cross-namespace computed listed before its source",
		testEffect(
			Effect.gen(function* () {
				const scoreboard = implementNamespace(
					defineNamespace("scoreboard", {
						replicant: { total: { schema: Schema.NumberFromString } },
						computed: { weighted: { schema: Schema.NumberFromString } },
					}),
					{
						seedReplicant: { total: () => 10 },
						implementComputed: {
							weighted: (ctx) =>
								ctx.replicant.total.get() *
								ctx.use(settings).replicant.multiplier.get(),
						},
					},
				);

				const { namespaces } = yield* loadNodeCGEffect({
					namespaces: { scoreboard, settings },
				});

				expect(namespaces.scoreboard.computed.weighted.get()).toBe(30);
			}),
		),
	);

	test(
		"fails the load when computed fields form a cycle",
		testEffect(
			Effect.gen(function* () {
				const cyclic = implementNamespace(
					defineNamespace("cyclic", {
						computed: {
							a: { schema: Schema.Number },
							b: { schema: Schema.Number },
						},
					}),
					{
						implementComputed: {
							a: (ctx) => ctx.computed.b.get() + 1,
							b: (ctx) => ctx.computed.a.get() + 1,
						},
					},
				);

				const error = yield* loadNodeCGEffect({
					namespaces: { cyclic },
				}).pipe(Effect.flip);

				expect(error._tag).toBe("ComputedComputeError");
				expect(error.message).toContain("Cycle detected");
			}),
		),
	);
});

describe("onLoad", () => {
	test(
		"runs with the plain handle after every namespace is built",
		testEffect(
			Effect.gen(function* () {
				const stats = implementNamespace(
					defineNamespace("stats", {
						replicant: { viewers: { schema: Schema.NumberFromString } },
					}),
					{
						seedReplicant: { viewers: () => 0 },
						onLoad: (ctx) => {
							ctx.replicant.viewers.set(
								ctx.use(settings).replicant.multiplier.get() * 100,
							);
						},
					},
				);

				const { namespaces } = yield* loadNodeCGEffect({
					namespaces: { stats, settings },
				});

				expect(namespaces.stats.replicant.viewers.get()).toBe(300);
			}),
		),
	);

	test(
		"runs the returned cleanup when the load scope closes",
		testEffect(
			Effect.gen(function* () {
				const cleanup = vi.fn();
				const stats = implementNamespace(
					defineNamespace("stats", {
						replicant: { viewers: { schema: Schema.NumberFromString } },
					}),
					{
						seedReplicant: { viewers: () => 0 },
						onLoad: () => cleanup,
					},
				);

				yield* Effect.scoped(loadNodeCGEffect({ namespaces: { stats } }));

				expect(cleanup).toHaveBeenCalledTimes(1);
			}),
		),
	);

	test(
		"runs both the base and the extension onLoad, cleaning up in reverse",
		testEffect(
			Effect.gen(function* () {
				const calls: string[] = [];
				const baseNs = implementNamespace(
					defineNamespace("composed", {
						replicant: { a: { schema: Schema.NumberFromString } },
					}),
					{
						seedReplicant: { a: () => 0 },
						onLoad: () => {
							calls.push("base:setup");
							return () => {
								calls.push("base:cleanup");
							};
						},
					},
				);
				const extended = implementExtendedNamespace(
					extendNamespace(baseNs.manifest, {
						replicant: { b: { schema: Schema.NumberFromString } },
					}),
					baseNs,
					{
						seedReplicant: { b: () => 0 },
						onLoad: () => {
							calls.push("extension:setup");
							return () => {
								calls.push("extension:cleanup");
							};
						},
					},
				);

				yield* Effect.scoped(
					Effect.gen(function* () {
						yield* loadNodeCGEffect({ namespaces: { composed: extended } });
						expect(calls).toEqual(["base:setup", "extension:setup"]);
					}),
				);

				expect(calls).toEqual([
					"base:setup",
					"extension:setup",
					"extension:cleanup",
					"base:cleanup",
				]);
			}),
		),
	);

	test(
		"a rejecting onLoad fails the whole load as OnLoadError",
		testEffect(
			Effect.gen(function* () {
				const stats = implementNamespace(
					defineNamespace("stats", {
						replicant: { viewers: { schema: Schema.NumberFromString } },
					}),
					{
						seedReplicant: { viewers: () => 0 },
						onLoad: async () => {
							throw new Error("no connection");
						},
					},
				);

				const error = yield* loadNodeCGEffect({ namespaces: { stats } }).pipe(
					Effect.flip,
				);

				expect(error._tag).toBe("OnLoadError");
				expect(error.message).toContain('"stats"');
				expect(error.message).toContain("no connection");
			}),
		),
	);
});

describe("duplicate namespaces", () => {
	test(
		"dies when the same namespace is listed under two keys",
		testEffect(
			Effect.gen(function* () {
				const cause = yield* loadNodeCGEffect({
					namespaces: { first: counter, second: counter },
				}).pipe(Effect.sandbox, Effect.flip);

				const defect = Cause.dieOption(cause);
				assert(Option.isSome(defect));
				assert(defect.value instanceof Error);
				expect(defect.value.message).toContain('"counter" was loaded twice');
			}),
		),
	);
});

describe("loadNodeCG", () => {
	test("seeds through the injected plain storage and serves the handles", async () => {
		const storage = {
			read: vi.fn<ReplicantStorage["read"]>(
				(namespace, name) => new ReplicantNotFound({ namespace, name }),
			),
			write: vi.fn<ReplicantStorage["write"]>(() => Effect.void),
			subscribe: vi.fn<ReplicantStorage["subscribe"]>(() =>
				Queue.unbounded<ReplicantChange>(),
			),
			flush: vi.fn<ReplicantStorage["flush"]>(() => Effect.void),
		} satisfies ReplicantStorage;

		const nodecg = await loadNodeCG({ namespaces: { settings }, storage });

		expect(storage.write).toHaveBeenCalledWith(
			"settings",
			"multiplier",
			"3",
			true,
		);
		expect(nodecg.namespaces.settings.replicant.multiplier.get()).toBe(3);
	});
});
