import { defineNamespace } from "@nodecg/core";
import { CurrentIdentity, ServerIdentitySchema } from "@nodecg/internal";
import { makeTestEffect } from "@nodecg/internal/test-utils";
import { Effect, Layer, Schema } from "effect";
import { afterEach, describe, expect, test, vi } from "vitest";

import { adaptNamespace, buildNamespace } from "./build-namespace.ts";
import { InMemoryReplicantStorage } from "./services/replicant-storage/in-memory-replicant-storage.ts";
import { createStorageStub } from "./services/replicant-storage/replicant-storage.stub.ts";
import { ReplicantStorageService } from "./services/replicant-storage/replicant-storage.ts";
import { InMemoryTopicBroker } from "./services/topic-broker/in-memory-topic-broker.ts";
import { createBrokerStub } from "./services/topic-broker/topic-broker.stub.ts";
import { TopicBrokerService } from "./services/topic-broker/topic-broker.ts";

const server = ServerIdentitySchema.make();
const identity = Layer.succeed(CurrentIdentity, server);

const { stub: storage, reset: resetStorage } = createStorageStub();
const { stub: broker, reset: resetBroker } = createBrokerStub();
afterEach(() => {
	resetStorage();
	resetBroker();
});

const testStubbed = makeTestEffect(
	Layer.mergeAll(
		Layer.succeed(ReplicantStorageService, storage),
		Layer.succeed(TopicBrokerService, broker),
		identity,
	),
);

const testInMemory = makeTestEffect(
	Layer.mergeAll(InMemoryReplicantStorage, InMemoryTopicBroker, identity),
);

// Different encoded and decoded
const countManifest = defineNamespace("ns", {
	replicant: { count: { schema: Schema.NumberFromString } },
});

describe("seeding", () => {
	test(
		"encodes the seed value and creates it when storage has none",
		testStubbed(
			Effect.gen(function* () {
				yield* buildNamespace(countManifest, {
					seedReplicant: { count: () => 42 },
				});

				expect(storage.create).toHaveBeenCalledWith("ns", "count", "42");
				expect(storage.create).toHaveBeenCalledTimes(1);
			}),
		),
	);

	test(
		"supports an async thunk",
		testStubbed(
			Effect.gen(function* () {
				yield* buildNamespace(countManifest, {
					seedReplicant: {
						count: async () => {
							await new Promise((resolve) => setTimeout(resolve, 1));
							return 7;
						},
					},
				});

				expect(storage.create).toHaveBeenCalledWith("ns", "count", "7");
			}),
		),
	);

	test(
		"skips seeding when storage already has a value",
		testStubbed(
			Effect.gen(function* () {
				storage.read.mockReturnValue(Effect.succeed("5"));
				yield* buildNamespace(countManifest, {
					seedReplicant: { count: () => 0 },
				});

				expect(storage.create).not.toHaveBeenCalled();
			}),
		),
	);

	test(
		"fails MissingReplicantSeedError when a replicant has no seed",
		testStubbed(
			Effect.gen(function* () {
				const error = yield* buildNamespace(countManifest).pipe(Effect.flip);

				expect(error._tag).toBe("MissingReplicantSeedError");
				expect(error.message).toContain('"count"');
				expect(storage.create).not.toHaveBeenCalled();
			}),
		),
	);

	test(
		"fails if encode rejects the seed value",
		testStubbed(
			Effect.gen(function* () {
				const error = yield* buildNamespace(countManifest, {
					seedReplicant: { count: () => "nope" as unknown as number },
				}).pipe(Effect.flip);

				expect(error._tag).toBe("FieldEncodeError");
				expect(storage.create).not.toHaveBeenCalled();
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
				const built = yield* buildNamespace(manifest, {
					seedReplicant: { count: () => 1 },
					implementComputed: { doubled: (sources) => sources.count * 2 },
					implementRpc: { echo: (request) => request * 10 },
				});
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
				yield* Effect.promise(() =>
					vi.waitFor(() => expect(received).toEqual([3])),
				);
				handle.replicant.count.set(8);
				yield* Effect.promise(() =>
					vi.waitFor(() => expect(received).toEqual([3, 8])),
				);
				yield* Effect.promise(() => cancel());
			}),
		),
	);
});
