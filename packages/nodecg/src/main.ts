import { createServer } from "node:http";

import {
	HttpApiBuilder,
	HttpApiError,
	HttpApp,
	HttpServerRequest,
	HttpServerResponse,
} from "@effect/platform";
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import { ClientMessage, NodecgApi } from "@nodecg/internal";
import { Effect, Layer, Match, Schema } from "effect";

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

const RootGroupLive = HttpApiBuilder.group(NodecgApi, "Root", (handlers) =>
	handlers.handle("root", () =>
		Effect.fail(new HttpApiError.NotImplemented()),
	),
);

const ApiGroupLive = HttpApiBuilder.group(NodecgApi, "Api", (handlers) =>
	handlers.handle("ping", () => Effect.succeed("pong")),
);

const NodecgApiLive = HttpApiBuilder.api(NodecgApi).pipe(
	Layer.provide(RootGroupLive),
	Layer.provide(ApiGroupLive),
);

const wsMiddleware = (apiApp: HttpApp.Default) =>
	Effect.gen(function* () {
		const req = yield* HttpServerRequest.HttpServerRequest;
		if (new URL(req.url, "http://x").pathname === "/ws") {
			return yield* wsHandler.pipe(
				Effect.catchAll(() =>
					Effect.succeed(HttpServerResponse.empty({ status: 500 })),
				),
			);
		}
		return yield* apiApp;
	});

const ServerLive = HttpApiBuilder.serve(wsMiddleware).pipe(
	Layer.provide(NodecgApiLive),
	Layer.provide(NodeHttpServer.layer(() => createServer(), { port: 3000 })),
);

Layer.launch(ServerLive).pipe(NodeRuntime.runMain);
