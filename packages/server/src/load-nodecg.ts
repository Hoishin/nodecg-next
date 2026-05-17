import { HttpApiBuilder } from "@effect/platform";
import { Layer } from "effect";

import { buildNodecgApi, type LoadedState } from "./server/http-api";
import { nodeServer } from "./server/node-server";
import { websocketRoute } from "./server/websocket";

export const loadNodecg = (options: { states: ReadonlyArray<LoadedState> }) => {
	const ServerLive = HttpApiBuilder.serve().pipe(
		Layer.provide(websocketRoute),
		Layer.provide(buildNodecgApi(options)),
		Layer.provide(nodeServer()),
	);

	return Layer.launch(ServerLive);
};
