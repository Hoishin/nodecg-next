import { defineNamespace } from "@nodecg-next/core";
import {
	FieldValueMessage,
	ReplicantSnapshotMessage,
	type ServerMessage,
	SubscribeRejectedMessage,
} from "@nodecg-next/internal";
import { computeTestHash, RevisionConflict } from "@nodecg-next/internal/occ";
import { testLayer } from "@nodecg-next/test-utils";
import {
	Effect,
	Exit,
	Fiber,
	Option,
	PubSub,
	Queue,
	Schema,
	Scope,
	Stream,
} from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { assert, describe, expect, onTestFinished, test, vi } from "vitest";

import { derive } from "./derive.ts";
import { loadNamespace, loadNamespaceEffect } from "./load-namespace.ts";
import {
	FieldNotFound,
	FieldPermissionDenied,
	type FieldTransport,
	FieldTransportService,
} from "./services/field-transport/field-transport.ts";
import {
	type MessageChannel,
	MessageChannelService,
} from "./services/message-channel/message-channel.ts";

const testFetch = testLayer(FetchHttpClient.layer);

const createTransportStub = () =>
	({
		getReplicant: vi.fn<FieldTransport["getReplicant"]>(),
		getComputed: vi.fn<FieldTransport["getComputed"]>(),
		updateReplicant: vi.fn<FieldTransport["updateReplicant"]>(
			() => Effect.void,
		),
		publishTopic: vi.fn<FieldTransport["publishTopic"]>(() => Effect.void),
		callRpc: vi.fn<FieldTransport["callRpc"]>(),
	}) satisfies FieldTransport;

const createMessageChannelStub = () =>
	({
		send: vi.fn<MessageChannel["send"]>(() => Effect.void),
		receive: () => Effect.succeed(Stream.never),
	}) satisfies MessageChannel;

describe("get", () => {
	testFetch(
		"decodes the value returned by the transport",
		Effect.gen(function* () {
			const transportStub = createTransportStub();
			transportStub.getReplicant.mockReturnValue(Effect.succeed(42));
			const manifest = defineNamespace("root", {
				replicant: { count: { schema: Schema.Number } },
			});

			const loaded = yield* loadNamespaceEffect(manifest).pipe(
				Effect.provideService(FieldTransportService, transportStub),
				Effect.provideService(
					MessageChannelService,
					createMessageChannelStub(),
				),
			);

			expect(
				yield* loaded.replicant.count
					.get()
					.pipe(Effect.provideService(FieldTransportService, transportStub)),
			).toBe(42);
		}),
	);

	testFetch(
		"fails when the stored value does not match the schema",
		Effect.gen(function* () {
			const transportStub = createTransportStub();
			transportStub.getReplicant.mockReturnValue(
				Effect.succeed("not a number"),
			);
			const manifest = defineNamespace("root", {
				replicant: { count: { schema: Schema.Number } },
			});

			const loaded = yield* loadNamespaceEffect(manifest).pipe(
				Effect.provideService(FieldTransportService, transportStub),
				Effect.provideService(
					MessageChannelService,
					createMessageChannelStub(),
				),
			);

			const error = yield* loaded.replicant.count
				.get()
				.pipe(
					Effect.provideService(FieldTransportService, transportStub),
					Effect.flip,
				);
			expect(error._tag).toBe("FieldDecodeError");
		}),
	);

	testFetch(
		"propagates FieldNotFound from the transport",
		Effect.gen(function* () {
			const transportStub = createTransportStub();
			transportStub.getReplicant.mockReturnValue(
				Effect.fail(new FieldNotFound({ namespace: "root", name: "count" })),
			);
			const manifest = defineNamespace("root", {
				replicant: { count: { schema: Schema.Number } },
			});

			const loaded = yield* loadNamespaceEffect(manifest).pipe(
				Effect.provideService(FieldTransportService, transportStub),
				Effect.provideService(
					MessageChannelService,
					createMessageChannelStub(),
				),
			);

			const error = yield* loaded.replicant.count
				.get()
				.pipe(
					Effect.provideService(FieldTransportService, transportStub),
					Effect.flip,
				);
			expect(error._tag).toBe("FieldNotFound");
		}),
	);

	testFetch(
		"reads a stored string back into a Date",
		Effect.gen(function* () {
			const transportStub = createTransportStub();
			transportStub.getReplicant.mockReturnValue(
				Effect.succeed("2030-01-01T00:00:00.000Z"),
			);
			const manifest = defineNamespace("root", {
				replicant: { when: { schema: Schema.DateFromString } },
			});

			const loaded = yield* loadNamespaceEffect(manifest).pipe(
				Effect.provideService(FieldTransportService, transportStub),
				Effect.provideService(
					MessageChannelService,
					createMessageChannelStub(),
				),
			);

			expect(
				yield* loaded.replicant.when
					.get()
					.pipe(Effect.provideService(FieldTransportService, transportStub)),
			).toEqual(new Date("2030-01-01T00:00:00.000Z"));
		}),
	);
});

describe("set", () => {
	testFetch(
		"encodes the value and writes it via the transport",
		Effect.gen(function* () {
			const transportStub = createTransportStub();
			const manifest = defineNamespace("root", {
				replicant: { count: { schema: Schema.Number } },
			});

			const loaded = yield* loadNamespaceEffect(manifest).pipe(
				Effect.provideService(FieldTransportService, transportStub),
				Effect.provideService(
					MessageChannelService,
					createMessageChannelStub(),
				),
			);

			yield* loaded.replicant.count
				.set(7)
				.pipe(Effect.provideService(FieldTransportService, transportStub));
			expect(transportStub.updateReplicant).toHaveBeenCalledWith(
				"root",
				"count",
				[{ op: "replace", path: "", value: 7 }],
			);
		}),
	);

	testFetch(
		"fails when the value fails schema validation",
		Effect.gen(function* () {
			const transportStub = createTransportStub();
			const manifest = defineNamespace("root", {
				replicant: { count: { schema: Schema.Number } },
			});

			const loaded = yield* loadNamespaceEffect(manifest).pipe(
				Effect.provideService(FieldTransportService, transportStub),
				Effect.provideService(
					MessageChannelService,
					createMessageChannelStub(),
				),
			);

			const error = yield* loaded.replicant.count
				.set("not a number" as unknown as number)
				.pipe(
					Effect.provideService(FieldTransportService, transportStub),
					Effect.flip,
				);
			expect(error._tag).toBe("FieldEncodeError");
		}),
	);

	testFetch(
		"sends a Date to the transport as a string",
		Effect.gen(function* () {
			const transportStub = createTransportStub();
			const manifest = defineNamespace("root", {
				replicant: { when: { schema: Schema.DateFromString } },
			});

			const loaded = yield* loadNamespaceEffect(manifest).pipe(
				Effect.provideService(FieldTransportService, transportStub),
				Effect.provideService(
					MessageChannelService,
					createMessageChannelStub(),
				),
			);

			yield* loaded.replicant.when
				.set(new Date("2030-01-01T00:00:00.000Z"))
				.pipe(Effect.provideService(FieldTransportService, transportStub));
			expect(transportStub.updateReplicant).toHaveBeenLastCalledWith(
				"root",
				"when",
				[{ op: "replace", path: "", value: "2030-01-01T00:00:00.000Z" }],
			);
		}),
	);
});

