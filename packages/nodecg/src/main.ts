import { createServer } from "node:http";

import {
	HttpRouter,
	HttpServer,
	HttpServerRequest,
	HttpServerResponse,
} from "@effect/platform";
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import { Effect, Layer, Match, Schema } from "effect";

const ClientMessage = Schema.Union(
	Schema.TaggedStruct("subscribe", { topic: Schema.String }),
	Schema.TaggedStruct("publish", {
		topic: Schema.String,
		value: Schema.Unknown,
	}),
	Schema.TaggedStruct("ping", {}),
);
type ClientMessage = typeof ClientMessage.Type;

const decodeClientMessage = Schema.decode(Schema.parseJson(ClientMessage));

const handleMessage = (msg: ClientMessage) =>
	Match.value(msg).pipe(
		Match.tag("subscribe", ({ topic }) => Effect.log(`sub: ${topic}`)),
		Match.tag("publish", ({ topic }) => Effect.log(`pub: ${topic}`)),
		Match.tag("ping", () => Effect.log("ping")),
		Match.exhaustive,
	);

const wsHandler = Effect.gen(function* () {
	const socket = yield* HttpServerRequest.upgrade;
	yield* socket.runRaw((data) =>
		typeof data === "string"
			? decodeClientMessage(data).pipe(Effect.flatMap(handleMessage))
			: Effect.void,
	);
	return HttpServerResponse.empty();
});

const router = HttpRouter.empty.pipe(
	HttpRouter.get("/", HttpServerResponse.text("OK")),
	HttpRouter.get("/ws", wsHandler),
);

HttpServer.serve(router).pipe(
	Layer.provide(NodeHttpServer.layer(() => createServer(), { port: 3000 })),
	Layer.launch,
	NodeRuntime.runMain,
);
