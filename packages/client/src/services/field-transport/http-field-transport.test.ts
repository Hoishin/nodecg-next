import { FetchHttpClient } from "@effect/platform";
import { testEffect } from "@nodecg/internal/test-utils";
import { Effect } from "effect";
import { describe, expect, test, vi } from "vitest";

import { FieldTransportService } from "../field-transport/field-transport.ts";
import { HttpFieldTransport } from "../field-transport/http-field-transport.ts";

const mockFetch = (respond: () => Response) =>
	vi.fn<typeof globalThis.fetch>(async () => respond());

const requestOf = (fetch: ReturnType<typeof mockFetch>) => {
	const call = fetch.mock.calls[0];
	if (typeof call === "undefined") {
		throw new Error("fetch was not called");
	}
	return new Request(...call);
};

describe("get", () => {
	test(
		"issues a GET to the state URL and returns the decoded body",
		testEffect(
			Effect.gen(function* () {
				const transport = yield* FieldTransportService;
				const fetch = mockFetch(() => new Response(JSON.stringify(42)));

				const value = yield* transport
					.readState("root", "count")
					.pipe(Effect.provideService(FetchHttpClient.Fetch, fetch));

				expect(value).toBe(42);
				const request = requestOf(fetch);
				expect(request.method).toBe("GET");
				expect(request.url).toContain("/api/namespaces/root/state/count");
			}).pipe(Effect.provide(HttpFieldTransport)),
		),
	);

	test(
		"fails with FieldNotFound when the server responds 404",
		testEffect(
			Effect.gen(function* () {
				const transport = yield* FieldTransportService;

				const error = yield* transport.readState("root", "count").pipe(
					Effect.provideService(
						FetchHttpClient.Fetch,
						mockFetch(() => new Response(null, { status: 404 })),
					),
					Effect.flip,
				);

				expect(error._tag).toBe("FieldNotFound");
			}).pipe(Effect.provide(HttpFieldTransport)),
		),
	);

	test(
		"fails with FieldPermissionDenied when the server responds 403",
		testEffect(
			Effect.gen(function* () {
				const transport = yield* FieldTransportService;

				const error = yield* transport.readState("root", "count").pipe(
					Effect.provideService(
						FetchHttpClient.Fetch,
						mockFetch(() => new Response(null, { status: 403 })),
					),
					Effect.flip,
				);

				expect(error._tag).toBe("FieldPermissionDenied");
			}).pipe(Effect.provide(HttpFieldTransport)),
		),
	);
});

describe("update", () => {
	test(
		"issues a PUT with the JSON-encoded body",
		testEffect(
			Effect.gen(function* () {
				const transport = yield* FieldTransportService;
				const fetch = mockFetch(() => new Response(null, { status: 204 }));

				yield* transport
					.updateState("root", "count", 7)
					.pipe(Effect.provideService(FetchHttpClient.Fetch, fetch));

				const request = requestOf(fetch);
				expect(request.method).toBe("PUT");
				expect(request.url).toContain("/api/namespaces/root/state/count");
				const body = yield* Effect.promise(() => request.text());
				expect(JSON.parse(body)).toBe(7);
			}).pipe(Effect.provide(HttpFieldTransport)),
		),
	);

	test(
		"fails with FieldPermissionDenied when the server responds 403",
		testEffect(
			Effect.gen(function* () {
				const transport = yield* FieldTransportService;

				const error = yield* transport.updateState("root", "count", 7).pipe(
					Effect.provideService(
						FetchHttpClient.Fetch,
						mockFetch(() => new Response(null, { status: 403 })),
					),
					Effect.flip,
				);

				expect(error._tag).toBe("FieldPermissionDenied");
			}).pipe(Effect.provide(HttpFieldTransport)),
		),
	);
});

describe("publishTopic", () => {
	test(
		"issues a POST to the topic URL with the JSON-encoded body",
		testEffect(
			Effect.gen(function* () {
				const transport = yield* FieldTransportService;
				const fetch = mockFetch(() => new Response(null, { status: 204 }));

				yield* transport
					.publishTopic("root", "chat", 7)
					.pipe(Effect.provideService(FetchHttpClient.Fetch, fetch));

				const request = requestOf(fetch);
				expect(request.method).toBe("POST");
				expect(request.url).toContain("/api/namespaces/root/topic/chat");
				const body = yield* Effect.promise(() => request.text());
				expect(JSON.parse(body)).toBe(7);
			}).pipe(Effect.provide(HttpFieldTransport)),
		),
	);

	test(
		"fails with FieldPermissionDenied when the server responds 403",
		testEffect(
			Effect.gen(function* () {
				const transport = yield* FieldTransportService;

				const error = yield* transport.publishTopic("root", "chat", 7).pipe(
					Effect.provideService(
						FetchHttpClient.Fetch,
						mockFetch(() => new Response(null, { status: 403 })),
					),
					Effect.flip,
				);

				expect(error._tag).toBe("FieldPermissionDenied");
			}).pipe(Effect.provide(HttpFieldTransport)),
		),
	);
});

describe("callRpc", () => {
	test(
		"issues a POST to the rpc URL and returns the decoded response",
		testEffect(
			Effect.gen(function* () {
				const transport = yield* FieldTransportService;
				const fetch = mockFetch(() => new Response(JSON.stringify(84)));

				const response = yield* transport
					.callRpc("root", "echo", 42)
					.pipe(Effect.provideService(FetchHttpClient.Fetch, fetch));

				expect(response).toBe(84);
				const request = requestOf(fetch);
				expect(request.method).toBe("POST");
				expect(request.url).toContain("/api/namespaces/root/rpc/echo");
				const body = yield* Effect.promise(() => request.text());
				expect(JSON.parse(body)).toBe(42);
			}).pipe(Effect.provide(HttpFieldTransport)),
		),
	);

	test(
		"fails with RpcCallFailed when the handler errors (500)",
		testEffect(
			Effect.gen(function* () {
				const transport = yield* FieldTransportService;

				const error = yield* transport.callRpc("root", "echo", 42).pipe(
					Effect.provideService(
						FetchHttpClient.Fetch,
						mockFetch(
							() =>
								new Response(
									JSON.stringify({ _tag: "RpcHandlerError", message: "boom" }),
									{
										status: 500,
										headers: { "content-type": "application/json" },
									},
								),
						),
					),
					Effect.flip,
				);

				expect(error._tag).toBe("RpcCallFailed");
			}).pipe(Effect.provide(HttpFieldTransport)),
		),
	);
});
