import { Socket } from "@effect/platform";
import { ClientMessage, ServerMessage } from "@nodecg/internal";
import {
	Effect,
	Layer,
	Match,
	Predicate,
	PubSub,
	Schema,
	Scope,
	Stream,
} from "effect";

import {
	MessageChannelService,
	MessageEncodeError,
} from "./message-channel.ts";

const encodeClientMessage = Schema.encode(Schema.parseJson(ClientMessage));
const decodeServerMessage = Schema.decode(Schema.parseJson(ServerMessage));

export const SocketMessageChannel = Layer.scoped(
	MessageChannelService,
	Effect.gen(function* () {
		const socket = yield* Socket.Socket;
		const pubsub = yield* PubSub.unbounded<ServerMessage>();
		const scope = yield* Effect.scope;

		yield* Effect.forkScoped(
			socket
				.runRaw((data) =>
					Effect.gen(function* () {
						if (Predicate.isUint8Array(data)) {
							yield* Effect.logWarning("Received a message in Uint8Array");
							return;
						}
						const message = yield* decodeServerMessage(data);
						yield* pubsub.publish(message);
					}).pipe(
						Effect.catchTag("ParseError", (error) =>
							Effect.logError("Failed to decode incoming message:", error),
						),
					),
				)
				.pipe(
					Effect.ensuring(PubSub.shutdown(pubsub)),
					Effect.catchTag("SocketError", (error) =>
						Effect.logError("Message channel closed:", error),
					),
					Effect.ensureErrorType<never>(),
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

		return { send, receive: () => Stream.fromPubSub(pubsub, { scoped: true }) };
	}),
);
