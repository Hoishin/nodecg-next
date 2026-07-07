import { FetchHttpClient } from "@effect/platform";
import { defineNamespace } from "@nodecg/core";
import type { ServerMessage } from "@nodecg/internal";
import { makeTestEffect } from "@nodecg/internal/test-utils";
import {
	Effect,
	Exit,
	Fiber,
	Mailbox,
	Option,
	PubSub,
	Schema,
	Scope,
	Stream,
} from "effect";
import { assert, describe, expect, test, vi } from "vitest";

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

const createTransportStub = () =>
	({
		readState: vi.fn<FieldTransport["readState"]>(),
		readComputed: vi.fn<FieldTransport["readComputed"]>(),
		updateState: vi.fn<FieldTransport["updateState"]>(() => Effect.void),
		publishTopic: vi.fn<FieldTransport["publishTopic"]>(() => Effect.void),
		callRpc: vi.fn<FieldTransport["callRpc"]>(),
	}) satisfies FieldTransport;

const createMessageChannelStub = () =>
	({
		send: vi.fn<MessageChannel["send"]>(() => Effect.void),
		receive: () => Effect.succeed(Stream.never),
	}) satisfies MessageChannel;

const testEffect = makeTestEffect(FetchHttpClient.layer);

describe("get", () => {
	test(
		"decodes the value returned by the transport",
		testEffect(
			Effect.gen(function* () {
				const transportStub = createTransportStub();
				transportStub.readState.mockReturnValue(Effect.succeed(42));
				const manifest = defineNamespace("root", {
					state: { count: { schema: Schema.Number } },
				});

				const loaded = yield* loadNamespaceEffect(manifest).pipe(
					Effect.provideService(FieldTransportService, transportStub),
					Effect.provideService(
						MessageChannelService,
						createMessageChannelStub(),
					),
				);

				expect(
					yield* loaded.state.count
						.get()
						.pipe(Effect.provideService(FieldTransportService, transportStub)),
				).toBe(42);
			}),
		),
	);

	test(
		"fails when the stored value does not match the schema",
		testEffect(
			Effect.gen(function* () {
				const transportStub = createTransportStub();
				transportStub.readState.mockReturnValue(Effect.succeed("not a number"));
				const manifest = defineNamespace("root", {
					state: { count: { schema: Schema.Number } },
				});

				const loaded = yield* loadNamespaceEffect(manifest).pipe(
					Effect.provideService(FieldTransportService, transportStub),
					Effect.provideService(
						MessageChannelService,
						createMessageChannelStub(),
					),
				);

				const error = yield* loaded.state.count
					.get()
					.pipe(
						Effect.provideService(FieldTransportService, transportStub),
						Effect.flip,
					);
				expect(error._tag).toBe("FieldDecodeError");
			}),
		),
	);

	test(
		"propagates FieldNotFound from the transport",
		testEffect(
			Effect.gen(function* () {
				const transportStub = createTransportStub();
				transportStub.readState.mockReturnValue(
					Effect.fail(new FieldNotFound({ namespace: "root", name: "count" })),
				);
				const manifest = defineNamespace("root", {
					state: { count: { schema: Schema.Number } },
				});

				const loaded = yield* loadNamespaceEffect(manifest).pipe(
					Effect.provideService(FieldTransportService, transportStub),
					Effect.provideService(
						MessageChannelService,
						createMessageChannelStub(),
					),
				);

				const error = yield* loaded.state.count
					.get()
					.pipe(
						Effect.provideService(FieldTransportService, transportStub),
						Effect.flip,
					);
				expect(error._tag).toBe("FieldNotFound");
			}),
		),
	);

	test(
		"reads a stored string back into a Date",
		testEffect(
			Effect.gen(function* () {
				const transportStub = createTransportStub();
				transportStub.readState.mockReturnValue(
					Effect.succeed("2030-01-01T00:00:00.000Z"),
				);
				const manifest = defineNamespace("root", {
					state: { when: { schema: Schema.DateFromString } },
				});

				const loaded = yield* loadNamespaceEffect(manifest).pipe(
					Effect.provideService(FieldTransportService, transportStub),
					Effect.provideService(
						MessageChannelService,
						createMessageChannelStub(),
					),
				);

				expect(
					yield* loaded.state.when
						.get()
						.pipe(Effect.provideService(FieldTransportService, transportStub)),
				).toEqual(new Date("2030-01-01T00:00:00.000Z"));
			}),
		),
	);
});