describe("update", () => {
	testFetch(
		"reads the current value, applies the fn, and writes the result",
		Effect.gen(function* () {
			const transportStub = createTransportStub();
			transportStub.getReplicant.mockReturnValue(Effect.succeed(10));
			const manifest = defineNamespace("root", {
				replicant: { count: { schema: Schema.Number } },
			});

			const loaded = yield* loadNamespaceEffect(manifest).pipe(
				Effect.provideService(FieldTransportService, transportStub),
				Effect.provideService(
					MessageChannelService,
					createMessageChannelStub(),
				),
			);

			yield* loaded.replicant.count
				.update((v) => v + 5)
				.pipe(Effect.provideService(FieldTransportService, transportStub));
			expect(transportStub.updateReplicant).toHaveBeenLastCalledWith(
				"root",
				"count",
				[
					{ op: "test-hash", path: "", hash: computeTestHash(10) },
					{ op: "replace", path: "", value: 15 },
				],
			);
		}),
	);

	testFetch(
		"mutating a draft field ships one replace op for that field alone",
		Effect.gen(function* () {
			const transportStub = createTransportStub();
			transportStub.getReplicant.mockReturnValue(
				Effect.succeed({ n: "1", kept: "x" }),
			);
			const manifest = defineNamespace("root", {
				replicant: {
					box: {
						schema: Schema.Struct({
							n: Schema.FiniteFromString,
							kept: Schema.String,
						}),
					},
				},
			});

			const loaded = yield* loadNamespaceEffect(manifest).pipe(
				Effect.provideService(FieldTransportService, transportStub),
				Effect.provideService(
					MessageChannelService,
					createMessageChannelStub(),
				),
			);

			yield* loaded.replicant.box
				.update((draft) => {
					draft.n = 5;
				})
				.pipe(Effect.provideService(FieldTransportService, transportStub));
			expect(transportStub.updateReplicant).toHaveBeenLastCalledWith(
				"root",
				"box",
				[
					{ op: "test-hash", path: "/n", hash: computeTestHash("1") },
					{ op: "replace", path: "/n", value: "5" },
				],
			);
		}),
	);

	testFetch(
		"an updater that changes nothing writes nothing",
		Effect.gen(function* () {
			const transportStub = createTransportStub();
			transportStub.getReplicant.mockReturnValue(Effect.succeed({ n: "1" }));
			const manifest = defineNamespace("root", {
				replicant: {
					box: { schema: Schema.Struct({ n: Schema.FiniteFromString }) },
				},
			});

			const loaded = yield* loadNamespaceEffect(manifest).pipe(
				Effect.provideService(FieldTransportService, transportStub),
				Effect.provideService(
					MessageChannelService,
					createMessageChannelStub(),
				),
			);

			yield* loaded.replicant.box
				.update((draft) => {
					draft.n = 1;
				})
				.pipe(Effect.provideService(FieldTransportService, transportStub));
			expect(transportStub.updateReplicant).not.toHaveBeenCalled();
		}),
	);

	testFetch(
		"surfaces a throwing updater as FieldSetError without writing, preserving the message",
		Effect.gen(function* () {
			const transportStub = createTransportStub();
			transportStub.getReplicant.mockReturnValue(Effect.succeed(10));
			const manifest = defineNamespace("root", {
				replicant: { count: { schema: Schema.Number } },
			});

			const loaded = yield* loadNamespaceEffect(manifest).pipe(
				Effect.provideService(FieldTransportService, transportStub),
				Effect.provideService(
					MessageChannelService,
					createMessageChannelStub(),
				),
			);

			const error = yield* loaded.replicant.count
				.update(() => {
					throw new Error("boom");
				})
				.pipe(
					Effect.provideService(FieldTransportService, transportStub),
					Effect.flip,
				);
			expect(error._tag).toBe("FieldSetError");
			expect(error.message).toContain("boom");
			expect(transportStub.updateReplicant).not.toHaveBeenCalled();
		}),
	);

	testFetch(
		"{ retry: false } fails fast as ReplicantWriteConflict carrying the decoded current value",
		Effect.gen(function* () {
			const transportStub = createTransportStub();
			transportStub.getReplicant.mockReturnValue(Effect.succeed({ n: "1" }));
			transportStub.updateReplicant.mockReturnValue(
				new RevisionConflict({
					value: { n: "7" },
					revision: 4,
					reason: "HashMismatch",
				}),
			);
			const manifest = defineNamespace("root", {
				replicant: {
					box: { schema: Schema.Struct({ n: Schema.FiniteFromString }) },
				},
			});

			const loaded = yield* loadNamespaceEffect(manifest).pipe(
				Effect.provideService(FieldTransportService, transportStub),
				Effect.provideService(
					MessageChannelService,
					createMessageChannelStub(),
				),
			);

			const error = yield* loaded.replicant.box
				.update(
					(draft) => {
						draft.n = 5;
					},
					{ retry: false },
				)
				.pipe(
					Effect.provideService(FieldTransportService, transportStub),
					Effect.flip,
				);
			assert(error._tag === "ReplicantWriteConflict");
			expect(error.current).toEqual({ n: 7 });
			expect(error.revision).toBe(4);
			expect(transportStub.updateReplicant).toHaveBeenCalledTimes(1);
		}),
	);

	testFetch(
		"{ retry: n } resends n times before rejecting",
		Effect.gen(function* () {
			const transportStub = createTransportStub();
			transportStub.getReplicant.mockReturnValue(Effect.succeed(10));
			transportStub.updateReplicant.mockReturnValue(
				new RevisionConflict({
					value: 20,
					revision: 5,
					reason: "HashMismatch",
				}),
			);
			const manifest = defineNamespace("root", {
				replicant: { count: { schema: Schema.Number } },
			});

			const loaded = yield* loadNamespaceEffect(manifest).pipe(
				Effect.provideService(FieldTransportService, transportStub),
				Effect.provideService(
					MessageChannelService,
					createMessageChannelStub(),
				),
			);

			const error = yield* loaded.replicant.count
				.update((v) => v + 1, { retry: 2 })
				.pipe(
					Effect.provideService(FieldTransportService, transportStub),
					Effect.flip,
				);

			assert(error._tag === "ReplicantWriteConflict");
			expect(transportStub.updateReplicant).toHaveBeenCalledTimes(3);
		}),
	);
});

