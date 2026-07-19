import {
	HttpApp,
	HttpServerRequest,
	HttpServerResponse,
} from "@effect/platform";
import { testEffect } from "@nodecg/internal/test-utils";
import { ConfigProvider, Effect } from "effect";
import { describe, expect, test } from "vitest";

import { basePathMiddleware } from "./base-path.ts";

const echo: HttpApp.Default = Effect.map(
	HttpServerRequest.HttpServerRequest,
	(request) => HttpServerResponse.text(request.url),
);

const respond = (baseUrl: string, path: string) =>
	Effect.gen(function* () {
		const middleware = yield* basePathMiddleware;
		const handler = HttpApp.toWebHandler(middleware(echo));
		const response = yield* Effect.promise(() =>
			handler(new Request(`http://server${path}`)),
		);
		return {
			status: response.status,
			body: yield* Effect.promise(() => response.text()),
		};
	}).pipe(
		Effect.withConfigProvider(
			ConfigProvider.fromMap(new Map([["NODECG_BASE_URL", baseUrl]])),
		),
	);

describe("basePathMiddleware", () => {
	test(
		"serves under the sub-path with the prefix stripped",
		testEffect(
			Effect.gen(function* () {
				expect(yield* respond("http://host/foo", "/foo/ping")).toEqual({
					status: 200,
					body: "/ping",
				});
			}),
		),
	);

	test(
		"404s a request outside the sub-path",
		testEffect(
			Effect.gen(function* () {
				expect(yield* respond("http://host/foo", "/ping")).toEqual({
					status: 404,
					body: "",
				});
			}),
		),
	);

	test(
		"serves at the origin unchanged",
		testEffect(
			Effect.gen(function* () {
				expect(yield* respond("http://host", "/ping")).toEqual({
					status: 200,
					body: "/ping",
				});
			}),
		),
	);
});
