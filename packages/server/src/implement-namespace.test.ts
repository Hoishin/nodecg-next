import { defineNamespace, extendNamespace } from "@nodecg/core";
import { CurrentIdentity, ServerIdentitySchema } from "@nodecg/internal";
import { makeTestEffect } from "@nodecg/internal/test-utils";
import { Effect, Layer, Schema } from "effect";
import { describe, expect, test } from "vitest";

import { BuiltNamespaceRegistry } from "./build-fields.ts";
import { buildNamespace } from "./build-namespace.ts";
import { DerivationEngineService } from "./derivation-graph.ts";
import {
	implementExtendedNamespace,
	implementNamespace,
} from "./implement-namespace.ts";
import { InMemoryReplicantStorage } from "./services/replicant-storage/in-memory-replicant-storage.ts";
import { InMemoryTopicBroker } from "./services/topic-broker/in-memory-topic-broker.ts";

const testEffect = makeTestEffect(
	Layer.mergeAll(
		Layer.succeed(CurrentIdentity, ServerIdentitySchema.make()),
		InMemoryReplicantStorage,
		InMemoryTopicBroker,
		DerivationEngineService.Default,
		BuiltNamespaceRegistry.Default,
	),
);

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

	test("bundles onLoad alongside the field impls", () => {
		const manifest = defineNamespace("ns", {
			replicant: { count: { schema: Schema.Number } },
		});
		const onLoad = () => {};

		const implemented = implementNamespace(manifest, {
			seedReplicant: { count: () => 0 },
			onLoad,
		});

		expect(implemented.impl?.onLoad).toBe(onLoad);
	});

	test("takes onLoad on a fieldless namespace", () => {
		const manifest = defineNamespace("ns", {
			topic: { goal: { schema: Schema.String } },
		});
		const onLoad = () => {};

		expect(implementNamespace(manifest, { onLoad }).impl?.onLoad).toBe(onLoad);
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
							total: (ctx) =>
								ctx.replicant.score.get() + ctx.replicant.round.get(),
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
			}),
		),
	);

	test("merges the base and extension frontend dirs, deduplicated", () => {
		const extended = extendNamespace(base, {
			replicant: { round: { schema: Schema.Number } },
		});
		const withFrontend = implementNamespace(base, {
			seedReplicant: { score: () => 0, label: () => "" },
			frontend: { dir: ["/base", "/shared"] },
		});

		const inherited = implementExtendedNamespace(extended, withFrontend, {
			seedReplicant: { round: () => 0 },
		});
		const merged = implementExtendedNamespace(extended, withFrontend, {
			seedReplicant: { round: () => 0 },
			frontend: { dir: ["/shared", "/extended"] },
		});

		expect(inherited.impl?.frontend).toEqual({ dir: ["/base", "/shared"] });
		expect(merged.impl?.frontend).toEqual({
			dir: ["/base", "/shared", "/extended"],
		});
	});

	test("carries the base onLoad, and composes both when the supplement adds one", () => {
		const extended = extendNamespace(base, {
			replicant: { round: { schema: Schema.Number } },
		});
		const baseOnLoad = () => {};
		const extensionOnLoad = () => {};
		const withOnLoad = implementNamespace(base, {
			seedReplicant: { score: () => 0, label: () => "" },
			onLoad: baseOnLoad,
		});

		const inherited = implementExtendedNamespace(extended, withOnLoad, {
			seedReplicant: { round: () => 0 },
		});
		const composed = implementExtendedNamespace(extended, withOnLoad, {
			seedReplicant: { round: () => 0 },
			onLoad: extensionOnLoad,
		});

		expect(inherited.impl?.onLoad).toBe(baseOnLoad);
		expect(composed.impl?.onLoad).not.toBe(baseOnLoad);
		expect(composed.impl?.onLoad).not.toBe(extensionOnLoad);
		expect(composed.impl?.onLoad).toBeTypeOf("function");
	});

	test(
		"omitting impl for a newly-added field is a type error",
		testEffect(
			Effect.gen(function* () {
				const extended = extendNamespace(base, {
					replicant: { round: { schema: Schema.Number } },
				});

				const implemented = implementExtendedNamespace(
					extended,
					baseImplemented,
					{
						// @ts-expect-error missing seedReplicant for the newly-added "round"
						seedReplicant: {},
					},
				);
				const failure = yield* buildNamespace(
					implemented.manifest,
					implemented.impl,
				).pipe(Effect.flip);
				expect(failure.message).toMatch(
					/Missing seed value for replicant "round"/,
				);
			}),
		),
	);
});