describe("subscribe", () => {
	const subscribeFrame = {
		_tag: "subscribe",
		field: { type: "replicant", namespace: "root", name: "count" },
	};
	const unsubscribeFrame = {
		_tag: "unsubscribe",
		field: { type: "replicant", namespace: "root", name: "count" },
	};
	const publishFrame = (value: number, revision = 1): ServerMessage =>
		ReplicantSnapshotMessage.make({
			field: { type: "replicant", namespace: "root", name: "count" },
			value,
			revision,
		});

	testFetch(
		"sends server subscribe and emits decoded matching publishes",
		Effect.gen(function* () {
			const transportStub = createTransportStub();
			const queue = yield* Queue.unbounded<ServerMessage>();
			const send = vi.fn<MessageChannel["send"]>(() => Effect.void);
			const messageChannelStub: MessageChannel = {
				send,
				receive: () => Effect.succeed(Stream.fromQueue(queue)),
			};
			const manifest = defineNamespace("root", {
				replicant: { count: { schema: Schema.Number } },
			});

			const loaded = yield* loadNamespaceEffect(manifest).pipe(
				Effect.provideService(FieldTransportService, transportStub),
				Effect.provideService(MessageChannelService, messageChannelStub),
			);

			const head = yield* loaded.replicant.count
				.subscribe()
				.pipe(Effect.flatMap(Stream.runHead), Effect.forkChild);
			yield* Effect.promise(() =>
				vi.waitFor(() => {
					expect(send).toHaveBeenCalledWith(subscribeFrame);
				}),
			);

			yield* Queue.offer(queue, publishFrame(42));

			const result = yield* Fiber.join(head);
			assert(Option.isSome(result));
			expect(result.value).toBe(42);
		}),
	);

	testFetch(
		"ignores publishes for a different name",
		Effect.gen(function* () {
			const transportStub = createTransportStub();
			const queue = yield* Queue.unbounded<ServerMessage>();
			const send = vi.fn<MessageChannel["send"]>(() => Effect.void);
			const messageChannelStub: MessageChannel = {
				send,
				receive: () => Effect.succeed(Stream.fromQueue(queue)),
			};
			const manifest = defineNamespace("root", {
				replicant: {
					count: { schema: Schema.Number },
					other: { schema: Schema.Number },
				},
			});

			const loaded = yield* loadNamespaceEffect(manifest).pipe(
				Effect.provideService(FieldTransportService, transportStub),
				Effect.provideService(MessageChannelService, messageChannelStub),
			);

			const head = yield* loaded.replicant.count
				.subscribe()
				.pipe(Effect.flatMap(Stream.runHead), Effect.forkChild);
			yield* Effect.promise(() =>
				vi.waitFor(() => {
					expect(send).toHaveBeenCalledWith(subscribeFrame);
				}),
			);

			yield* Queue.offer(
				queue,
				ReplicantSnapshotMessage.make({
					field: { type: "replicant", namespace: "root", name: "other" },
					value: 99,
					revision: 1,
				}),
			);
			yield* Queue.offer(queue, publishFrame(7));

			const result = yield* Fiber.join(head);
			assert(Option.isSome(result));
			expect(result.value).toBe(7);
		}),
	);

	testFetch(
		"resolves only after the first publish",
		Effect.gen(function* () {
			const transportStub = createTransportStub();
			const queue = yield* Queue.unbounded<ServerMessage>();
			const send = vi.fn<MessageChannel["send"]>(() => Effect.void);
			const messageChannelStub: MessageChannel = {
				send,
				receive: () => Effect.succeed(Stream.fromQueue(queue)),
			};
			const manifest = defineNamespace("root", {
				replicant: { count: { schema: Schema.Number } },
			});

			const loaded = yield* loadNamespaceEffect(manifest).pipe(
				Effect.provideService(FieldTransportService, transportStub),
				Effect.provideService(MessageChannelService, messageChannelStub),
			);

			const fiber = yield* loaded.replicant.count
				.subscribe()
				.pipe(Effect.asVoid, Effect.forkChild);
			yield* Effect.promise(() =>
				vi.waitFor(() => {
					expect(send).toHaveBeenCalledWith(subscribeFrame);
				}),
			);
			expect(fiber.pollUnsafe()).toBeUndefined();

			yield* Queue.offer(queue, publishFrame(0));
			yield* Fiber.join(fiber);
		}),
	);

	testFetch(
		"sends server unsubscribe when the subscription scope closes",
		Effect.gen(function* () {
			const transportStub = createTransportStub();
			const queue = yield* Queue.unbounded<ServerMessage>();
			const send = vi.fn<MessageChannel["send"]>(() => Effect.void);
			const messageChannelStub: MessageChannel = {
				send,
				receive: () => Effect.succeed(Stream.fromQueue(queue)),
			};
			const manifest = defineNamespace("root", {
				replicant: { count: { schema: Schema.Number } },
			});

			const loaded = yield* loadNamespaceEffect(manifest).pipe(
				Effect.provideService(FieldTransportService, transportStub),
				Effect.provideService(MessageChannelService, messageChannelStub),
			);

			const scope = yield* Scope.make();
			const fiber = yield* loaded.replicant.count
				.subscribe()
				.pipe(Effect.asVoid, Scope.provide(scope), Effect.forkChild);
			yield* Effect.promise(() =>
				vi.waitFor(() => {
					expect(send).toHaveBeenCalledWith(subscribeFrame);
				}),
			);
			yield* Queue.offer(queue, publishFrame(0));
			yield* Fiber.join(fiber);

			yield* Scope.close(scope, Exit.void);
			yield* Effect.promise(() =>
				vi.waitFor(() => {
					expect(send).toHaveBeenCalledWith(unsubscribeFrame);
				}),
			);
		}),
	);

	testFetch(
		"refcounts: subscribe sent once, unsubscribe only after the last scope closes",
		Effect.gen(function* () {
			const transportStub = createTransportStub();
			const queue = yield* Queue.unbounded<ServerMessage>();
			const send = vi.fn<MessageChannel["send"]>(() => Effect.void);
			const messageChannelStub: MessageChannel = {
				send,
				receive: () => Effect.succeed(Stream.fromQueue(queue)),
			};
			const manifest = defineNamespace("root", {
				replicant: { count: { schema: Schema.Number } },
			});

			const loaded = yield* loadNamespaceEffect(manifest).pipe(
				Effect.provideService(FieldTransportService, transportStub),
				Effect.provideService(MessageChannelService, messageChannelStub),
			);

			const scope1 = yield* Scope.make();
			const sub1 = yield* loaded.replicant.count
				.subscribe()
				.pipe(Effect.asVoid, Scope.provide(scope1), Effect.forkChild);
			yield* Effect.promise(() =>
				vi.waitFor(() => {
					expect(send).toHaveBeenCalledWith(subscribeFrame);
				}),
			);
			yield* Queue.offer(queue, publishFrame(0));
			yield* Fiber.join(sub1);

			const scope2 = yield* Scope.make();
			const sub2 = yield* loaded.replicant.count
				.subscribe()
				.pipe(Effect.asVoid, Scope.provide(scope2), Effect.forkChild);
			yield* Fiber.join(sub2);

			const subscribeCount = send.mock.calls.filter(
				([msg]) => msg._tag === "subscribe",
			).length;
			expect(subscribeCount).toBe(1);

			yield* Scope.close(scope1, Exit.void);
			yield* Effect.promise(() =>
				vi.waitFor(() => {
					const hasUnsubscribe = send.mock.calls.some(
						([msg]) => msg._tag === "unsubscribe",
					);
					expect(hasUnsubscribe).toBe(false);
				}),
			);

			yield* Scope.close(scope2, Exit.void);
			yield* Effect.promise(() =>
				vi.waitFor(() => {
					expect(send).toHaveBeenCalledWith(unsubscribeFrame);
				}),
			);
		}),
	);

	testFetch(
		"a later subscriber receives the current value on subscribe",
		Effect.gen(function* () {
			const transportStub = createTransportStub();
			const pubsub = yield* PubSub.unbounded<ServerMessage>();
			const send = vi.fn<MessageChannel["send"]>(() => Effect.void);
			const messageChannelStub: MessageChannel = {
				send,
				receive: () =>
					PubSub.subscribe(pubsub).pipe(Effect.map(Stream.fromSubscription)),
			};
			const manifest = defineNamespace("root", {
				replicant: { count: { schema: Schema.Number } },
			});

			const loaded = yield* loadNamespaceEffect(manifest).pipe(
				Effect.provideService(FieldTransportService, transportStub),
				Effect.provideService(MessageChannelService, messageChannelStub),
			);

			const received1: number[] = [];
			const scope1 = yield* Scope.make();
			const sub1 = yield* loaded.replicant.count.subscribe().pipe(
				Effect.flatMap((stream) =>
					Stream.runForEach(stream, (value) =>
						Effect.sync(() => received1.push(value)),
					),
				),
				Scope.provide(scope1),
				Effect.forkChild,
			);
			yield* Effect.promise(() =>
				vi.waitFor(() => {
					expect(send).toHaveBeenCalledWith(subscribeFrame);
				}),
			);
			yield* PubSub.publish(pubsub, publishFrame(5));
			yield* Effect.promise(() =>
				vi.waitFor(() => {
					expect(received1).toEqual([5]);
				}),
			);

			const received2: number[] = [];
			const scope2 = yield* Scope.make();
			const sub2 = yield* loaded.replicant.count.subscribe().pipe(
				Effect.flatMap((stream) =>
					Stream.runForEach(stream, (value) =>
						Effect.sync(() => received2.push(value)),
					),
				),
				Scope.provide(scope2),
				Effect.forkChild,
			);
			yield* Effect.promise(() =>
				vi.waitFor(() => {
					expect(received2).toEqual([5]);
				}),
			);

			yield* Fiber.interrupt(sub1);
			yield* Fiber.interrupt(sub2);
			yield* Scope.close(scope1, Exit.void);
			yield* Scope.close(scope2, Exit.void);
		}),
	);

	const rejectedFrame = (reason: "forbidden" | "not-found"): ServerMessage =>
		SubscribeRejectedMessage.make({
			field: { type: "replicant", namespace: "root", name: "count" },
			reason,
		});

	testFetch(
		"rejects with FieldPermissionDenied on a forbidden frame",
		Effect.gen(function* () {
			const transportStub = createTransportStub();
			const queue = yield* Queue.unbounded<ServerMessage>();
			const send = vi.fn<MessageChannel["send"]>(() => Effect.void);
			const messageChannelStub: MessageChannel = {
				send,
				receive: () => Effect.succeed(Stream.fromQueue(queue)),
			};
			const manifest = defineNamespace("root", {
				replicant: { count: { schema: Schema.Number } },
			});

			const loaded = yield* loadNamespaceEffect(manifest).pipe(
				Effect.provideService(FieldTransportService, transportStub),
				Effect.provideService(MessageChannelService, messageChannelStub),
			);

			const fiber = yield* loaded.replicant.count
				.subscribe()
				.pipe(Effect.flip, Effect.forkChild);
			yield* Effect.promise(() =>
				vi.waitFor(() => {
					expect(send).toHaveBeenCalledWith(subscribeFrame);
				}),
			);
			yield* Queue.offer(queue, rejectedFrame("forbidden"));

			const error = yield* Fiber.join(fiber);
			expect(error._tag).toBe("FieldPermissionDenied");
		}),
	);

	testFetch(
		"rejects with FieldNotFound on a not-found frame",
		Effect.gen(function* () {
			const transportStub = createTransportStub();
			const queue = yield* Queue.unbounded<ServerMessage>();
			const send = vi.fn<MessageChannel["send"]>(() => Effect.void);
			const messageChannelStub: MessageChannel = {
				send,
				receive: () => Effect.succeed(Stream.fromQueue(queue)),
			};
			const manifest = defineNamespace("root", {
				replicant: { count: { schema: Schema.Number } },
			});

			const loaded = yield* loadNamespaceEffect(manifest).pipe(
				Effect.provideService(FieldTransportService, transportStub),
				Effect.provideService(MessageChannelService, messageChannelStub),
			);

			const fiber = yield* loaded.replicant.count
				.subscribe()
				.pipe(Effect.flip, Effect.forkChild);
			yield* Effect.promise(() =>
				vi.waitFor(() => {
					expect(send).toHaveBeenCalledWith(subscribeFrame);
				}),
			);
			yield* Queue.offer(queue, rejectedFrame("not-found"));

			const error = yield* Fiber.join(fiber);
			expect(error._tag).toBe("FieldNotFound");
		}),
	);

	testFetch(
		"ends the stream with the error when the subscribe is rejected after the first value",
		Effect.gen(function* () {
			const transportStub = createTransportStub();
			const queue = yield* Queue.unbounded<ServerMessage>();
			const send = vi.fn<MessageChannel["send"]>(() => Effect.void);
			const messageChannelStub: MessageChannel = {
				send,
				receive: () => Effect.succeed(Stream.fromQueue(queue)),
			};
			const manifest = defineNamespace("root", {
				replicant: { count: { schema: Schema.Number } },
			});

			const loaded = yield* loadNamespaceEffect(manifest).pipe(
				Effect.provideService(FieldTransportService, transportStub),
				Effect.provideService(MessageChannelService, messageChannelStub),
			);

			const received: number[] = [];
			const consumer = yield* loaded.replicant.count.subscribe().pipe(
				Effect.flatMap(
					Stream.runForEach((value) =>
						Effect.sync(() => {
							received.push(value);
						}),
					),
				),
				Effect.flip,
				Effect.forkScoped,
			);
			yield* Effect.promise(() =>
				vi.waitFor(() => expect(send).toHaveBeenCalledWith(subscribeFrame)),
			);
			yield* Queue.offer(queue, publishFrame(1));
			yield* Effect.promise(() =>
				vi.waitFor(() => expect(received).toEqual([1])),
			);

			yield* Queue.offer(queue, rejectedFrame("forbidden"));
			const error = yield* Fiber.join(consumer);
			expect(error).toEqual(
				new FieldPermissionDenied({ namespace: "root", name: "count" }),
			);
			expect(received).toEqual([1]);
		}),
	);

	testFetch(
		"keeps the stream open when a publish does not decode after the first value, and delivers the next publish that does",
		Effect.gen(function* () {
			const transportStub = createTransportStub();
			const queue = yield* Queue.unbounded<ServerMessage>();
			const send = vi.fn<MessageChannel["send"]>(() => Effect.void);
			const messageChannelStub: MessageChannel = {
				send,
				receive: () => Effect.succeed(Stream.fromQueue(queue)),
			};
			const manifest = defineNamespace("root", {
				replicant: { count: { schema: Schema.Number } },
			});

			const loaded = yield* loadNamespaceEffect(manifest).pipe(
				Effect.provideService(FieldTransportService, transportStub),
				Effect.provideService(MessageChannelService, messageChannelStub),
			);

			const received: number[] = [];
			yield* loaded.replicant.count.subscribe().pipe(
				Effect.flatMap(
					Stream.runForEach((value) =>
						Effect.sync(() => {
							received.push(value);
						}),
					),
				),
				Effect.forkScoped,
			);
			yield* Effect.promise(() =>
				vi.waitFor(() => expect(send).toHaveBeenCalledWith(subscribeFrame)),
			);
			yield* Queue.offer(queue, publishFrame(1));
			yield* Effect.promise(() =>
				vi.waitFor(() => expect(received).toEqual([1])),
			);

			yield* Queue.offer(
				queue,
				ReplicantSnapshotMessage.make({
					field: { type: "replicant", namespace: "root", name: "count" },
					value: "not a number",
					revision: 2,
				}),
			);
			yield* Queue.offer(queue, publishFrame(7, 3));
			yield* Effect.promise(() =>
				vi.waitFor(() => expect(received).toEqual([1, 7])),
			);
		}),
	);

	testFetch(
		"re-subscribing after a rejection sends a fresh subscribe and heals on the next publish",
		Effect.gen(function* () {
			const transportStub = createTransportStub();
			const queue = yield* Queue.unbounded<ServerMessage>();
			const send = vi.fn<MessageChannel["send"]>(() => Effect.void);
			const messageChannelStub: MessageChannel = {
				send,
				receive: () => Effect.succeed(Stream.fromQueue(queue)),
			};
			const manifest = defineNamespace("root", {
				replicant: { count: { schema: Schema.Number } },
			});

			const loaded = yield* loadNamespaceEffect(manifest).pipe(
				Effect.provideService(FieldTransportService, transportStub),
				Effect.provideService(MessageChannelService, messageChannelStub),
			);

			const scope1 = yield* Scope.make();
			const fiber1 = yield* loaded.replicant.count
				.subscribe()
				.pipe(Effect.flip, Scope.provide(scope1), Effect.forkChild);
			yield* Effect.promise(() =>
				vi.waitFor(() => {
					expect(send).toHaveBeenCalledWith(subscribeFrame);
				}),
			);
			yield* Queue.offer(queue, rejectedFrame("forbidden"));
			const firstError = yield* Fiber.join(fiber1);
			expect(firstError._tag).toBe("FieldPermissionDenied");
			yield* Scope.close(scope1, Exit.void);

			const scope2 = yield* Scope.make();
			const head = yield* loaded.replicant.count
				.subscribe()
				.pipe(
					Effect.flatMap(Stream.runHead),
					Scope.provide(scope2),
					Effect.forkChild,
				);
			yield* Effect.promise(() =>
				vi.waitFor(() => {
					const subscribeCount = send.mock.calls.filter(
						([msg]) => msg._tag === "subscribe",
					).length;
					expect(subscribeCount).toBe(2);
				}),
			);
			yield* Queue.offer(queue, publishFrame(5));
			const result = yield* Fiber.join(head);
			assert(Option.isSome(result));
			expect(result.value).toBe(5);
			yield* Scope.close(scope2, Exit.void);
		}),
	);
});

