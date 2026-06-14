import { defineNamespace } from "@nodecg/core";
import type { ServerMessage } from "@nodecg/internal";
import { testEffect } from "@nodecg/private";
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
	type MessageChannel,
	MessageChannelService,
} from "./services/message-channel/message-channel.ts";
import {
	StateNotFound,
	type StateTransport,
	StateTransportService,
} from "./services/state-transport/state-transport.ts";

const createTransportStub = () =>
	({
		readState: vi.fn<StateTransport["readState"]>(),
		readComputed: vi.fn<StateTransport["readComputed"]>(),
		updateState: vi.fn<StateTransport["updateState"]>(() => Effect.void),
	}) satisfies StateTransport;

const createMessageChannelStub = () =>
	({
		send: vi.fn<MessageChannel["send"]>(() => Effect.void),
		receive: () => Effect.succeed(Stream.never),
	}) satisfies MessageChannel;

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
					Effect.provideService(StateTransportService, transportStub),
					Effect.provideService(
						MessageChannelService,
						createMessageChannelStub(),
					),
				);

				expect(
					yield* loaded.state.count
						.get()
						.pipe(Effect.provideService(StateTransportService, transportStub)),
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
					Effect.provideService(StateTransportService, transportStub),
					Effect.provideService(
						MessageChannelService,
						createMessageChannelStub(),
					),
				);

				const error = yield* loaded.state.count
					.get()
					.pipe(
						Effect.provideService(StateTransportService, transportStub),
						Effect.flip,
					);
				expect(error._tag).toBe("StateDecodeError");
			}),
		),
	);

	test(
		"propagates StateNotFound from the transport",
		testEffect(
			Effect.gen(function* () {
				const transportStub = createTransportStub();
				transportStub.readState.mockReturnValue(
					Effect.fail(new StateNotFound({ namespace: "root", name: "count" })),
				);
				const manifest = defineNamespace("root", {
					state: { count: { schema: Schema.Number } },
				});

				const loaded = yield* loadNamespaceEffect(manifest).pipe(
					Effect.provideService(StateTransportService, transportStub),
					Effect.provideService(
						MessageChannelService,
						createMessageChannelStub(),
					),
				);

				const error = yield* loaded.state.count
					.get()
					.pipe(
						Effect.provideService(StateTransportService, transportStub),
						Effect.flip,
					);
				expect(error._tag).toBe("StateNotFound");
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
					Effect.provideService(StateTransportService, transportStub),
					Effect.provideService(
						MessageChannelService,
						createMessageChannelStub(),
					),
				);

				expect(
					yield* loaded.state.when
						.get()
						.pipe(Effect.provideService(StateTransportService, transportStub)),
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
					Effect.provideService(StateTransportService, transportStub),
					Effect.provideService(
						MessageChannelService,
						createMessageChannelStub(),
					),
				);

				yield* loaded.state.count
					.set(7)
					.pipe(Effect.provideService(StateTransportService, transportStub));
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
					Effect.provideService(StateTransportService, transportStub),
					Effect.provideService(
						MessageChannelService,
						createMessageChannelStub(),
					),
				);

				const error = yield* loaded.state.count
					.set("not a number" as unknown as number)
					.pipe(
						Effect.provideService(StateTransportService, transportStub),
						Effect.flip,
					);
				expect(error._tag).toBe("StateEncodeError");
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
					Effect.provideService(StateTransportService, transportStub),
					Effect.provideService(
						MessageChannelService,
						createMessageChannelStub(),
					),
				);

				yield* loaded.state.when
					.set(new Date("2030-01-01T00:00:00.000Z"))
					.pipe(Effect.provideService(StateTransportService, transportStub));
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
					Effect.provideService(StateTransportService, transportStub),
					Effect.provideService(
						MessageChannelService,
						createMessageChannelStub(),
					),
				);

				yield* loaded.state.count
					.update((v) => v + 5)
					.pipe(Effect.provideService(StateTransportService, transportStub));
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
					Effect.provideService(StateTransportService, transportStub),
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
					Effect.provideService(StateTransportService, transportStub),
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
					Effect.provideService(StateTransportService, transportStub),
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
					Effect.provideService(StateTransportService, transportStub),
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
					Effect.provideService(StateTransportService, transportStub),
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
					Effect.provideService(StateTransportService, transportStub),
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
					Effect.provideService(StateTransportService, transportStub),
					Effect.provideService(
						MessageChannelService,
						createMessageChannelStub(),
					),
				);

				expect(
					yield* loaded.computed.firstGameId
						.get()
						.pipe(Effect.provideService(StateTransportService, transportStub)),
				).toBe("a");
			}),
		),
	);

	test(
		"is read-only (no set)",
		testEffect(
			Effect.gen(function* () {
				const loaded = yield* loadNamespaceEffect(computedManifest).pipe(
					Effect.provideService(StateTransportService, createTransportStub()),
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
					Effect.provideService(StateTransportService, transportStub),
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

describe("loadNamespace (Promise wrapper)", () => {
	test("forwards to the injected transport", async () => {
		const transportStub = createTransportStub();
		transportStub.readState.mockReturnValue(Effect.succeed(42));
		const manifest = defineNamespace("root", {
			state: { count: { schema: Schema.Number } },
		});

		const messageChannelStub = createMessageChannelStub();
		const loaded = await loadNamespace(manifest, {
			stateTransport: () => transportStub,
			messageChannel: () => messageChannelStub,
		});

		expect(await loaded.state.count.get()).toBe(42);
		await loaded.state.count.set(9);
		expect(transportStub.updateState).toHaveBeenCalledWith("root", "count", 9);
	});
});