describe("set", () => {
	test(
		"encodes the value and writes it via the transport",
		testEffect(
			Effect.gen(function* () {
				const transportStub = createTransportStub();
				const manifest = defineNamespace("root", {
					state: { count: { schema: Schema.Number } },
				});

				const loaded = yield* loadNamespaceEffect(manifest).pipe(
					Effect.provideService(FieldTransportService, transportStub),
					Effect.provideService(
						MessageChannelService,
						createMessageChannelStub(),
					),
				);

				yield* loaded.state.count
					.set(7)
					.pipe(Effect.provideService(FieldTransportService, transportStub));
				expect(transportStub.updateState).toHaveBeenCalledWith(
					"root",
					"count",
					7,
				);
			}),
		),
	);

	test(
		"fails when the value fails schema validation",
		testEffect(
			Effect.gen(function* () {
				const transportStub = createTransportStub();
				const manifest = defineNamespace("root", {
					state: { count: { schema: Schema.Number } },
				});

				const loaded = yield* loadNamespaceEffect(manifest).pipe(
					Effect.provideService(FieldTransportService, transportStub),
					Effect.provideService(
						MessageChannelService,
						createMessageChannelStub(),
					),
				);

				const error = yield* loaded.state.count
					.set("not a number" as unknown as number)
					.pipe(
						Effect.provideService(FieldTransportService, transportStub),
						Effect.flip,
					);
				expect(error._tag).toBe("FieldEncodeError");
			}),
		),
	);

	test(
		"sends a Date to the transport as a string",
		testEffect(
			Effect.gen(function* () {
				const transportStub = createTransportStub();
				const manifest = defineNamespace("root", {
					state: { when: { schema: Schema.DateFromString } },
				});

				const loaded = yield* loadNamespaceEffect(manifest).pipe(
					Effect.provideService(FieldTransportService, transportStub),
					Effect.provideService(
						MessageChannelService,
						createMessageChannelStub(),
					),
				);

				yield* loaded.state.when
					.set(new Date("2030-01-01T00:00:00.000Z"))
					.pipe(Effect.provideService(FieldTransportService, transportStub));
				expect(transportStub.updateState).toHaveBeenLastCalledWith(
					"root",
					"when",
					"2030-01-01T00:00:00.000Z",
				);
			}),
		),
	);
});

describe("update", () => {
	test(
		"reads the current value, applies the fn, and writes the result",
		testEffect(
			Effect.gen(function* () {
				const transportStub = createTransportStub();
				transportStub.readState.mockReturnValue(Effect.succeed(10));
				const manifest = defineNamespace("root", {
					state: { count: { schema: Schema.Number } },
				});

				const loaded = yield* loadNamespaceEffect(manifest).pipe(
					Effect.provideService(FieldTransportService, transportStub),
					Effect.provideService(
						MessageChannelService,
						createMessageChannelStub(),
					),
				);

				yield* loaded.state.count
					.update((v) => v + 5)
					.pipe(Effect.provideService(FieldTransportService, transportStub));
				expect(transportStub.updateState).toHaveBeenLastCalledWith(
					"root",
					"count",
					15,
				);
			}),
		),
	);
});

