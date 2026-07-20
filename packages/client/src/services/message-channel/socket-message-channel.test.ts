import { Socket } from "@effect/platform";
import { PublishMessage, SubscribeMessage } from "@nodecg/internal";
import { testEffect } from "@nodecg/internal/test-utils";
import { Effect, Layer, Mailbox, Option, Stream } from "effect";
import { assert, describe, expect, test, vi } from "vitest";

import { MessageChannelService } from "./message-channel.ts";
import { SocketMessageChannel } from "./socket-message-channel.ts";

const makeFakeSocket = Effect.gen(function* () {
	const incoming = yield* Mailbox.make<
		string | Uint8Array,
		Socket.SocketError
	>();
	const write = vi.fn<
		(
			chunk: string | Uint8Array | Socket.CloseEvent,
		) => Effect.Effect<void, Socket.SocketError>
	>(() => Effect.void);

	const socket: Socket.Socket = {
		[Socket.TypeId]: Socket.TypeId,
		run: vi.fn(() => Effect.die("FakeSocket.run is not used")),
		runRaw<_, E, R>(
			handler: (data: string | Uint8Array) => Effect.Effect<_, E, R> | void,
		): Effect.Effect<void, Socket.SocketError | E, R> {
			return Stream.runForEach(Mailbox.toStream(incoming), (data) => {
				const result = handler(data);
				return Effect.isEffect(result) ? result : Effect.void;
			});
		},
		writer: Effect.succeed(write),
	};

	return {
		socket,
		write,
		deliver: (data: string | Uint8Array) => incoming.offer(data),
		closeClean: incoming.end,
		closeWithError: (error: Socket.SocketError) => incoming.fail(error),
	};
});

const layerFor = (socket: Socket.Socket) =>
	SocketMessageChannel.pipe(
		Layer.provide(Layer.succeed(Socket.Socket, socket)),
	);

describe("send", () => {
	test(
		"encodes ClientMessage and writes JSON to the socket",
		testEffect(
			Effect.gen(function* () {
				const { socket, write } = yield* makeFakeSocket;

				yield* Effect.gen(function* () {
					const channel = yield* MessageChannelService;
					yield* channel.send(
						SubscribeMessage.make({
							field: { type: "replicant", namespace: "root", name: "count" },
						}),
					);
				}).pipe(Effect.provide(layerFor(socket)));

				expect(write).toHaveBeenCalledTimes(1);
				expect(JSON.parse(String(write.mock.calls[0]?.[0]))).toEqual({
					_tag: "subscribe",
					field: { type: "replicant", namespace: "root", name: "count" },
				});
			}),
		),
	);
});

describe("receive", () => {
	test(
		"decodes incoming JSON frames into ServerMessage stream values",
		testEffect(
			Effect.gen(function* () {
				const { socket, deliver } = yield* makeFakeSocket;

				yield* Effect.gen(function* () {
					const channel = yield* MessageChannelService;
					const stream = yield* channel.receive();
					yield* deliver(
						JSON.stringify(
							PublishMessage.make({
								field: { type: "replicant", namespace: "root", name: "count" },
								value: 42,
							}),
						),
					);

					const first = yield* Stream.runHead(stream);
					assert(Option.isSome(first));
					expect(first.value).toEqual({
						_tag: "publish",
						field: { type: "replicant", namespace: "root", name: "count" },
						value: 42,
					});
				}).pipe(Effect.provide(layerFor(socket)));
			}),
		),
	);

	test(
		"completes the stream on clean socket close",
		testEffect(
			Effect.gen(function* () {
				const { socket, closeClean } = yield* makeFakeSocket;

				yield* Effect.gen(function* () {
					const channel = yield* MessageChannelService;
					const stream = yield* channel.receive();
					yield* closeClean;
					const all = yield* Stream.runCollect(stream).pipe(
						Effect.timeoutFail({
							duration: "1 second",
							onTimeout: () => "Stream did not finish",
						}),
					);
					expect(Array.from(all)).toEqual([]);
				}).pipe(Effect.provide(layerFor(socket)));
			}),
		),
	);

	test(
		"ends the stream on socket error",
		testEffect(
			Effect.gen(function* () {
				const { socket, closeWithError } = yield* makeFakeSocket;

				yield* Effect.gen(function* () {
					const channel = yield* MessageChannelService;
					const stream = yield* channel.receive();
					yield* closeWithError(
						new Socket.SocketGenericError({
							reason: "Read",
							cause: new Error("simulated"),
						}),
					);
					const all = yield* Stream.runCollect(stream).pipe(
						Effect.timeoutFail({
							duration: "1 second",
							onTimeout: () => "Stream did not finish",
						}),
					);
					expect(Array.from(all)).toEqual([]);
				}).pipe(Effect.provide(layerFor(socket)));
			}),
		),
	);

	test(
		"drops malformed JSON frames without failing the stream",
		testEffect(
			Effect.gen(function* () {
				const { socket, deliver } = yield* makeFakeSocket;

				yield* Effect.gen(function* () {
					const channel = yield* MessageChannelService;
					const stream = yield* channel.receive();
					yield* deliver("not valid json");
					yield* deliver(
						JSON.stringify(
							PublishMessage.make({
								field: { type: "replicant", namespace: "root", name: "count" },
								value: 7,
							}),
						),
					);

					const first = yield* Stream.runHead(stream);
					assert(Option.isSome(first));
					expect(first.value).toMatchObject({
						_tag: "publish",
						value: 7,
					});
				}).pipe(Effect.provide(layerFor(socket)));
			}),
		),
	);

	test(
		"drops binary frames",
		testEffect(
			Effect.gen(function* () {
				const { socket, deliver } = yield* makeFakeSocket;

				yield* Effect.gen(function* () {
					const channel = yield* MessageChannelService;
					const stream = yield* channel.receive();
					yield* deliver(new Uint8Array([1, 2, 3]));
					yield* deliver(
						JSON.stringify(
							PublishMessage.make({
								field: { type: "replicant", namespace: "root", name: "ok" },
								value: 1,
							}),
						),
					);

					const first = yield* Stream.runHead(stream);
					assert(Option.isSome(first));
				}).pipe(Effect.provide(layerFor(socket)));
			}),
		),
	);
});
