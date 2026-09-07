import { Effect } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { config } from "../server-config.ts";

type HttpHandler<E> = Effect.Effect<
	HttpServerResponse.HttpServerResponse,
	E,
	HttpServerRequest.HttpServerRequest
>;

// TODO: use prefixed and prefixRoute when possible
export const basePathMiddleware = Effect.gen(function* () {
	const { pathname } = yield* config.baseUrl;
	const prefix = pathname.replace(/\/+$/, "");
	if (prefix === "") {
		return <E>(httpEffect: HttpHandler<E>) => httpEffect;
	}
	return <E>(httpEffect: HttpHandler<E>) =>
		Effect.gen(function* () {
			const request = yield* HttpServerRequest.HttpServerRequest;
			if (request.url !== prefix && !request.url.startsWith(`${prefix}/`)) {
				return HttpServerResponse.empty({ status: 404 });
			}
			return yield* Effect.provideService(
				httpEffect,
				HttpServerRequest.HttpServerRequest,
				request.modify({ url: request.url.slice(prefix.length) || "/" }),
			);
		});
});
