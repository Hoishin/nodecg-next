import { HttpApiBuilder } from "@effect/platform";
import { NodeRuntime } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import type { Simplify } from "type-fest";

import type { LoadedState } from "./load-state.ts";
import { buildNodecgApi } from "./server/http-api.ts";
import { makeNodeHttpServer } from "./server/node-http-server.ts";
import { websocketRoute } from "./server/websocket.ts";

export type LoadNodecgOptions = {
	states: ReadonlyArray<LoadedState>;
};

export const loadNodecgEffect = Effect.fn(function* (
	options: LoadNodecgOptions,
) {
	const ServerLive = HttpApiBuilder.serve().pipe(
		Layer.provide(websocketRoute(options)),
		Layer.provide(buildNodecgApi(options)),
		Layer.provide(makeNodeHttpServer()),
	);

	yield* Layer.build(ServerLive);
});

export const loadNodecg = (
	options: Simplify<
		LoadNodecgOptions & {
			onReady?: () => void;
		}
	>,
) =>
	Effect.gen(function* () {
		yield* loadNodecgEffect(options);
		options.onReady?.();
		yield* Effect.never;
	}).pipe(Effect.scoped, NodeRuntime.runMain);
