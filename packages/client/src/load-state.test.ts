import {
	HttpClient,
	type HttpClientRequest,
	HttpClientResponse,
} from "@effect/platform";
import { defineState } from "@nodecg/core";
import { testEffect } from "@nodecg/private";
import { Effect, Layer, Schema } from "effect";
import { expect, test } from "vitest";

import { loadStateEffect } from "./load-state";

function mockHttpClient(
	handler: (request: HttpClientRequest.HttpClientRequest) => Response,
) {
	return Layer.succeed(
		HttpClient.HttpClient,
		HttpClient.make((request) =>
			Effect.succeed(HttpClientResponse.fromWeb(request, handler(request))),
		),
	);
}

function jsonBody(request: HttpClientRequest.HttpClientRequest): unknown {
	const body = request.body;
	if (body._tag === "Uint8Array") {
		return JSON.parse(new TextDecoder().decode(body.body));
	}
	return undefined;
}

test(
	"getValue fetches and decodes the response body",
	testEffect(
		Effect.gen(function* () {
			const manifest = defineState("root", {
				count: { schema: Schema.Number },
			});
			const state = yield* loadStateEffect(manifest);

			const value = yield* state.count.getValue();
			expect(value).toBe(42);
		}).pipe(
			Effect.provide(
				mockHttpClient((request) => {
					expect(request.url).toMatch("/api/namespaces/root/state/count");
					return new Response(JSON.stringify(42), { status: 200 });
				}),
			),
		),
	),
);

test(
	"update reads the current value, applies the fn, and PUTs the result",
	testEffect(
		Effect.gen(function* () {
			const manifest = defineState("root", {
				count: { schema: Schema.Number },
			});
			const state = yield* loadStateEffect(manifest);

			yield* state.count.update((v) => v + 5);
		}).pipe(
			Effect.provide(
				mockHttpClient((request) => {
					if (request.method === "PUT") {
						expect(jsonBody(request)).toBe(15);
						return new Response(null, { status: 204 });
					}
					return new Response(JSON.stringify(10), { status: 200 });
				}),
			),
		),
	),
);

test(
	"bidirectional codec round-trips through HTTP",
	testEffect(
		Effect.gen(function* () {
			const manifest = defineState("root", {
				when: { schema: Schema.DateFromString },
			});
			const state = yield* loadStateEffect(manifest);

			const initial = yield* state.when.getValue();
			expect(initial).toEqual(new Date("2026-05-14T00:00:00.000Z"));

			yield* state.when.set(new Date("2030-01-01T00:00:00.000Z"));
		}).pipe(
			Effect.provide(
				mockHttpClient((request) => {
					if (request.method === "PUT") {
						expect(jsonBody(request)).toBe("2030-01-01T00:00:00.000Z");
						return new Response(null, { status: 204 });
					}
					return new Response(JSON.stringify("2026-05-14T00:00:00.000Z"), {
						status: 200,
					});
				}),
			),
		),
	),
);
