import { defineState } from "@nodecg/core";
import type { ServerMessage } from "@nodecg/internal";
import { testEffect } from "@nodecg/private";
import {
	Effect,
	Exit,
	Fiber,
	Mailbox,
	Option,
	Schema,
	Scope,
	Stream,
} from "effect";
import { assert, describe, expect, test, vi } from "vitest";

import { loadState, loadStateEffect } from "./load-state.ts";
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
		read: vi.fn<StateTransport["read"]>(),
		update: vi.fn<StateTransport["update"]>(() => Effect.void),
	}) satisfies StateTransport;

const createMessageChannelStub = () =>
	({
		send: vi.fn<MessageChannel["send"]>(() => Effect.void),
		receive: () => Stream.never,
	}) satisfies MessageChannel;

describe("get", () => {
	test(
		"decodes the value returned by the transport",
		testEffect(
			Effect.gen(function* () {
				const transportStub = createTransportStub();
				transportStub.read.mockReturnValue(Effect.succeed(42));
				const manifest = defineState("root", {
					count: { schema: Schema.Number },
				});

				const state = yield* loadStateEffect(manifest).pipe(
					Effect.provideService(StateTransportService, transportStub),
					Effect.provideService(
						MessageChannelService,
						createMessageChannelStub(),
					),
				);

				expect(
					yield* state.count
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
				transportStub.read.mockReturnValue(Effect.succeed("not a number"));
				const manifest = defineState("root", {
					count: { schema: Schema.Number },
				});

				const state = yield* loadStateEffect(manifest).pipe(
					Effect.provideService(StateTransportService, transportStub),
					Effect.provideService(
						MessageChannelService,
						createMessageChannelStub(),
					),
				);

				const error = yield* state.count
					.get()
					.pipe(
						Effect.provideService(StateTransportService, transportStub),
						Effect.flip,
					);
				expect(error._tag).toBe("GetStateError");
			}),
		),
	);

	test(
		"propagates StateNotFound from the transport",
		testEffect(
			Effect.gen(function* () {
				const transportStub = createTransportStub();
				transportStub.read.mockReturnValue(
					Effect.fail(new StateNotFound({ namespace: "root", name: "count" })),
				);
				const manifest = defineState("root", {
					count: { schema: Schema.Number },
				});

				const state = yield* loadStateEffect(manifest).pipe(
					Effect.provideService(StateTransportService, transportStub),
					Effect.provideService(
						MessageChannelService,
						createMessageChannelStub(),
					),
				);

				const error = yield* state.count
					.get()
					.pipe(
						Effect.provideService(StateTransportService, transportStub),
						Effect.flip,
					);
				expect(error._tag).toBe("GetStateError");
			}),
		),
	);

	test(
		"reads a stored string back into a Date",
		testEffect(
			Effect.gen(function* () {
				const transportStub = createTransportStub();
				transportStub.read.mockReturnValue(
					Effect.succeed("2030-01-01T00:00:00.000Z"),
				);
				const manifest = defineState("root", {
					when: { schema: Schema.DateFromString },
				});

				const state = yield* loadStateEffect(manifest).pipe(
					Effect.provideService(StateTransportService, transportStub),
					Effect.provideService(
						MessageChannelService,
						createMessageChannelStub(),
					),
				);

				expect(
					yield* state.when
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
				const manifest = defineState("root", {
					count: { schema: Schema.Number },
				});

				const state = yield* loadStateEffect(manifest).pipe(
					Effect.provideService(StateTransportService, transportStub),
					Effect.provideService(
						MessageChannelService,
						createMessageChannelStub(),
					),
				);

				yield* state.count
					.set(7)
					.pipe(Effect.provideService(StateTransportService, transportStub));
				expect(transportStub.update).toHaveBeenCalledWith("root", "count", 7);
			}),
		),
	);

	test(
		"fails when the value fails schema validation",
		testEffect(
			Effect.gen(function* () {
				const transportStub = createTransportStub();
				const manifest = defineState("root", {
					count: { schema: Schema.Number },
				});

				const state = yield* loadStateEffect(manifest).pipe(
					Effect.provideService(StateTransportService, transportStub),
					Effect.provideService(
						MessageChannelService,
						createMessageChannelStub(),
					),
				);

				const error = yield* state.count
					.set("not a number" as unknown as number)
					.pipe(
						Effect.provideService(StateTransportService, transportStub),
						Effect.flip,
					);
				expect(error._tag).toBe("UpdateStateError");
			}),
		),
	);

	test(
		"sends a Date to the transport as a string",
		testEffect(
			Effect.gen(function* () {
				const transportStub = createTransportStub();
				const manifest = defineState("root", {
					when: { schema: Schema.DateFromString },
				});

				const state = yield* loadStateEffect(manifest).pipe(
					Effect.provideService(StateTransportService, transportStub),
					Effect.provideService(
						MessageChannelService,
						createMessageChannelStub(),
					),
				);

				yield* state.when
					.set(new Date("2030-01-01T00:00:00.000Z"))
					.pipe(Effect.provideService(StateTransportService, transportStub));
				expect(transportStub.update).toHaveBeenLastCalledWith(
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
				transportStub.read.mockReturnValue(Effect.succeed(10));
				const manifest = defineState("root", {
					count: { schema: Schema.Number },
				});

				const state = yield* loadStateEffect(manifest).pipe(
					Effect.provideService(StateTransportService, transportStub),
					Effect.provideService(
						MessageChannelService,
						createMessageChannelStub(),
					),
				);

				yield* state.count
					.update((v) => v + 5)
					.pipe(Effect.provideService(StateTransportService, transportStub));
				expect(transportStub.update).toHaveBeenLastCalledWith(
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
		topic: "state",
		message: { filter: { namespace: "root", name: "count" } },
	};
	const unsubscribeFrame = {
		_tag: "unsubscribe",
		topic: "state",
		message: { filter: { namespace: "root", name: "count" } },
	};
	const publishFrame = (value: number): ServerMessage => ({
		_tag: "publish",
		topic: "state",
		message: { filter: { namespace: "root", name: "count" }, value },
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
					receive: () => Mailbox.toStream(mailbox),
				};
				const manifest = defineState("root", {
					count: { schema: Schema.Number },
				});

				const state = yield* loadStateEffect(manifest).pipe(
					Effect.provideService(StateTransportService, transportStub),
					Effect.provideService(MessageChannelService, messageChannelStub),
				);

				const head = yield* state.count
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
					receive: () => Mailbox.toStream(mailbox),
				};
				const manifest = defineState("root", {
					count: { schema: Schema.Number },
					other: { schema: Schema.Number },
				});

				const state = yield* loadStateEffect(manifest).pipe(
					Effect.provideService(StateTransportService, transportStub),
					Effect.provideService(MessageChannelService, messageChannelStub),
				);

				const head = yield* state.count
					.subscribe()
					.pipe(Effect.flatMap(Stream.runHead), Effect.fork);
				yield* Effect.promise(() =>
					vi.waitFor(() => {
						expect(send).toHaveBeenCalledWith(subscribeFrame);
					}),
				);

				yield* mailbox.offer({
					_tag: "publish",
					topic: "state",
					message: { filter: { namespace: "root", name: "other" }, value: 99 },
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
					receive: () => Mailbox.toStream(mailbox),
				};
				const manifest = defineState("root", {
					count: { schema: Schema.Number },
				});

				const state = yield* loadStateEffect(manifest).pipe(
					Effect.provideService(StateTransportService, transportStub),
					Effect.provideService(MessageChannelService, messageChannelStub),
				);

				const fiber = yield* state.count.subscribe().pipe(Effect.fork);
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
					receive: () => Mailbox.toStream(mailbox),
				};
				const manifest = defineState("root", {
					count: { schema: Schema.Number },
				});

				const state = yield* loadStateEffect(manifest).pipe(
					Effect.provideService(StateTransportService, transportStub),
					Effect.provideService(MessageChannelService, messageChannelStub),
				);

				const scope = yield* Scope.make();
				const fiber = yield* state.count
					.subscribe()
					.pipe(Scope.extend(scope), Effect.fork);
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
					receive: () => Mailbox.toStream(mailbox),
				};
				const manifest = defineState("root", {
					count: { schema: Schema.Number },
				});

				const state = yield* loadStateEffect(manifest).pipe(
					Effect.provideService(StateTransportService, transportStub),
					Effect.provideService(MessageChannelService, messageChannelStub),
				);

				const scope1 = yield* Scope.make();
				const sub1 = yield* state.count
					.subscribe()
					.pipe(Scope.extend(scope1), Effect.fork);
				yield* Effect.promise(() =>
					vi.waitFor(() => {
						expect(send).toHaveBeenCalledWith(subscribeFrame);
					}),
				);
				yield* mailbox.offer(publishFrame(0));
				yield* Fiber.join(sub1);

				const scope2 = yield* Scope.make();
				const sub2 = yield* state.count
					.subscribe()
					.pipe(Scope.extend(scope2), Effect.fork);
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
});

describe("loadState (Promise wrapper)", () => {
	test("forwards to the injected transport", async () => {
		const transportStub = createTransportStub();
		transportStub.read.mockReturnValue(Effect.succeed(42));
		const manifest = defineState("root", { count: { schema: Schema.Number } });

		const messageChannelStub = createMessageChannelStub();
		const state = await loadState({
			manifest,
			stateTransport: () => transportStub,
			messageChannel: () => messageChannelStub,
		});

		expect(await state.count.get()).toBe(42);
		await state.count.set(9);
		expect(transportStub.update).toHaveBeenCalledWith("root", "count", 9);
	});
});
