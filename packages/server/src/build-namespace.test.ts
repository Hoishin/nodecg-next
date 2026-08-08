import { defineNamespace } from "@nodecg/core";
import { CurrentIdentity, ServerIdentitySchema } from "@nodecg/internal";
import { makeTestEffect } from "@nodecg/internal/test-utils";
import { Effect, Layer, Schema } from "effect";
import { describe, expect, onTestFinished, test, vi } from "vitest";

import { BuiltNamespaceRegistry } from "./build-fields.ts";
import { adaptNamespace, buildNamespace } from "./build-namespace.ts";
import { DerivationEngineService } from "./derivation-graph.ts";
import { implementNamespace } from "./implement-namespace.ts";
import { InMemoryReplicantStorage } from "./services/replicant-storage/in-memory-replicant-storage.ts";
import { InMemoryTopicBroker } from "./services/topic-broker/in-memory-topic-broker.ts";
import { TopicBrokerService } from "./services/topic-broker/topic-broker.ts";

const server = ServerIdentitySchema.make();
const identity = Layer.succeed(CurrentIdentity, server);

const testInMemory = makeTestEffect(
	Layer.mergeAll(
		InMemoryReplicantStorage,
		InMemoryTopicBroker,
		DerivationEngineService.Default.pipe(
			Layer.provide(InMemoryReplicantStorage),
		),
		BuiltNamespaceRegistry.Default,
		identity,
	),
);

// Different encoded and decoded
const countManifest = defineNamespace("ns", {
	replicant: { count: { schema: Schema.NumberFromString } },
});

describe("seeding", () => {
	test(
		"encodes the seed and seeds the engine",
		testInMemory(
			Effect.gen(function* () {
				const engine = yield* DerivationEngineService;
				yield* buildNamespace(
					implementNamespace(countManifest, {
						seedReplicant: { count: () => 42 },
					}),
				);
				expect(yield* engine.readReplicant("ns", "count")).toEqual("42");
			}),
		),
	);

	test(
		"fails MissingReplicantSeed when a replicant has no seed",
		testInMemory(
			Effect.gen(function* () {
				const error = yield* buildNamespace(
					implementNamespace(countManifest, {
						// @ts-expect-error a replicant with no seed is a type error; exercising the runtime guard
						seedReplicant: {},
					}),
				).pipe(Effect.flip);

				expect(error._tag).toBe("MissingReplicantSeed");
				expect(error.message).toContain('"count"');
			}),
		),
	);

	test(
		"fails if encode rejects the seed value",
		testInMemory(
			Effect.gen(function* () {
				const error = yield* buildNamespace(
					implementNamespace(countManifest, {
						seedReplicant: { count: () => "nope" as unknown as number },
					}),
				).pipe(Effect.flip);

				expect(error._tag).toBe("FieldEncodeError");
			}),
		),
	);
});

describe("adaptNamespace", () => {
	const manifest = defineNamespace("ns", {
		replicant: { count: { schema: Schema.NumberFromString } },
		computed: { doubled: { schema: Schema.NumberFromString } },
		topic: { cheer: { schema: Schema.String } },
		rpc: {
			echo: {
				schema: {
					request: Schema.NumberFromString,
					response: Schema.NumberFromString,
				},
				permission: { write: { everyone: "allow" } },
			},
		},
	});

	test(
		"exposes every field op as a plain accessor running as the server",
		testInMemory(
			Effect.gen(function* () {
				const broker = yield* TopicBrokerService;
				const publish = vi.spyOn(broker, "publish");
				const built = yield* buildNamespace(
					implementNamespace(manifest, {
						seedReplicant: { count: () => 1 },
						implementComputed: {
							doubled: (ctx) => ctx.replicant.count.get() * 2,
						},
						implementRpc: { echo: (request) => request * 10 },
					}),
				);
				const handle = yield* adaptNamespace(built);

				expect(handle.replicant.count.get()).toBe(1);
				handle.replicant.count.set(2);
				expect(handle.replicant.count.get()).toBe(2);
				handle.replicant.count.update((count) => count + 1);
				expect(handle.replicant.count.get()).toBe(3);
				expect(
					yield* Effect.promise(() => handle.replicant.count.validate(9)),
				).toBe("9");
				expect(handle.computed.doubled.get()).toBe(6);
				yield* Effect.promise(() => handle.topic.cheer.publish("hi"));
				expect(publish).toHaveBeenCalledWith("ns", "cheer", "hi");
				expect(yield* Effect.promise(() => handle.rpc.echo(4))).toBe(40);

				const received: number[] = [];
				const cancel = yield* Effect.promise(() =>
					handle.replicant.count.subscribe((value) => {
						received.push(value);
					}),
				);
				onTestFinished(() => cancel());
				yield* Effect.promise(() =>
					vi.waitFor(() => expect(received).toEqual([3])),
				);
				handle.replicant.count.set(8);
				yield* Effect.promise(() =>
					vi.waitFor(() => expect(received).toEqual([3, 8])),
				);
			}),
		),
	);
});
