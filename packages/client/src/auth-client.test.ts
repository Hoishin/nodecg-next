import { FetchHttpClient } from "@effect/platform";
import { testEffect } from "@nodecg/internal/test-utils";
import { Effect } from "effect";
import { describe, expect, test, vi } from "vitest";

import { loginUrl, makeAuthClient } from "./auth-client.ts";

const mockFetch = (respond: () => Response) =>
	vi.fn<typeof globalThis.fetch>(async () => respond());

const requestOf = (fetch: ReturnType<typeof mockFetch>) => {
	const call = fetch.mock.calls[0];
	if (typeof call === "undefined") {
		throw new Error("fetch was not called");
	}
	return new Request(...call);
};

const jsonResponse = (body: unknown) =>
	new Response(JSON.stringify(body), {
		headers: { "content-type": "application/json" },
	});

const mePayload = {
	identity: {
		_tag: "human",
		account: { issuer: "dev", subject: "alice", displayName: "Alice" },
		roles: [],
	},
	namespaces: {
		fixture: { roles: ["producer"] },
	},
};

const buildClient = makeAuthClient().pipe(
	Effect.provide(FetchHttpClient.layer),
);

describe("loginUrl", () => {
	test("returns the provider URL, appending an encoded returnTo when given", () => {
		const dev = { name: "dev", url: "/api/internal/authentication/login/dev" };
		expect(loginUrl(dev)).toBe("/api/internal/authentication/login/dev");
		expect(loginUrl(dev, "/dash?tab=1")).toBe(
			"/api/internal/authentication/login/dev?returnTo=%2Fdash%3Ftab%3D1",
		);
	});
});

describe("providers", () => {
	test(
		"issues a GET to the provider list and returns the decoded entries",
		testEffect(
			Effect.gen(function* () {
				const fetch = mockFetch(() =>
					jsonResponse([
						{ name: "dev", url: "/api/internal/authentication/login/dev" },
					]),
				);
				const client = yield* buildClient;

				const providers = yield* client
					.providers()
					.pipe(Effect.provideService(FetchHttpClient.Fetch, fetch));

				expect(providers).toEqual([
					{ name: "dev", url: "/api/internal/authentication/login/dev" },
				]);
				const request = requestOf(fetch);
				expect(request.method).toBe("GET");
				expect(request.url).toContain("/api/internal/authentication/providers");
			}),
		),
	);

	test(
		"fails with AuthRequestFailed when the server errors",
		testEffect(
			Effect.gen(function* () {
				const client = yield* buildClient;

				const error = yield* client.providers().pipe(
					Effect.provideService(
						FetchHttpClient.Fetch,
						mockFetch(() => new Response(null, { status: 500 })),
					),
					Effect.flip,
				);

				expect(error._tag).toBe("AuthRequestFailed");
			}),
		),
	);
});

describe("me", () => {
	test(
		"issues a GET to /me and returns the decoded payload",
		testEffect(
			Effect.gen(function* () {
				const fetch = mockFetch(() => jsonResponse(mePayload));
				const client = yield* buildClient;

				const payload = yield* client
					.me()
					.pipe(Effect.provideService(FetchHttpClient.Fetch, fetch));

				expect(payload.identity._tag).toBe("human");
				expect(payload.namespaces["fixture"]?.roles).toEqual(
					new Set(["producer"]),
				);
				const request = requestOf(fetch);
				expect(request.method).toBe("GET");
				expect(request.url).toContain("/api/internal/me");
			}),
		),
	);
});

describe("logout", () => {
	test(
		"issues a POST to the logout endpoint",
		testEffect(
			Effect.gen(function* () {
				const fetch = mockFetch(() => new Response(null, { status: 204 }));
				const client = yield* buildClient;

				yield* client
					.logout()
					.pipe(Effect.provideService(FetchHttpClient.Fetch, fetch));

				const request = requestOf(fetch);
				expect(request.method).toBe("POST");
				expect(request.url).toContain("/api/internal/authentication/logout");
			}),
		),
	);
});

describe("base URL", () => {
	const requestUrl = (baseUrl?: string) =>
		Effect.gen(function* () {
			const client = yield* makeAuthClient(baseUrl);
			const fetch = mockFetch(() => jsonResponse([]));
			yield* client
				.providers()
				.pipe(Effect.provideService(FetchHttpClient.Fetch, fetch));
			return requestOf(fetch).url;
		}).pipe(Effect.provide(FetchHttpClient.layer));

	test(
		"prefixes requests with the base URL, with or without a trailing slash",
		testEffect(
			Effect.gen(function* () {
				expect(yield* requestUrl()).toBe(
					`${new URL(import.meta.url).origin}/api/internal/authentication/providers`,
				);
				expect(yield* requestUrl("https://host")).toBe(
					"https://host/api/internal/authentication/providers",
				);
				expect(yield* requestUrl("https://host/")).toBe(
					"https://host/api/internal/authentication/providers",
				);
				expect(yield* requestUrl("https://host/prefix/")).toBe(
					"https://host/prefix/api/internal/authentication/providers",
				);
				expect(yield* requestUrl("https://host/prefix")).toBe(
					"https://host/prefix/api/internal/authentication/providers",
				);
			}),
		),
	);
});