describe("computed", () => {
	const computedManifest = defineNamespace("root", {
		replicant: {
			games: { schema: Schema.Array(Schema.Struct({ id: Schema.String })) },
		},
		computed: { firstGameId: { schema: Schema.NullOr(Schema.String) } },
	});

	testFetch(
		"get decodes the computed value from the transport",
		Effect.gen(function* () {
			const transportStub = createTransportStub();
			transportStub.getComputed.mockReturnValue(Effect.succeed("a"));

			const loaded = yield* loadNamespaceEffect(computedManifest).pipe(
				Effect.provideService(FieldTransportService, transportStub),
				Effect.provideService(
					MessageChannelService,
					createMessageChannelStub(),
				),
			);

			expect(
				yield* loaded.computed.firstGameId
					.get()
					.pipe(Effect.provideService(FieldTransportService, transportStub)),
			).toBe("a");
		}),
	);

	testFetch(
		"is read-only (no set)",
		Effect.gen(function* () {
			const loaded = yield* loadNamespaceEffect(computedManifest).pipe(
				Effect.provideService(FieldTransportService, createTransportStub()),
				Effect.provideService(
					MessageChannelService,
					createMessageChannelStub(),
				),
			);

			expect("set" in loaded.computed.firstGameId).toBe(false);
		}),
	);

	testFetch(
		"subscribe emits decoded matching publishes",
		Effect.gen(function* () {
			const transportStub = createTransportStub();
			const pubsub = yield* PubSub.unbounded<ServerMessage>();
			const send = vi.fn<MessageChannel["send"]>(() => Effect.void);
			const messageChannelStub: MessageChannel = {
				send,
				receive: () =>
					PubSub.subscribe(pubsub).pipe(Effect.map(Stream.fromSubscription)),
			};

			const loaded = yield* loadNamespaceEffect(computedManifest).pipe(
				Effect.provideService(FieldTransportService, transportStub),
				Effect.provideService(MessageChannelService, messageChannelStub),
			);

			const head = yield* loaded.computed.firstGameId
				.subscribe()
				.pipe(Effect.flatMap(Stream.runHead), Effect.forkChild);
			yield* Effect.promise(() =>
				vi.waitFor(() => {
					expect(send).toHaveBeenCalledWith({
						_tag: "subscribe",
						field: {
							type: "computed",
							namespace: "root",
							name: "firstGameId",
						},
					});
				}),
			);

			yield* PubSub.publish(
				pubsub,
				FieldValueMessage.make({
					field: { type: "computed", namespace: "root", name: "firstGameId" },
					value: "z",
				}),
			);

			const result = yield* Fiber.join(head);
			assert(Option.isSome(result));
			expect(result.value).toBe("z");
		}),
	);
});

