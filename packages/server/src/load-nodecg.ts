import { HttpApiBuilder } from "@effect/platform";
import { NodeRuntime } from "@effect/platform-node";
import { Effect, HashMap, Layer } from "effect";

import {
	type AuthProvider,
	AuthProviderRegistry,
} from "./auth/auth-provider.ts";
import { AuthenticationMiddlewareLive } from "./auth/middleware.ts";
import { type LoadedNamespace } from "./load-namespace.ts";
import { frontendRoutes } from "./server/frontend-serving.ts";
import { buildNodecgApi } from "./server/http-api.ts";
import { makeNodeHttpServer } from "./server/node-http-server.ts";
import { websocketRoute } from "./server/websocket.ts";
import { InMemoryRoleStore } from "./services/role-store/in-memory-role-store.ts";
import { InMemorySessionStore } from "./services/session-store/in-memory-session-store.ts";
import { InMemoryStashStore } from "./services/stash-store/in-memory-stash-store.ts";

export type LoadNodecgOptions = {
	namespaces: ReadonlyArray<LoadedNamespace<{}, {}>>;
	authProviders?: ReadonlyArray<AuthProvider>;
	dev?: boolean;
	onReady?: () => void;
};

export const loadNodecgEffect = Effect.fn(function* (
	options: LoadNodecgOptions,
) {
	const ServerLive = HttpApiBuilder.serve().pipe(
		Layer.provide(websocketRoute(options)),
		Layer.provide(
			frontendRoutes({
				namespaces: options.namespaces,
				dev: options.dev ?? false,
			}),
		),
		Layer.provide(buildNodecgApi({ namespaces: options.namespaces })),
		Layer.provide(AuthenticationMiddlewareLive),
		Layer.provide(InMemorySessionStore),
		Layer.provide(InMemoryStashStore),
		Layer.provide(InMemoryRoleStore),
		Layer.provide(
			Layer.succeed(
				AuthProviderRegistry,
				// TODO: check duplicate names
				HashMap.fromIterable(
					(options.authProviders ?? []).map((provider) => [
						provider.name,
						provider,
					]),
				),
			),
		),
		Layer.provide(yield* makeNodeHttpServer({ onReady: options.onReady })),
	);

	return yield* Layer.launch(ServerLive);
});

export const loadNodecg = (options: LoadNodecgOptions) =>
	loadNodecgEffect(options).pipe(Effect.scoped, NodeRuntime.runMain);
