import { type HttpApp, HttpRouter, HttpServerResponse } from "@effect/platform";
import { Effect } from "effect";

import { config } from "../server-config.ts";

export const basePathMiddleware = Effect.gen(function* () {
	const { pathname } = yield* config.baseUrl;
	return (httpApp: HttpApp.Default): HttpApp.Default =>
		HttpRouter.empty.pipe(
			HttpRouter.mountApp(pathname, httpApp),
			Effect.catchTag("RouteNotFound", () =>
				HttpServerResponse.empty({ status: 404 }),
			),
		);
});