describe("topic", () => {
	const topicManifest = defineNamespace("root", {
		topic: { chat: { schema: Schema.Number } },
	});
	const subscribeFrame = {
		_tag: "subscribe",
		field: { type: "topic", namespace: "root", name: "chat" },
	};
	const unsubscribeFrame = {
		_tag: "unsubscribe",
		field: { type: "topic", namespace: "root", name: "chat" },
	};
	const publishFrame = (value: number): ServerMessage =>
		FieldValueMessage.make({
			field: { type: "topic", namespace: "root", name: "chat" },
			value,
		});

	testFetch(
		"publish encodes the value and forwards it to the transport",
		Effect.gen(function* () {
			const transportStub = createTransportStub();
			const loaded = yield* loadNamespaceEffect(topicManifest).pipe(
				Effect.provideService(FieldTransportService, transportStub),
				Effect.provideService(
					MessageChannelService,
					createMessageChannelStub(),
				),
			);

			yield* loaded.topic.chat
				.publish(7)
				.pipe(Effect.provideService(FieldTransportService, transportStub));
			expect(transportStub.publishTopic).toHaveBeenCalledWith(
				"root",
				"chat",
				7,
			);
		}),
	);

	testFetch(
		"publish fails when the value fails schema validation",
		Effect.gen(function* () {
			const transportStub = createTransportStub();
			const loaded = yield* loadNamespaceEffect(topicManifest).pipe(
				Effect.provideService(FieldTransportService, transportStub),
				Effect.provideService(
					MessageChannelService,
					createMessageChannelStub(),
				),
			);

			const error = yield* loaded.topic.chat
				.publish("nope" as unknown as number)
				.pipe(
					Effect.provideService(FieldTransportService, transportStub),
					Effect.flip,
				);
			expect(error._tag).toBe("FieldEncodeError");
		}),
	);

	testFetch(
		"subscribe sends server subscribe and emits decoded matching publishes",
		Effect.gen(function* () {
			const transportStub = createTransportStub();
			const pubsub = yield* PubSub.unbounded<ServerMessage>();
			const send = vi.fn<MessageChannel["send"]>(() => Effect.void);
			const messageChannelStub: MessageChannel = {
				send,
				receive: () =>
					PubSub.subscribe(pubsub).pipe(Effect.map(Stream.fromSubscription)),
			};
			const loaded = yield* loadNamespaceEffect(topicManifest).pipe(
				Effect.provideService(FieldTransportService, transportStub),
				Effect.provideService(MessageChannelService, messageChannelStub),
			);

			const head = yield* loaded.topic.chat
				.subscribe()
				.pipe(Effect.flatMap(Stream.runHead), Effect.forkChild);
			yield* Effect.promise(() =>
				vi.waitFor(() => {
					expect(send).toHaveBeenCalledWith(subscribeFrame);
				}),
			);

			yield* PubSub.publish(
				pubsub,
				FieldValueMessage.make({
					field: { type: "topic", namespace: "root", name: "other" },
					value: 99,
				}),
			);
			yield* PubSub.publish(pubsub, publishFrame(42));

			const result = yield* Fiber.join(head);
			assert(Option.isSome(result));
			expect(result.value).toBe(42);
		}),
	);

	testFetch(
		"refcounts: subscribe sent once, unsubscribe only after the last scope closes",
		Effect.gen(function* () {
			const transportStub = createTransportStub();
			const queue = yield* Queue.unbounded<ServerMessage>();
			const send = vi.fn<MessageChannel["send"]>(() => Effect.void);
			const messageChannelStub: MessageChannel = {
				send,
				receive: () => Effect.succeed(Stream.fromQueue(queue)),
			};
			const loaded = yield* loadNamespaceEffect(topicManifest).pipe(
				Effect.provideService(FieldTransportService, transportStub),
				Effect.provideService(MessageChannelService, messageChannelStub),
			);

			const scope1 = yield* Scope.make();
			const sub1 = yield* loaded.topic.chat
				.subscribe()
				.pipe(Effect.asVoid, Scope.provide(scope1), Effect.forkChild);
			yield* Fiber.join(sub1);
			yield* Effect.promise(() =>
				vi.waitFor(() => {
					expect(send).toHaveBeenCalledWith(subscribeFrame);
				}),
			);

			const scope2 = yield* Scope.make();
			const sub2 = yield* loaded.topic.chat
				.subscribe()
				.pipe(Effect.asVoid, Scope.provide(scope2), Effect.forkChild);
			yield* Fiber.join(sub2);

			const subscribeCount = send.mock.calls.filter(
				([msg]) => msg._tag === "subscribe",
			).length;
			expect(subscribeCount).toBe(1);

			yield* Scope.close(scope1, Exit.void);
			const hasUnsubscribe = send.mock.calls.some(
				([msg]) => msg._tag === "unsubscribe",
			);
			expect(hasUnsubscribe).toBe(false);

			yield* Scope.close(scope2, Exit.void);
			yield* Effect.promise(() =>
				vi.waitFor(() => {
					expect(send).toHaveBeenCalledWith(unsubscribeFrame);
				}),
			);
		}),
	);

	testFetch(
		"a late subscriber does not replay the topic's last event",
		Effect.gen(function* () {
			const transportStub = createTransportStub();
			const pubsub = yield* PubSub.unbounded<ServerMessage>();
			const send = vi.fn<MessageChannel["send"]>(() => Effect.void);
			const messageChannelStub: MessageChannel = {
				send,
				receive: () =>
					PubSub.subscribe(pubsub).pipe(Effect.map(Stream.fromSubscription)),
			};
			const loaded = yield* loadNamespaceEffect(topicManifest).pipe(
				Effect.provideService(FieldTransportService, transportStub),
				Effect.provideService(MessageChannelService, messageChannelStub),
			);

			const seen1: number[] = [];
			const stream1 = yield* loaded.topic.chat.subscribe();
			yield* Stream.runForEach(stream1, (v) =>
				Effect.sync(() => seen1.push(v)),
			).pipe(Effect.forkChild);
			yield* Effect.promise(() =>
				vi.waitFor(() => {
					expect(send).toHaveBeenCalledWith(subscribeFrame);
				}),
			);

			yield* PubSub.publish(pubsub, publishFrame(1));
			yield* Effect.promise(() =>
				vi.waitFor(() => {
					expect(seen1).toEqual([1]);
				}),
			);

			const seen2: number[] = [];
			const stream2 = yield* loaded.topic.chat.subscribe();
			yield* Stream.runForEach(stream2, (v) =>
				Effect.sync(() => seen2.push(v)),
			).pipe(Effect.forkChild);

			yield* PubSub.publish(pubsub, publishFrame(2));
			yield* Effect.promise(() =>
				vi.waitFor(() => {
					expect(seen1).toEqual([1, 2]);
					expect(seen2).toEqual([2]);
				}),
			);
		}),
	);

	testFetch(
		"ends the stream with the error when the server rejects the subscribe",
		Effect.gen(function* () {
			const transportStub = createTransportStub();
			const queue = yield* Queue.unbounded<ServerMessage>();
			const send = vi.fn<MessageChannel["send"]>(() => Effect.void);
			const messageChannelStub: MessageChannel = {
				send,
				receive: () => Effect.succeed(Stream.fromQueue(queue)),
			};
			const loaded = yield* loadNamespaceEffect(topicManifest).pipe(
				Effect.provideService(FieldTransportService, transportStub),
				Effect.provideService(MessageChannelService, messageChannelStub),
			);

			const seen: number[] = [];
			const consumer = yield* loaded.topic.chat.subscribe().pipe(
				Effect.flatMap(
					Stream.runForEach((value) =>
						Effect.sync(() => {
							seen.push(value);
						}),
					),
				),
				Effect.flip,
				Effect.forkScoped,
			);
			yield* Effect.promise(() =>
				vi.waitFor(() => expect(send).toHaveBeenCalledWith(subscribeFrame)),
			);
			yield* Queue.offer(queue, publishFrame(1));
			yield* Effect.promise(() => vi.waitFor(() => expect(seen).toEqual([1])));

			yield* Queue.offer(
				queue,
				SubscribeRejectedMessage.make({
					field: { type: "topic", namespace: "root", name: "chat" },
					reason: "forbidden",
				}),
			);
			const error = yield* Fiber.join(consumer);
			expect(error).toEqual(
				new FieldPermissionDenied({ namespace: "root", name: "chat" }),
			);
			expect(seen).toEqual([1]);
		}),
	);
});

