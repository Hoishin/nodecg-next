import { HttpApiBuilder, HttpServer } from "@effect/platform";
import { Layer } from "effect";

import { buildNodecgApi, type LoadedState } from "./server/http-api.ts";
import { nodeServer } from "./server/node-server.ts";
import { websocketRoute } from "./server/websocket.ts";

export const loadNodecg = (options: { states: ReadonlyArray<LoadedState> }) => {
	const ServerLive = HttpApiBuilder.serve().pipe(
		Layer.provide(websocketRoute),
		Layer.provide(buildNodecgApi(options)),
		HttpServer.withLogAddress,
		Layer.provide(nodeServer()),
	);

	return Layer.launch(ServerLive);
};
