import { it } from "@effect/vitest";
import {
	ReplicantSnapshotMessage,
	SubscribeMessage,
} from "@nodecg-next/internal";
import { Effect, Layer, Option, Queue, Stream } from "effect";
import { TestConsole } from "effect/testing";
import { Socket } from "effect/unstable/socket";
import { assert, describe, expect, vi } from "vitest";

import { MessageChannelService } from "./message-channel.ts";
import { SocketMessageChannel } from "./socket-message-channel.ts";

const makeFakeSocket = Effect.gen(function* () {
	const incoming = yield* Queue.make<string | Uint8Array, Socket.SocketError>();
	const write = vi.fn<
		(
			chunk: string | Uint8Array | Socket.CloseEvent,
		) => Effect.Effect<void, Socket.SocketError>
	>(() => Effect.void);

	const socket = Socket.make({
		reader: Effect.succeed({
			pull: Queue.takeAll(incoming),
			upgrade: vi.fn(() => Effect.die("FakeSocket.upgrade is not used")),
		}),
		writer: Effect.succeed({
			write,
			writeAll: vi.fn(() => Effect.die("FakeSocket.writeAll is not used")),
		}),
	});

	return {
		socket,
		write,
		deliver: (data: string | Uint8Array) => Queue.offer(incoming, data),
		closeClean: Queue.fail(
			incoming,
			new Socket.SocketError({
				reason: new Socket.SocketCloseError({ code: 1000 }),
			}),
		),
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

	it.effect("completes the stream without logging on clean socket close", () =>
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
				expect(yield* TestConsole.logLines).toEqual([]);
			}).pipe(Effect.provide(layerFor(socket)));
		}),
	);

	it.effect("ends the stream and logs the error on socket error", () =>
		Effect.gen(function* () {
			const { socket, closeWithError } = yield* makeFakeSocket;
			const error = new Socket.SocketError({
				reason: new Socket.SocketReadError({ cause: new Error("simulated") }),
			});

			yield* Effect.gen(function* () {
				const channel = yield* MessageChannelService;
				const stream = yield* channel.receive();
				yield* closeWithError(error);
				const all = yield* Stream.runCollect(stream).pipe(
					Effect.timeout("1 second"),
				);
				expect(all).toEqual([]);
				expect(yield* TestConsole.logLines).toEqual([
					expect.stringMatching(/ ERROR \(#\d+\):$/),
					"Message channel closed:",
					error,
				]);
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