describe("rpc", () => {
	const rpcManifest = defineNamespace("root", {
		rpc: {
			echo: { schema: { request: Schema.Number, response: Schema.Number } },
			when: {
				schema: {
					request: Schema.Number,
					response: Schema.DateFromString,
				},
			},
		},
	});

	testFetch(
		"call encodes the request, forwards it, and decodes the response",
		Effect.gen(function* () {
			const transportStub = createTransportStub();
			transportStub.callRpc.mockReturnValue(Effect.succeed(84));
			const loaded = yield* loadNamespaceEffect(rpcManifest).pipe(
				Effect.provideService(FieldTransportService, transportStub),
				Effect.provideService(
					MessageChannelService,
					createMessageChannelStub(),
				),
			);

			const result = yield* loaded.rpc.echo
				.call(42)
				.pipe(Effect.provideService(FieldTransportService, transportStub));
			expect(result).toBe(84);
			expect(transportStub.callRpc).toHaveBeenCalledWith("root", "echo", 42);
		}),
	);

	testFetch(
		"call decodes a string response into a Date",
		Effect.gen(function* () {
			const transportStub = createTransportStub();
			transportStub.callRpc.mockReturnValue(
				Effect.succeed("2030-01-01T00:00:00.000Z"),
			);
			const loaded = yield* loadNamespaceEffect(rpcManifest).pipe(
				Effect.provideService(FieldTransportService, transportStub),
				Effect.provideService(
					MessageChannelService,
					createMessageChannelStub(),
				),
			);

			const result = yield* loaded.rpc.when
				.call(1)
				.pipe(Effect.provideService(FieldTransportService, transportStub));
			expect(result).toEqual(new Date("2030-01-01T00:00:00.000Z"));
		}),
	);

	testFetch(
		"call propagates a typed transport error",
		Effect.gen(function* () {
			const transportStub = createTransportStub();
			transportStub.callRpc.mockReturnValue(
				Effect.fail(
					new FieldPermissionDenied({ namespace: "root", name: "echo" }),
				),
			);
			const loaded = yield* loadNamespaceEffect(rpcManifest).pipe(
				Effect.provideService(FieldTransportService, transportStub),
				Effect.provideService(
					MessageChannelService,
					createMessageChannelStub(),
				),
			);

			const error = yield* loaded.rpc.echo
				.call(42)
				.pipe(
					Effect.provideService(FieldTransportService, transportStub),
					Effect.flip,
				);
			expect(error._tag).toBe("FieldPermissionDenied");
		}),
	);

	testFetch(
		"call fails when the response does not match the schema",
		Effect.gen(function* () {
			const transportStub = createTransportStub();
			transportStub.callRpc.mockReturnValue(Effect.succeed("not a number"));
			const loaded = yield* loadNamespaceEffect(rpcManifest).pipe(
				Effect.provideService(FieldTransportService, transportStub),
				Effect.provideService(
					MessageChannelService,
					createMessageChannelStub(),
				),
			);

			const error = yield* loaded.rpc.echo
				.call(42)
				.pipe(
					Effect.provideService(FieldTransportService, transportStub),
					Effect.flip,
				);
			expect(error._tag).toBe("FieldDecodeError");
		}),
	);
});

