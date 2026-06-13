import { HttpApiBuilder } from "@effect/platform";
import { NodeRuntime } from "@effect/platform-node";
import { Effect, Layer } from "effect";

import type { RegistryNamespace } from "./load-namespace.ts";
import { buildNodecgApi } from "./server/http-api.ts";
import { makeNodeHttpServer } from "./server/node-http-server.ts";
import { websocketRoute } from "./server/websocket.ts";

export type LoadNodecgOptions = {
	namespaces: ReadonlyArray<RegistryNamespace>;
	onReady?: () => void;
};

export const loadNodecgEffect = Effect.fn(function* (
	options: LoadNodecgOptions,
) {
	const ServerLive = HttpApiBuilder.serve().pipe(
		Layer.provide(websocketRoute(options)),
		Layer.provide(buildNodecgApi(options)),
		Layer.provide(yield* makeNodeHttpServer({ onReady: options.onReady })),
	);

	return yield* Layer.launch(ServerLive);
});

export const loadNodecg = (options: LoadNodecgOptions) =>
	loadNodecgEffect(options).pipe(Effect.scoped, NodeRuntime.runMain);
