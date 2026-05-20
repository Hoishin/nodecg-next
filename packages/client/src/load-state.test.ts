import { defineState } from "@nodecg/core";
import type { ServerMessage } from "@nodecg/internal";
import { testEffect } from "@nodecg/private";
import { Deferred, Effect, Mailbox, Schema, Stream } from "effect";
import { describe, expect, test, vi } from "vitest";

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
		messages: Stream.never,
	}) satisfies MessageChannel;

describe("getValue", () => {
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
						.getValue()
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
					.getValue()
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
					.getValue()
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
						.getValue()
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
	test(
		"sends server subscribe and dispatches decoded matching publishes",
		testEffect(
			Effect.gen(function* () {
				const transportStub = createTransportStub();
				const mailbox = yield* Mailbox.make<ServerMessage>();
				const messageChannelStub: MessageChannel = {
					send: vi.fn<MessageChannel["send"]>(() => Effect.void),
					messages: Mailbox.toStream(mailbox),
				};
				const manifest = defineState("root", {
					count: { schema: Schema.Number },
				});

				const state = yield* loadStateEffect(manifest).pipe(
					Effect.provideService(StateTransportService, transportStub),
					Effect.provideService(MessageChannelService, messageChannelStub),
				);

				const received = yield* Deferred.make<number>();
				yield* state.count.subscribe((v) => {
					Effect.runSync(Deferred.succeed(received, v));
				});

				yield* mailbox.offer({
					_tag: "publish",
					topic: "state",
					message: { filter: { namespace: "root", name: "count" }, value: 42 },
				});

				expect(yield* Deferred.await(received)).toBe(42);
				expect(messageChannelStub.send).toHaveBeenCalledWith({
					_tag: "subscribe",
					topic: "state",
					message: { filter: { namespace: "root", name: "count" } },
				});
			}),
		),
	);

	test(
		"ignores publishes for a different name",
		testEffect(
			Effect.gen(function* () {
				const transportStub = createTransportStub();
				const mailbox = yield* Mailbox.make<ServerMessage>();
				const messageChannelStub: MessageChannel = {
					send: vi.fn<MessageChannel["send"]>(() => Effect.void),
					messages: Mailbox.toStream(mailbox),
				};
				const manifest = defineState("root", {
					count: { schema: Schema.Number },
					other: { schema: Schema.Number },
				});

				const state = yield* loadStateEffect(manifest).pipe(
					Effect.provideService(StateTransportService, transportStub),
					Effect.provideService(MessageChannelService, messageChannelStub),
				);

				const received = yield* Deferred.make<number>();
				yield* state.count.subscribe((v) => {
					Effect.runSync(Deferred.succeed(received, v));
				});

				yield* mailbox.offer({
					_tag: "publish",
					topic: "state",
					message: { filter: { namespace: "root", name: "other" }, value: 99 },
				});
				yield* mailbox.offer({
					_tag: "publish",
					topic: "state",
					message: { filter: { namespace: "root", name: "count" }, value: 7 },
				});

				expect(yield* Deferred.await(received)).toBe(7);
			}),
		),
	);

	test(
		"sends server unsubscribe when cancel is called",
		testEffect(
			Effect.gen(function* () {
				const transportStub = createTransportStub();
				const send = vi.fn<MessageChannel["send"]>(() => Effect.void);
				const messageChannelStub: MessageChannel = {
					send,
					messages: Stream.never,
				};
				const manifest = defineState("root", {
					count: { schema: Schema.Number },
				});

				const state = yield* loadStateEffect(manifest).pipe(
					Effect.provideService(StateTransportService, transportStub),
					Effect.provideService(MessageChannelService, messageChannelStub),
				);

				const cancel = yield* state.count.subscribe(() => {});
				yield* Effect.promise(() =>
					vi.waitFor(() => {
						expect(send).toHaveBeenCalledWith({
							_tag: "subscribe",
							topic: "state",
							message: { filter: { namespace: "root", name: "count" } },
						});
					}),
				);
				cancel();

				yield* Effect.promise(() =>
					vi.waitFor(() => {
						expect(send).toHaveBeenCalledWith({
							_tag: "unsubscribe",
							topic: "state",
							message: { filter: { namespace: "root", name: "count" } },
						});
					}),
				);
			}),
		),
	);

	test(
		"refcounts: unsubscribe fires only after the last cancel",
		testEffect(
			Effect.gen(function* () {
				const transportStub = createTransportStub();
				const send = vi.fn<MessageChannel["send"]>(() => Effect.void);
				const messageChannelStub: MessageChannel = {
					send,
					messages: Stream.never,
				};
				const manifest = defineState("root", {
					count: { schema: Schema.Number },
				});

				const state = yield* loadStateEffect(manifest).pipe(
					Effect.provideService(StateTransportService, transportStub),
					Effect.provideService(MessageChannelService, messageChannelStub),
				);

				const cancel1 = yield* state.count.subscribe(() => {});
				const cancel2 = yield* state.count.subscribe(() => {});

				cancel1();
				// Give the scheduler a chance, then confirm no unsubscribe yet.
				yield* Effect.promise(() =>
					vi.waitFor(() => {
						// any send call should not be unsubscribe
						const hasUnsubscribe = send.mock.calls.some(
							([msg]) => msg._tag === "unsubscribe",
						);
						expect(hasUnsubscribe).toBe(false);
					}),
				);

				cancel2();
				yield* Effect.promise(() =>
					vi.waitFor(() => {
						expect(send).toHaveBeenCalledWith({
							_tag: "unsubscribe",
							topic: "state",
							message: { filter: { namespace: "root", name: "count" } },
						});
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

		expect(await state.count.getValue()).toBe(42);
		await state.count.set(9);
		expect(transportStub.update).toHaveBeenCalledWith("root", "count", 9);
	});
});