describe("loadNamespace (Promise wrapper)", () => {
	test("forwards to the injected transport", async () => {
		const transportStub = createTransportStub();
		transportStub.getReplicant.mockReturnValue(Effect.succeed(42));
		const manifest = defineNamespace("root", {
			replicant: { count: { schema: Schema.Number } },
		});

		const messageChannelStub = createMessageChannelStub();
		const loaded = await loadNamespace(manifest, {
			fieldTransport: () => transportStub,
			messageChannel: () => messageChannelStub,
		});

		expect(await loaded.replicant.count.get()).toBe(42);
		await loaded.replicant.count.set(9);
		expect(transportStub.updateReplicant).toHaveBeenCalledWith(
			"root",
			"count",
			[{ op: "replace", path: "", value: 9 }],
		);
	});

	test("publishes a topic and calls an rpc through the Promise API", async () => {
		const transportStub = createTransportStub();
		transportStub.callRpc.mockReturnValue(Effect.succeed(84));
		const manifest = defineNamespace("root", {
			topic: { chat: { schema: Schema.Number } },
			rpc: {
				echo: { schema: { request: Schema.Number, response: Schema.Number } },
			},
		});

		const loaded = await loadNamespace(manifest, {
			fieldTransport: () => transportStub,
			messageChannel: () => createMessageChannelStub(),
		});

		await loaded.topic.chat.publish(3);
		expect(transportStub.publishTopic).toHaveBeenCalledWith("root", "chat", 3);
		expect(await loaded.rpc.echo.call(42)).toBe(84);
		expect(transportStub.callRpc).toHaveBeenCalledWith("root", "echo", 42);
	});

	test("calls onError when the subscribe is rejected after the first value", async () => {
		const transportStub = createTransportStub();
		const queue = Effect.runSync(Queue.unbounded<ServerMessage>());
		const send = vi.fn<MessageChannel["send"]>(() => Effect.void);
		const messageChannelStub: MessageChannel = {
			send,
			receive: () => Effect.succeed(Stream.fromQueue(queue)),
		};
		const manifest = defineNamespace("root", {
			replicant: { count: { schema: Schema.Number } },
		});
		const field = {
			type: "replicant",
			namespace: "root",
			name: "count",
		} as const;

		const loaded = await loadNamespace(manifest, {
			fieldTransport: () => transportStub,
			messageChannel: () => messageChannelStub,
		});

		const received: number[] = [];
		const onError = vi.fn();
		const subscribed = loaded.replicant.count.subscribe((value) => {
			received.push(value);
		}, onError);
		await vi.waitFor(() =>
			expect(send).toHaveBeenCalledWith({ _tag: "subscribe", field }),
		);
		Queue.offerUnsafe(
			queue,
			ReplicantSnapshotMessage.make({ field, value: 1, revision: 1 }),
		);
		const cancel = await subscribed;
		onTestFinished(() => cancel());
		expect(received).toEqual([1]);

		Queue.offerUnsafe(
			queue,
			SubscribeRejectedMessage.make({ field, reason: "forbidden" }),
		);
		await vi.waitFor(() =>
			expect(onError).toHaveBeenCalledWith(
				new FieldPermissionDenied({ namespace: "root", name: "count" }),
			),
		);
		expect(received).toEqual([1]);
	});

	test("topic subscribe resolves before any event is published", async () => {
		const manifest = defineNamespace("root", {
			topic: { chat: { schema: Schema.Number } },
		});
		const loaded = await loadNamespace(manifest, {
			fieldTransport: () => createTransportStub(),
			messageChannel: () => createMessageChannelStub(),
		});

		const received: number[] = [];
		const cancel = await loaded.topic.chat.subscribe((value) => {
			received.push(value);
		});
		onTestFinished(() => cancel());
		expect(received).toEqual([]);
	});
});

