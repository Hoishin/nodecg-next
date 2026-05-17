import {
	HttpApiBuilder,
	HttpServerRequest,
	HttpServerResponse,
} from "@effect/platform";
import { ClientMessage, ServerMessage } from "@nodecg/internal";
import { Effect, Match, Schema } from "effect";

const decodeClientMessage = Schema.decode(Schema.parseJson(ClientMessage));
const encodeServerMessage = Schema.encode(Schema.parseJson(ServerMessage));

const handleMessage = (
	msg: ClientMessage,
	send: (msg: ServerMessage) => Effect.Effect<void, unknown>,
) =>
	Match.value(msg).pipe(
		Match.tag("subscribe", ({ topic }) => Effect.log(`sub: ${topic}`)),
		Match.tag("ping", () => send({ _tag: "pong" })),
		Match.exhaustive,
	);

const wsHandler = Effect.gen(function* () {
	const socket = yield* HttpServerRequest.upgrade;
	const write = yield* socket.writer;
	const send = (msg: ServerMessage) =>
		encodeServerMessage(msg).pipe(Effect.flatMap(write));
	yield* socket.runRaw((data) =>
		typeof data === "string"
			? decodeClientMessage(data).pipe(
					Effect.flatMap((msg) => handleMessage(msg, send)),
				)
			: Effect.void,
	);
	return HttpServerResponse.empty();
});

export const WebSocketRouteLive = HttpApiBuilder.Router.use((router) =>
	router.get(
		"/ws",
		wsHandler.pipe(
			Effect.catchAll(() =>
				Effect.succeed(HttpServerResponse.empty({ status: 500 })),
			),
		),
	),
);
