import { createServer } from "node:http";

import { HttpApiBuilder } from "@effect/platform";
import { NodeHttpServer } from "@effect/platform-node";
import { Layer } from "effect";

import { buildNodecgApi, type LoadedState } from "./server/http-api";
import { WebSocketRouteLive } from "./server/websocket";

export const loadNodecg = (options: { states: ReadonlyArray<LoadedState> }) => {
	const ServerLive = HttpApiBuilder.serve().pipe(
		Layer.provide(WebSocketRouteLive),
		Layer.provide(buildNodecgApi(options)),
		Layer.provide(NodeHttpServer.layer(() => createServer(), { port: 3000 })),
	);

	return Layer.launch(ServerLive);
};
