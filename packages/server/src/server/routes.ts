import { Effect, Layer } from "effect";
import {
	FetchHttpClient,
	HttpMiddleware,
	HttpRouter,
} from "effect/unstable/http";

import {
	AdminTierMiddlewareLive,
	ServiceAccountAuthenticationMiddlewareLive,
	SuperadminMiddlewareLive,
	UserAuthenticationMiddlewareLive,
} from "../auth/middleware.ts";
import { ConfiguredSuperadmins } from "../configured-superadmins.ts";
import { basePathMiddleware } from "./base-path.ts";
import { frontendRoutes } from "./frontend-serving.ts";
import { RootApiLive } from "./http-api/build-root-api.ts";
import { UrlPath } from "./url-path.ts";
import { websocketRoute } from "./websocket.ts";

const services = Layer.mergeAll(
	UserAuthenticationMiddlewareLive,
	ServiceAccountAuthenticationMiddlewareLive,
	AdminTierMiddlewareLive,
	SuperadminMiddlewareLive,
).pipe(
	Layer.provideMerge(ConfiguredSuperadmins.layer),
	Layer.provideMerge(UrlPath.layer),
	Layer.provideMerge(FetchHttpClient.layer),
);

export const routes = Effect.gen(function* () {
	return Layer.mergeAll(
		RootApiLive,
		websocketRoute,
		frontendRoutes,
		HttpRouter.middleware(yield* basePathMiddleware, { global: true }),
		HttpRouter.middleware(HttpMiddleware.compression(), { global: true }),
	).pipe(HttpRouter.provideRequest(services), Layer.provide(services));
});
