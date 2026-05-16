import { FetchHttpClient } from "@effect/platform";
import { testEffect } from "@nodecg/private";
import { Effect } from "effect";
import { expect, test } from "vitest";

import { createHttpStateTransport } from "./http-state-transport";

interface Call {
	url: string;
	method: string;
	body: string;
}

function mockFetch(
	calls: Call[],
	respond: (call: Call) => Response,
): typeof globalThis.fetch {
	return async (input, init) => {
		const request = new Request(input, init);
		const call: Call = {
			url: request.url,
			method: request.method,
			body: await request.text(),
		};
		calls.push(call);
		return respond(call);
	};
}

test(
	"get issues a GET to the state URL and returns the decoded body",
	testEffect(
		Effect.gen(function* () {
			const calls: Call[] = [];
			const transport = createHttpStateTransport();

			const value = yield* transport.get("root", "count").pipe(
				Effect.provideService(
					FetchHttpClient.Fetch,
					mockFetch(calls, () => new Response(JSON.stringify(42))),
				),
			);

			expect(value).toBe(42);
			expect(calls[0]?.method).toBe("GET");
			expect(calls[0]?.url).toContain("/api/namespaces/root/state/count");
		}),
	),
);

test(
	"set issues a PUT with the JSON-encoded body",
	testEffect(
		Effect.gen(function* () {
			const calls: Call[] = [];
			const transport = createHttpStateTransport();

			yield* transport.update("root", "count", 7).pipe(
				Effect.provideService(
					FetchHttpClient.Fetch,
					mockFetch(calls, () => new Response(null, { status: 204 })),
				),
			);

			expect(calls[0]?.method).toBe("PUT");
			expect(calls[0]?.url).toContain("/api/namespaces/root/state/count");
			expect(JSON.parse(calls[0]?.body ?? "")).toBe(7);
		}),
	),
);

test(
	"get fails with StateNotFound when the server responds 404",
	testEffect(
		Effect.gen(function* () {
			const calls: Call[] = [];
			const transport = createHttpStateTransport();

			const error = yield* transport.get("root", "count").pipe(
				Effect.provideService(
					FetchHttpClient.Fetch,
					mockFetch(calls, () => new Response(null, { status: 404 })),
				),
				Effect.flip,
			);

			expect(error._tag).toBe("StateNotFound");
		}),
	),
);
