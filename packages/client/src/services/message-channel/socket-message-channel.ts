import { Socket } from "@effect/platform";
import { ClientMessage, ServerMessage } from "@nodecg/internal";
import {
	Cause,
	Effect,
	Exit,
	Layer,
	Mailbox,
	Match,
	Predicate,
	Schema,
	Scope,
} from "effect";

import {
	MessageChannelFailError,
	MessageChannelService,
	MessageEncodeError,
} from "./message-channel.ts";

const encodeClientMessage = Schema.encode(Schema.parseJson(ClientMessage));
const decodeServerMessage = Schema.decode(Schema.parseJson(ServerMessage));

export const SocketMessageChannel = Layer.scoped(
	MessageChannelService,
	Effect.gen(function* () {
		const socket = yield* Socket.Socket;
		const mailbox = yield* Mailbox.make<
			ServerMessage,
			MessageChannelFailError
		>();
		const scope = yield* Effect.scope;

		// Register incoming messages
		yield* Effect.forkScoped(
			socket
				.runRaw((data) =>
					Effect.gen(function* () {
						if (Predicate.isUint8Array(data)) {
							yield* Effect.logWarning("Received a message in Uint8Array");
							return;
						}
						const message = yield* decodeServerMessage(data);
						const sent = yield* mailbox.offer(message);
						if (!sent) {
							yield* Effect.logWarning(
								"Received a message, but mailbox is already closed",
								message,
							);
						}
					}).pipe(
						Effect.catchTag("ParseError", (error) =>
							Effect.logError("Failed to decode incoming message:", error),
						),
					),
				)
				.pipe(
					Effect.catchTag("SocketError", (error) =>
						mailbox.fail(new MessageChannelFailError({ cause: error })),
					),
					Effect.ensureErrorType<never>(),
					Effect.onExit((exit) =>
						Exit.matchEffect(exit, {
							onSuccess: () => mailbox.end,
							onFailure: (cause) =>
								Effect.gen(function* () {
									if (Cause.isInterruptedOnly(cause)) {
										yield* mailbox.end;
									} else {
										yield* mailbox.fail(
											new MessageChannelFailError({
												cause: new Error("Socket failed for unknown error", {
													cause,
												}),
											}),
										);
									}
								}),
						}),
					),
				),
		);

		const send = Effect.fn("WebsocketMessageChannel.send")(function* (
			message: ClientMessage,
		) {
			const write = yield* socket.writer;
			const data = yield* encodeClientMessage(message).pipe(
				Effect.mapError((error) =>
					Match.value(error).pipe(
						Match.tag(
							"ParseError",
							(error) => new MessageEncodeError({ cause: error }),
						),
						Match.exhaustive,
					),
				),
			);
			yield* write(data).pipe(
				Effect.ensureErrorType<Socket.SocketError>(),
				Effect.orDie,
			);
		}, Scope.extend(scope));

		return { send, messages: Mailbox.toStream(mailbox) };
	}),
);
