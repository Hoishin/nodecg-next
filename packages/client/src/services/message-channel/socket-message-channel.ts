import { ClientMessage, ServerMessage } from "@nodecg-next/internal";
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
import { Socket } from "effect/unstable/socket";

import {
	MessageChannelService,
	MessageEncodeError,
} from "./message-channel.ts";

const encodeClientMessage = Schema.encodeEffect(
	Schema.fromJsonString(ClientMessage),
);
const decodeServerMessage = Schema.decodeEffect(
	Schema.fromJsonString(ServerMessage),
);

export const SocketMessageChannel = Layer.effect(
	MessageChannelService,
	Effect.gen(function* () {
		const socket = yield* Socket.Socket;
		const pubsub = yield* PubSub.unbounded<ServerMessage>();
		const scope = yield* Effect.scope;

		const handleData = Effect.fn(
			function* (data: string | Uint8Array) {
				if (Predicate.isUint8Array(data)) {
					yield* Effect.logWarning("Received a message in Uint8Array");
					return;
				}
				const message = yield* decodeServerMessage(data);
				yield* PubSub.publish(pubsub, message);
			},
			Effect.catchTag("SchemaError", (error) =>
				Effect.logError("Failed to decode incoming message:", error),
			),
		);

		yield* Effect.forkScoped(
			Effect.gen(function* () {
				const { pull } = yield* socket.reader;
				return yield* pull.pipe(
					Effect.flatMap(
						Effect.forEach((data) => handleData(data), { discard: true }),
					),
					Effect.forever,
				);
			}).pipe(
				Effect.scoped,
				Effect.catchReason(
					"SocketError",
					"SocketCloseError",
					({ code }, error) =>
						code === 1000 || code === 1005
							? Effect.void
							: Effect.logError("Message channel closed:", error),
					(_, error) => Effect.logError("Message channel closed:", error),
				),
				Effect.ensuring(PubSub.shutdown(pubsub)),
				Effect.satisfiesErrorType<never>(),
			),
		);

		const send = Effect.fn("WebsocketMessageChannel.send")(function* (
			message: ClientMessage,
		) {
			const { write } = yield* socket.writer;
			const data = yield* encodeClientMessage(message).pipe(
				Effect.mapError((error) =>
					Match.value(error).pipe(
						Match.tag(
							"SchemaError",
							(error) => new MessageEncodeError({ cause: error }),
						),
						Match.exhaustive,
					),
				),
			);
			yield* write(data).pipe(
				Effect.satisfiesErrorType<Socket.SocketError>(),
				Effect.orDie,
			);
		}, Scope.provide(scope));

		const receive = Effect.fn("WebsocketMessageChannel.receive")(function* () {
			const subscription = yield* PubSub.subscribe(pubsub);
			return Stream.fromSubscription(subscription);
		});

		return { send, receive };
	}),
);
