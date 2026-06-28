import { FetchHttpClient } from "@effect/platform";
import { testEffect } from "@nodecg/internal/test-utils";
import { Effect } from "effect";
import { describe, expect, test, vi } from "vitest";

import { HttpStateTransport } from "./http-state-transport.ts";
import { StateTransportService } from "./state-transport.ts";

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
				const transport = yield* StateTransportService;
				const fetch = mockFetch(() => new Response(JSON.stringify(42)));

				const value = yield* transport
					.readState("root", "count")
					.pipe(Effect.provideService(FetchHttpClient.Fetch, fetch));

				expect(value).toBe(42);
				const request = requestOf(fetch);
				expect(request.method).toBe("GET");
				expect(request.url).toContain("/api/namespaces/root/state/count");
			}).pipe(Effect.provide(HttpStateTransport)),
		),
	);

	test(
		"fails with StateNotFound when the server responds 404",
		testEffect(
			Effect.gen(function* () {
				const transport = yield* StateTransportService;

				const error = yield* transport.readState("root", "count").pipe(
					Effect.provideService(
						FetchHttpClient.Fetch,
						mockFetch(() => new Response(null, { status: 404 })),
					),
					Effect.flip,
				);

				expect(error._tag).toBe("StateNotFound");
			}).pipe(Effect.provide(HttpStateTransport)),
		),
	);

	test(
		"fails with StatePermissionDenied when the server responds 403",
		testEffect(
			Effect.gen(function* () {
				const transport = yield* StateTransportService;

				const error = yield* transport.readState("root", "count").pipe(
					Effect.provideService(
						FetchHttpClient.Fetch,
						mockFetch(() => new Response(null, { status: 403 })),
					),
					Effect.flip,
				);

				expect(error._tag).toBe("StatePermissionDenied");
			}).pipe(Effect.provide(HttpStateTransport)),
		),
	);
});

describe("update", () => {
	test(
		"issues a PUT with the JSON-encoded body",
		testEffect(
			Effect.gen(function* () {
				const transport = yield* StateTransportService;
				const fetch = mockFetch(() => new Response(null, { status: 204 }));

				yield* transport
					.updateState("root", "count", 7)
					.pipe(Effect.provideService(FetchHttpClient.Fetch, fetch));

				const request = requestOf(fetch);
				expect(request.method).toBe("PUT");
				expect(request.url).toContain("/api/namespaces/root/state/count");
				const body = yield* Effect.promise(() => request.text());
				expect(JSON.parse(body)).toBe(7);
			}).pipe(Effect.provide(HttpStateTransport)),
		),
	);

	test(
		"fails with StatePermissionDenied when the server responds 403",
		testEffect(
			Effect.gen(function* () {
				const transport = yield* StateTransportService;

				const error = yield* transport.updateState("root", "count", 7).pipe(
					Effect.provideService(
						FetchHttpClient.Fetch,
						mockFetch(() => new Response(null, { status: 403 })),
					),
					Effect.flip,
				);

				expect(error._tag).toBe("StatePermissionDenied");
			}).pipe(Effect.provide(HttpStateTransport)),
		),
	);
});