describe("subscribe", () => {
	const subscribeFrame = {
		_tag: "subscribe",
		field: { type: "state", namespace: "root", name: "count" },
	};
	const unsubscribeFrame = {
		_tag: "unsubscribe",
		field: { type: "state", namespace: "root", name: "count" },
	};
	const publishFrame = (value: number): ServerMessage => ({
		_tag: "publish",
		field: { type: "state", namespace: "root", name: "count" },
		value,
	});

	test(
		"sends server subscribe and emits decoded matching publishes",
		testEffect(
			Effect.gen(function* () {
				const transportStub = createTransportStub();
				const mailbox = yield* Mailbox.make<ServerMessage>();
				const send = vi.fn<MessageChannel["send"]>(() => Effect.void);
				const messageChannelStub: MessageChannel = {
					send,
					receive: () => Effect.succeed(Mailbox.toStream(mailbox)),
				};
				const manifest = defineNamespace("root", {
					state: { count: { schema: Schema.Number } },
				});

				const loaded = yield* loadNamespaceEffect(manifest).pipe(
					Effect.provideService(FieldTransportService, transportStub),
					Effect.provideService(MessageChannelService, messageChannelStub),
				);

				const head = yield* loaded.state.count
					.subscribe()
					.pipe(Effect.flatMap(Stream.runHead), Effect.fork);
				yield* Effect.promise(() =>
					vi.waitFor(() => {
						expect(send).toHaveBeenCalledWith(subscribeFrame);
					}),
				);

				yield* mailbox.offer(publishFrame(42));

				const result = yield* Fiber.join(head);
				assert(Option.isSome(result));
				expect(result.value).toBe(42);
			}),
		),
	);

	test(
		"ignores publishes for a different name",
		testEffect(
			Effect.gen(function* () {
				const transportStub = createTransportStub();
				const mailbox = yield* Mailbox.make<ServerMessage>();
				const send = vi.fn<MessageChannel["send"]>(() => Effect.void);
				const messageChannelStub: MessageChannel = {
					send,
					receive: () => Effect.succeed(Mailbox.toStream(mailbox)),
				};
				const manifest = defineNamespace("root", {
					state: {
						count: { schema: Schema.Number },
						other: { schema: Schema.Number },
					},
				});

				const loaded = yield* loadNamespaceEffect(manifest).pipe(
					Effect.provideService(FieldTransportService, transportStub),
					Effect.provideService(MessageChannelService, messageChannelStub),
				);

				const head = yield* loaded.state.count
					.subscribe()
					.pipe(Effect.flatMap(Stream.runHead), Effect.fork);
				yield* Effect.promise(() =>
					vi.waitFor(() => {
						expect(send).toHaveBeenCalledWith(subscribeFrame);
					}),
				);

				yield* mailbox.offer({
					_tag: "publish",
					field: { type: "state", namespace: "root", name: "other" },
					value: 99,
				});
				yield* mailbox.offer(publishFrame(7));

				const result = yield* Fiber.join(head);
				assert(Option.isSome(result));
				expect(result.value).toBe(7);
			}),
		),
	);

	test(
		"resolves only after the first publish",
		testEffect(
			Effect.gen(function* () {
				const transportStub = createTransportStub();
				const mailbox = yield* Mailbox.make<ServerMessage>();
				const send = vi.fn<MessageChannel["send"]>(() => Effect.void);
				const messageChannelStub: MessageChannel = {
					send,
					receive: () => Effect.succeed(Mailbox.toStream(mailbox)),
				};
				const manifest = defineNamespace("root", {
					state: { count: { schema: Schema.Number } },
				});

				const loaded = yield* loadNamespaceEffect(manifest).pipe(
					Effect.provideService(FieldTransportService, transportStub),
					Effect.provideService(MessageChannelService, messageChannelStub),
				);

				const fiber = yield* loaded.state.count
					.subscribe()
					.pipe(Effect.asVoid, Effect.fork);
				yield* Effect.promise(() =>
					vi.waitFor(() => {
						expect(send).toHaveBeenCalledWith(subscribeFrame);
					}),
				);
				assert(Option.isNone(yield* Fiber.poll(fiber)));

				yield* mailbox.offer(publishFrame(0));
				yield* Fiber.join(fiber);
			}),
		),
	);

	test(
		"sends server unsubscribe when the subscription scope closes",
		testEffect(
			Effect.gen(function* () {
				const transportStub = createTransportStub();
				const mailbox = yield* Mailbox.make<ServerMessage>();
				const send = vi.fn<MessageChannel["send"]>(() => Effect.void);
				const messageChannelStub: MessageChannel = {
					send,
					receive: () => Effect.succeed(Mailbox.toStream(mailbox)),
				};
				const manifest = defineNamespace("root", {
					state: { count: { schema: Schema.Number } },
				});

				const loaded = yield* loadNamespaceEffect(manifest).pipe(
					Effect.provideService(FieldTransportService, transportStub),
					Effect.provideService(MessageChannelService, messageChannelStub),
				);

				const scope = yield* Scope.make();
				const fiber = yield* loaded.state.count
					.subscribe()
					.pipe(Effect.asVoid, Scope.extend(scope), Effect.fork);
				yield* Effect.promise(() =>
					vi.waitFor(() => {
						expect(send).toHaveBeenCalledWith(subscribeFrame);
					}),
				);
				yield* mailbox.offer(publishFrame(0));
				yield* Fiber.join(fiber);

				yield* Scope.close(scope, Exit.void);
				yield* Effect.promise(() =>
					vi.waitFor(() => {
						expect(send).toHaveBeenCalledWith(unsubscribeFrame);
					}),
				);
			}),
		),
	);

	test(
		"refcounts: subscribe sent once, unsubscribe only after the last scope closes",
		testEffect(
			Effect.gen(function* () {
				const transportStub = createTransportStub();
				const mailbox = yield* Mailbox.make<ServerMessage>();
				const send = vi.fn<MessageChannel["send"]>(() => Effect.void);
				const messageChannelStub: MessageChannel = {
					send,
					receive: () => Effect.succeed(Mailbox.toStream(mailbox)),
				};
				const manifest = defineNamespace("root", {
					state: { count: { schema: Schema.Number } },
				});

				const loaded = yield* loadNamespaceEffect(manifest).pipe(
					Effect.provideService(FieldTransportService, transportStub),
					Effect.provideService(MessageChannelService, messageChannelStub),
				);

				const scope1 = yield* Scope.make();
				const sub1 = yield* loaded.state.count
					.subscribe()
					.pipe(Effect.asVoid, Scope.extend(scope1), Effect.fork);
				yield* Effect.promise(() =>
					vi.waitFor(() => {
						expect(send).toHaveBeenCalledWith(subscribeFrame);
					}),
				);
				yield* mailbox.offer(publishFrame(0));
				yield* Fiber.join(sub1);

				const scope2 = yield* Scope.make();
				const sub2 = yield* loaded.state.count
					.subscribe()
					.pipe(Effect.asVoid, Scope.extend(scope2), Effect.fork);
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
		),
	);

	test(
		"a later subscriber receives the current value on subscribe",
		testEffect(
			Effect.gen(function* () {
				const transportStub = createTransportStub();
				const pubsub = yield* PubSub.unbounded<ServerMessage>();
				const send = vi.fn<MessageChannel["send"]>(() => Effect.void);
				const messageChannelStub: MessageChannel = {
					send,
					receive: () => Stream.fromPubSub(pubsub, { scoped: true }),
				};
				const manifest = defineNamespace("root", {
					state: { count: { schema: Schema.Number } },
				});

				const loaded = yield* loadNamespaceEffect(manifest).pipe(
					Effect.provideService(FieldTransportService, transportStub),
					Effect.provideService(MessageChannelService, messageChannelStub),
				);

				const received1: number[] = [];
				const scope1 = yield* Scope.make();
				const sub1 = yield* loaded.state.count.subscribe().pipe(
					Effect.flatMap((stream) =>
						Stream.runForEach(stream, (value) =>
							Effect.sync(() => received1.push(value)),
						),
					),
					Scope.extend(scope1),
					Effect.fork,
				);
				yield* Effect.promise(() =>
					vi.waitFor(() => {
						expect(send).toHaveBeenCalledWith(subscribeFrame);
					}),
				);
				yield* pubsub.publish(publishFrame(5));
				yield* Effect.promise(() =>
					vi.waitFor(() => {
						expect(received1).toEqual([5]);
					}),
				);

				const received2: number[] = [];
				const scope2 = yield* Scope.make();
				const sub2 = yield* loaded.state.count.subscribe().pipe(
					Effect.flatMap((stream) =>
						Stream.runForEach(stream, (value) =>
							Effect.sync(() => received2.push(value)),
						),
					),
					Scope.extend(scope2),
					Effect.fork,
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
		),
	);

	const rejectedFrame = (reason: "forbidden" | "not-found"): ServerMessage => ({
		_tag: "subscribe-rejected",
		field: { type: "state", namespace: "root", name: "count" },
		reason,
	});

	test(
		"rejects with FieldPermissionDenied on a forbidden frame",
		testEffect(
			Effect.gen(function* () {
				const transportStub = createTransportStub();
				const mailbox = yield* Mailbox.make<ServerMessage>();
				const send = vi.fn<MessageChannel["send"]>(() => Effect.void);
				const messageChannelStub: MessageChannel = {
					send,
					receive: () => Effect.succeed(Mailbox.toStream(mailbox)),
				};
				const manifest = defineNamespace("root", {
					state: { count: { schema: Schema.Number } },
				});

				const loaded = yield* loadNamespaceEffect(manifest).pipe(
					Effect.provideService(FieldTransportService, transportStub),
					Effect.provideService(MessageChannelService, messageChannelStub),
				);

				const fiber = yield* loaded.state.count
					.subscribe()
					.pipe(Effect.flip, Effect.fork);
				yield* Effect.promise(() =>
					vi.waitFor(() => {
						expect(send).toHaveBeenCalledWith(subscribeFrame);
					}),
				);
				yield* mailbox.offer(rejectedFrame("forbidden"));

				const error = yield* Fiber.join(fiber);
				expect(error._tag).toBe("FieldPermissionDenied");
			}),
		),
	);

	test(
		"rejects with FieldNotFound on a not-found frame",
		testEffect(
			Effect.gen(function* () {
				const transportStub = createTransportStub();
				const mailbox = yield* Mailbox.make<ServerMessage>();
				const send = vi.fn<MessageChannel["send"]>(() => Effect.void);
				const messageChannelStub: MessageChannel = {
					send,
					receive: () => Effect.succeed(Mailbox.toStream(mailbox)),
				};
				const manifest = defineNamespace("root", {
					state: { count: { schema: Schema.Number } },
				});

				const loaded = yield* loadNamespaceEffect(manifest).pipe(
					Effect.provideService(FieldTransportService, transportStub),
					Effect.provideService(MessageChannelService, messageChannelStub),
				);

				const fiber = yield* loaded.state.count
					.subscribe()
					.pipe(Effect.flip, Effect.fork);
				yield* Effect.promise(() =>
					vi.waitFor(() => {
						expect(send).toHaveBeenCalledWith(subscribeFrame);
					}),
				);
				yield* mailbox.offer(rejectedFrame("not-found"));

				const error = yield* Fiber.join(fiber);
				expect(error._tag).toBe("FieldNotFound");
			}),
		),
	);

	test(
		"re-subscribing after a rejection sends a fresh server subscribe",
		testEffect(
			Effect.gen(function* () {
				const transportStub = createTransportStub();
				const mailbox = yield* Mailbox.make<ServerMessage>();
				const send = vi.fn<MessageChannel["send"]>(() => Effect.void);
				const messageChannelStub: MessageChannel = {
					send,
					receive: () => Effect.succeed(Mailbox.toStream(mailbox)),
				};
				const manifest = defineNamespace("root", {
					state: { count: { schema: Schema.Number } },
				});

				const loaded = yield* loadNamespaceEffect(manifest).pipe(
					Effect.provideService(FieldTransportService, transportStub),
					Effect.provideService(MessageChannelService, messageChannelStub),
				);

				const scope1 = yield* Scope.make();
				const fiber1 = yield* loaded.state.count
					.subscribe()
					.pipe(Effect.flip, Scope.extend(scope1), Effect.fork);
				yield* Effect.promise(() =>
					vi.waitFor(() => {
						expect(send).toHaveBeenCalledWith(subscribeFrame);
					}),
				);
				yield* mailbox.offer(rejectedFrame("forbidden"));
				yield* Fiber.join(fiber1);
				yield* Scope.close(scope1, Exit.void);

				const scope2 = yield* Scope.make();
				const fiber2 = yield* loaded.state.count
					.subscribe()
					.pipe(Effect.flip, Scope.extend(scope2), Effect.fork);
				yield* Fiber.join(fiber2);

				const subscribeCount = send.mock.calls.filter(
					([msg]) => msg._tag === "subscribe",
				).length;
				expect(subscribeCount).toBe(2);
				yield* Scope.close(scope2, Exit.void);
			}),
		),
	);
});

describe("computed", () => {
	const computedManifest = defineNamespace("root", {
		state: {
			games: { schema: Schema.Array(Schema.Struct({ id: Schema.String })) },
		},
		computed: { firstGameId: { schema: Schema.NullOr(Schema.String) } },
	});

	test(
		"get decodes the computed value from the transport",
		testEffect(
			Effect.gen(function* () {
				const transportStub = createTransportStub();
				transportStub.readComputed.mockReturnValue(Effect.succeed("a"));

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
		),
	);

	test(
		"is read-only (no set)",
		testEffect(
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
		),
	);

	test(
		"subscribe emits decoded matching publishes",
		testEffect(
			Effect.gen(function* () {
				const transportStub = createTransportStub();
				const pubsub = yield* PubSub.unbounded<ServerMessage>();
				const send = vi.fn<MessageChannel["send"]>(() => Effect.void);
				const messageChannelStub: MessageChannel = {
					send,
					receive: () => Stream.fromPubSub(pubsub, { scoped: true }),
				};

				const loaded = yield* loadNamespaceEffect(computedManifest).pipe(
					Effect.provideService(FieldTransportService, transportStub),
					Effect.provideService(MessageChannelService, messageChannelStub),
				);

				const head = yield* loaded.computed.firstGameId
					.subscribe()
					.pipe(Effect.flatMap(Stream.runHead), Effect.fork);
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

				yield* pubsub.publish({
					_tag: "publish",
					field: { type: "computed", namespace: "root", name: "firstGameId" },
					value: "z",
				});

				const result = yield* Fiber.join(head);
				assert(Option.isSome(result));
				expect(result.value).toBe("z");
			}),
		),
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
	const publishFrame = (value: number): ServerMessage => ({
		_tag: "publish",
		field: { type: "topic", namespace: "root", name: "chat" },
		value,
	});

	test(
		"publish encodes the value and forwards it to the transport",
		testEffect(
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
		),
	);

	test(
		"publish fails when the value fails schema validation",
		testEffect(
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
		),
	);

	test(
		"subscribe sends server subscribe and emits decoded matching publishes",
		testEffect(
			Effect.gen(function* () {
				const transportStub = createTransportStub();
				const mailbox = yield* Mailbox.make<ServerMessage>();
				const send = vi.fn<MessageChannel["send"]>(() => Effect.void);
				const messageChannelStub: MessageChannel = {
					send,
					receive: () => Effect.succeed(Mailbox.toStream(mailbox)),
				};
				const loaded = yield* loadNamespaceEffect(topicManifest).pipe(
					Effect.provideService(FieldTransportService, transportStub),
					Effect.provideService(MessageChannelService, messageChannelStub),
				);

				const head = yield* loaded.topic.chat
					.subscribe()
					.pipe(Effect.flatMap(Stream.runHead), Effect.fork);
				yield* Effect.promise(() =>
					vi.waitFor(() => {
						expect(send).toHaveBeenCalledWith(subscribeFrame);
					}),
				);

				yield* mailbox.offer({
					_tag: "publish",
					field: { type: "topic", namespace: "root", name: "other" },
					value: 99,
				});
				yield* mailbox.offer(publishFrame(42));

				const result = yield* Fiber.join(head);
				assert(Option.isSome(result));
				expect(result.value).toBe(42);
			}),
		),
	);

	test(
		"refcounts: subscribe sent once, unsubscribe only after the last scope closes",
		testEffect(
			Effect.gen(function* () {
				const transportStub = createTransportStub();
				const mailbox = yield* Mailbox.make<ServerMessage>();
				const send = vi.fn<MessageChannel["send"]>(() => Effect.void);
				const messageChannelStub: MessageChannel = {
					send,
					receive: () => Effect.succeed(Mailbox.toStream(mailbox)),
				};
				const loaded = yield* loadNamespaceEffect(topicManifest).pipe(
					Effect.provideService(FieldTransportService, transportStub),
					Effect.provideService(MessageChannelService, messageChannelStub),
				);

				const scope1 = yield* Scope.make();
				const sub1 = yield* loaded.topic.chat
					.subscribe()
					.pipe(Effect.asVoid, Scope.extend(scope1), Effect.fork);
				yield* Fiber.join(sub1);
				yield* Effect.promise(() =>
					vi.waitFor(() => {
						expect(send).toHaveBeenCalledWith(subscribeFrame);
					}),
				);

				const scope2 = yield* Scope.make();
				const sub2 = yield* loaded.topic.chat
					.subscribe()
					.pipe(Effect.asVoid, Scope.extend(scope2), Effect.fork);
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
		),
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

	test(
		"call encodes the request, forwards it, and decodes the response",
		testEffect(
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
		),
	);

	test(
		"call decodes a string response into a Date",
		testEffect(
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
		),
	);

	test(
		"call propagates a typed transport error",
		testEffect(
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
		),
	);

	test(
		"call fails when the response does not match the schema",
		testEffect(
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
		),
	);
});

describe("loadNamespace (Promise wrapper)", () => {
	test("forwards to the injected transport", async () => {
		const transportStub = createTransportStub();
		transportStub.readState.mockReturnValue(Effect.succeed(42));
		const manifest = defineNamespace("root", {
			state: { count: { schema: Schema.Number } },
		});

		const messageChannelStub = createMessageChannelStub();
		const loaded = await loadNamespace(manifest, {
			fieldTransport: () => transportStub,
			messageChannel: () => messageChannelStub,
		});

		expect(await loaded.state.count.get()).toBe(42);
		await loaded.state.count.set(9);
		expect(transportStub.updateState).toHaveBeenCalledWith("root", "count", 9);
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
});