describe("derivation over loaded fields", () => {
	const manifest = defineNamespace("match", {
		replicant: {
			scoreLeft: { schema: Schema.FiniteFromString },
			scoreRight: { schema: Schema.FiniteFromString },
		},
	});

	const makePubSubChannel = Effect.gen(function* () {
		const pubsub = yield* PubSub.unbounded<ServerMessage>();
		const send = vi.fn<MessageChannel["send"]>(() => Effect.void);
		const channel: MessageChannel = {
			send,
			receive: () =>
				PubSub.subscribe(pubsub).pipe(Effect.map(Stream.fromSubscription)),
		};
		return { channel, pubsub, send };
	});

	const publish = (name: string, value: number, revision = 1): ServerMessage =>
		ReplicantSnapshotMessage.make({
			field: { type: "replicant", namespace: "match", name },
			value: String(value),
			revision,
		});

	testFetch(
		"derive spans loaded fields and updates as publishes arrive",
		Effect.gen(function* () {
			const { channel, pubsub, send } = yield* makePubSubChannel;
			const loaded = yield* loadNamespaceEffect(manifest).pipe(
				Effect.provideService(FieldTransportService, createTransportStub()),
				Effect.provideService(MessageChannelService, channel),
			);

			const leader = derive((get) => {
				const left = get(loaded.replicant.scoreLeft);
				const right = get(loaded.replicant.scoreRight);
				if (left === right) {
					return "tie";
				}
				return left > right ? "left" : "right";
			});

			const seen: string[] = [];
			const unsubscribe = leader.subscribe((value) => {
				seen.push(value);
			});
			onTestFinished(() => unsubscribe());

			// Synchronous get() suspensions
			yield* Effect.promise(() =>
				vi.waitFor(() => {
					expect(
						send.mock.calls.filter(([msg]) => msg._tag === "subscribe"),
					).toHaveLength(1);
				}),
			);
			yield* PubSub.publish(pubsub, publish("scoreLeft", 0));
			yield* Effect.promise(() =>
				vi.waitFor(() => {
					expect(
						send.mock.calls.filter(([msg]) => msg._tag === "subscribe"),
					).toHaveLength(2);
				}),
			);
			yield* PubSub.publish(pubsub, publish("scoreRight", 0));
			yield* Effect.promise(() =>
				vi.waitFor(() => {
					expect(seen.at(-1)).toBe("tie");
				}),
			);

			yield* PubSub.publish(pubsub, publish("scoreLeft", 3, 2));
			yield* Effect.promise(() =>
				vi.waitFor(() => {
					expect(seen.at(-1)).toBe("left");
				}),
			);

			// get() runs the compute directly off the sources' own get()
			expect(yield* Effect.promise(() => leader.get())).toBe("left");
		}),
	);

	testFetch(
		"get reads the live cell without a transport round-trip while subscribed",
		Effect.gen(function* () {
			const { channel, pubsub, send } = yield* makePubSubChannel;
			const transportStub = createTransportStub();
			const loaded = yield* loadNamespaceEffect(manifest).pipe(
				Effect.provideService(FieldTransportService, transportStub),
				Effect.provideService(MessageChannelService, channel),
			);

			const scope = yield* Scope.make();
			yield* loaded.replicant.scoreLeft
				.subscribe()
				.pipe(Scope.provide(scope), Effect.forkChild);
			yield* Effect.promise(() =>
				vi.waitFor(() => {
					expect(
						send.mock.calls.some(([msg]) => msg._tag === "subscribe"),
					).toBe(true);
				}),
			);
			yield* PubSub.publish(pubsub, publish("scoreLeft", 7));
			yield* Effect.promise(() =>
				vi.waitFor(() => {
					expect(send.mock.calls.length).toBeGreaterThan(0);
				}),
			);

			yield* Effect.promise(() =>
				vi.waitFor(async () => {
					expect(
						await Effect.runPromise(
							loaded.replicant.scoreLeft
								.get()
								.pipe(
									Effect.provideService(FieldTransportService, transportStub),
								),
						),
					).toBe(7);
				}),
			);
			expect(transportStub.getReplicant).not.toHaveBeenCalled();

			yield* Scope.close(scope, Exit.void);
		}),
	);

	testFetch(
		"a write lands in the hot cell only as the server echo, which the next update reads as its base",
		Effect.gen(function* () {
			const { channel, pubsub, send } = yield* makePubSubChannel;
			const transportStub = createTransportStub();
			const loaded = yield* loadNamespaceEffect(manifest).pipe(
				Effect.provideService(FieldTransportService, transportStub),
				Effect.provideService(MessageChannelService, channel),
			);

			const scope = yield* Scope.make();
			yield* loaded.replicant.scoreLeft
				.subscribe()
				.pipe(Scope.provide(scope), Effect.forkChild);
			yield* Effect.promise(() =>
				vi.waitFor(() => {
					expect(
						send.mock.calls.some(([msg]) => msg._tag === "subscribe"),
					).toBe(true);
				}),
			);
			yield* PubSub.publish(pubsub, publish("scoreLeft", 0));
			yield* Effect.promise(() =>
				vi.waitFor(async () => {
					expect(
						await Effect.runPromise(loaded.replicant.scoreLeft.get()),
					).toBe(0);
				}),
			);

			yield* loaded.replicant.scoreLeft.set(10);
			expect(yield* loaded.replicant.scoreLeft.get()).toBe(0);

			yield* PubSub.publish(pubsub, publish("scoreLeft", 10, 2));
			yield* Effect.promise(() =>
				vi.waitFor(async () => {
					expect(
						await Effect.runPromise(loaded.replicant.scoreLeft.get()),
					).toBe(10);
				}),
			);

			transportStub.getReplicant.mockClear();
			yield* loaded.replicant.scoreLeft.update((v) => v + 1);

			expect(transportStub.updateReplicant).toHaveBeenLastCalledWith(
				"match",
				"scoreLeft",
				[
					{ op: "test-hash", path: "", hash: computeTestHash("10") },
					{ op: "replace", path: "", value: "11" },
				],
			);
			expect(transportStub.getReplicant).not.toHaveBeenCalled();

			yield* Scope.close(scope, Exit.void);
		}),
	);
});
