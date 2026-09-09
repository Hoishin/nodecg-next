import { it } from "@effect/vitest";
import {
	ReplicantSnapshotMessage,
	SubscribeMessage,
} from "@nodecg-next/internal";
import { Cause, Effect, Layer, Option, Queue, Stream } from "effect";
import { Socket } from "effect/unstable/socket";
import { assert, describe, expect, vi } from "vitest";

import { MessageChannelService } from "./message-channel.ts";
import { SocketMessageChannel } from "./socket-message-channel.ts";

const makeFakeSocket = Effect.gen(function* () {
	const incoming = yield* Queue.make<
		string | Uint8Array,
		Socket.SocketError | Cause.Done
	>();
	const write = vi.fn<
		(
			chunk: string | Uint8Array | Socket.CloseEvent,
		) => Effect.Effect<void, Socket.SocketError>
	>(() => Effect.void);

	const socket: Socket.Socket = {
		[Socket.TypeId]: Socket.TypeId,
		run: vi.fn(() => Effect.die("FakeSocket.run is not used")),
		runString: vi.fn(() => Effect.die("FakeSocket.runString is not used")),
		runRaw<_, E, R>(
			handler: (data: string | Uint8Array) => Effect.Effect<_, E, R> | void,
		): Effect.Effect<void, Socket.SocketError | E, R> {
			return Stream.runForEach(Stream.fromQueue(incoming), (data) => {
				const result = handler(data);
				return Effect.isEffect(result) ? result : Effect.void;
			});
		},
		writer: Effect.succeed(write),
	};

	return {
		socket,
		write,
		deliver: (data: string | Uint8Array) => Queue.offer(incoming, data),
		closeClean: Queue.end(incoming),
		closeWithError: (error: Socket.SocketError) => Queue.fail(incoming, error),
	};
});

const layerFor = (socket: Socket.Socket) =>
	SocketMessageChannel.pipe(
		Layer.provide(Layer.succeed(Socket.Socket, socket)),
	);

describe("send", () => {
	it.effect("encodes ClientMessage and writes JSON to the socket", () =>
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
	);
});

describe("receive", () => {
	it.effect(
		"decodes incoming JSON frames into ServerMessage stream values",
		() =>
			Effect.gen(function* () {
				const { socket, deliver } = yield* makeFakeSocket;

				yield* Effect.gen(function* () {
					const channel = yield* MessageChannelService;
					const stream = yield* channel.receive();
					yield* deliver(
						JSON.stringify(
							ReplicantSnapshotMessage.make({
								field: { type: "replicant", namespace: "root", name: "count" },
								value: 42,
								revision: 1,
							}),
						),
					);

					const first = yield* Stream.runHead(stream);
					assert(Option.isSome(first));
					expect(first.value).toEqual({
						_tag: "snapshot",
						field: { type: "replicant", namespace: "root", name: "count" },
						value: 42,
						revision: 1,
					});
				}).pipe(Effect.provide(layerFor(socket)));
			}),
	);

	it.effect("completes the stream on clean socket close", () =>
		Effect.gen(function* () {
			const { socket, closeClean } = yield* makeFakeSocket;

			yield* Effect.gen(function* () {
				const channel = yield* MessageChannelService;
				const stream = yield* channel.receive();
				yield* closeClean;
				const all = yield* Stream.runCollect(stream).pipe(
					Effect.timeout("1 second"),
				);
				expect(all).toEqual([]);
			}).pipe(Effect.provide(layerFor(socket)));
		}),
	);

	it.effect("ends the stream on socket error", () =>
		Effect.gen(function* () {
			const { socket, closeWithError } = yield* makeFakeSocket;

			yield* Effect.gen(function* () {
				const channel = yield* MessageChannelService;
				const stream = yield* channel.receive();
				yield* closeWithError(
					new Socket.SocketError({
						reason: new Socket.SocketReadError({
							cause: new Error("simulated"),
						}),
					}),
				);
				const all = yield* Stream.runCollect(stream).pipe(
					Effect.timeout("1 second"),
				);
				expect(all).toEqual([]);
			}).pipe(Effect.provide(layerFor(socket)));
		}),
	);

	it.effect("drops malformed JSON frames without failing the stream", () =>
		Effect.gen(function* () {
			const { socket, deliver } = yield* makeFakeSocket;

			yield* Effect.gen(function* () {
				const channel = yield* MessageChannelService;
				const stream = yield* channel.receive();
				yield* deliver("not valid json");
				yield* deliver(
					JSON.stringify(
						ReplicantSnapshotMessage.make({
							field: { type: "replicant", namespace: "root", name: "count" },
							value: 7,
							revision: 1,
						}),
					),
				);

				const first = yield* Stream.runHead(stream);
				assert(Option.isSome(first));
				expect(first.value).toMatchObject({
					_tag: "snapshot",
					value: 7,
				});
			}).pipe(Effect.provide(layerFor(socket)));
		}),
	);

	it.effect("drops binary frames", () =>
		Effect.gen(function* () {
			const { socket, deliver } = yield* makeFakeSocket;

			yield* Effect.gen(function* () {
				const channel = yield* MessageChannelService;
				const stream = yield* channel.receive();
				yield* deliver(new Uint8Array([1, 2, 3]));
				yield* deliver(
					JSON.stringify(
						ReplicantSnapshotMessage.make({
							field: { type: "replicant", namespace: "root", name: "ok" },
							value: 1,
							revision: 1,
						}),
					),
				);

				const first = yield* Stream.runHead(stream);
				assert(Option.isSome(first));
			}).pipe(Effect.provide(layerFor(socket)));
		}),
	);
});
