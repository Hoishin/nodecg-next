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

		yield* Effect.forkScoped(
			socket
				.runRaw((data) =>
					Effect.gen(function* () {
						if (Predicate.isUint8Array(data)) {
							yield* Effect.logWarning("Received a message in Uint8Array");
							return;
						}
						const message = yield* decodeServerMessage(data);
						yield* PubSub.publish(pubsub, message);
					}).pipe(
						Effect.catchTag("SchemaError", (error) =>
							Effect.logError("Failed to decode incoming message:", error),
						),
					),
				)
				.pipe(
					Effect.ensuring(PubSub.shutdown(pubsub)),
					Effect.catchTag("SocketError", (error) =>
						Effect.logError("Message channel closed:", error),
					),
					Effect.satisfiesErrorType<never>(),
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
