import { defineNamespace, extendNamespace } from "@nodecg/core";
import { testEffect } from "@nodecg/internal/test-utils";
import { Effect, Layer, Schema } from "effect";
import { describe, expect, test } from "vitest";

import { buildNamespace } from "./build-namespace.ts";
import {
	implementExtendedNamespace,
	implementNamespace,
} from "./implement-namespace.ts";
import { InMemoryReplicantStorage } from "./services/replicant-storage/in-memory-replicant-storage.ts";
import { InMemoryTopicBroker } from "./services/topic-broker/in-memory-topic-broker.ts";

const storage = Layer.merge(InMemoryReplicantStorage, InMemoryTopicBroker);

describe("implementNamespace", () => {
	test("bundles the manifest with its impl", () => {
		const manifest = defineNamespace("ns", {
			replicant: { count: { schema: Schema.Number } },
		});
		const seedReplicant = { count: () => 7 };

		const implemented = implementNamespace(manifest, { seedReplicant });

		expect(implemented.manifest).toBe(manifest);
		expect(implemented.impl).toEqual({ seedReplicant });
	});

	test("takes no impl when there is nothing to implement", () => {
		const manifest = defineNamespace("ns", {
			topic: { goal: { schema: Schema.String } },
		});

		expect(implementNamespace(manifest).impl).toBeUndefined();
	});
});

describe("implementExtendedNamespace", () => {
	const base = defineNamespace("match", {
		replicant: {
			score: { schema: Schema.Number },
			label: { schema: Schema.String },
		},
	});
	const baseImplemented = implementNamespace(base, {
		seedReplicant: { score: () => 10, label: () => "m1" },
	});

	test(
		"merges the base impl with the supplement, then builds once",
		testEffect(
			Effect.gen(function* () {
				const extended = extendNamespace(base, {
					replicant: { round: { schema: Schema.Number } },
					computed: { total: { schema: Schema.Number } },
				});

				const implemented = implementExtendedNamespace(
					extended,
					baseImplemented,
					{
						seedReplicant: { round: () => 3 },
						implementComputed: {
							total: (sources) => sources.score + sources.round,
						},
					},
				);

				const built = yield* buildNamespace(
					implemented.manifest,
					implemented.impl,
				);

				expect(yield* built.replicant.score.get()).toBe(10);
				expect(yield* built.replicant.round.get()).toBe(3);
				expect(yield* built.computed.total.get()).toBe(13);
			}).pipe(Effect.provide(storage)),
		),
	);

	test("carries the base frontend config over unless overridden", () => {
		const extended = extendNamespace(base, {
			replicant: { round: { schema: Schema.Number } },
		});
		const withFrontend = implementNamespace(base, {
			seedReplicant: { score: () => 0, label: () => "" },
			frontend: { dir: "/base" },
		});

		const inherited = implementExtendedNamespace(extended, withFrontend, {
			seedReplicant: { round: () => 0 },
		});
		const overridden = implementExtendedNamespace(
			extended,
			withFrontend,
			{ seedReplicant: { round: () => 0 } },
			{ frontend: { dir: "/extended" } },
		);

		expect(inherited.impl?.frontend).toEqual({ dir: "/base" });
		expect(overridden.impl?.frontend).toEqual({ dir: "/extended" });
	});

	test("omitting impl for a newly-added field is a type error", async () => {
		const extended = extendNamespace(base, {
			replicant: { round: { schema: Schema.Number } },
		});

		const implemented = implementExtendedNamespace(extended, baseImplemented, {
			// @ts-expect-error missing seedReplicant for the newly-added "round"
			seedReplicant: {},
		});

		await expect(
			Effect.runPromise(
				buildNamespace(implemented.manifest, implemented.impl).pipe(
					Effect.provide(storage),
					Effect.scoped,
				),
			),
		).rejects.toThrow(/Missing seed value for replicant "round"/);
	});
});
