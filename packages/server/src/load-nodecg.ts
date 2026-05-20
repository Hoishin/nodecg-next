import { HttpApiBuilder } from "@effect/platform";
import { Layer } from "effect";

import type { LoadedState } from "./load-state.ts";
import { buildNodecgApi } from "./server/http-api.ts";
import { nodeServer } from "./server/node-server.ts";
import { websocketRoute } from "./server/websocket.ts";

export const loadNodecg = (options: { states: ReadonlyArray<LoadedState> }) => {
	const ServerLive = HttpApiBuilder.serve().pipe(
		Layer.provide(websocketRoute),
		Layer.provide(buildNodecgApi(options)),
		Layer.provide(nodeServer()),
	);

	return Layer.launch(ServerLive);
};
