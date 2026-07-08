import { Effect } from "effect";
import { type MutableResponse, OAuth2Server } from "oauth2-mock-server";
import { afterEach, expect, test } from "vitest";

import {
	makeOAuth2Provider,
	type OAuth2ProviderConfig,
} from "./oauth2-provider.ts";

const redirectUri = "http://localhost:3000/api/authentication/callback/local";
const pinnedIssuer = "https://oauth2.example";

let server: OAuth2Server | undefined;

afterEach(async () => {
	if (typeof server !== "undefined") {
		await server.stop();
		server = undefined;
	}
});

const startIdp = async (
	mutateUserinfo?: (response: MutableResponse) => void,
) => {
	const oauth = new OAuth2Server();
	await oauth.issuer.keys.generate("RS256");
	oauth.service.on("beforeResponse", (response: MutableResponse) => {
		if (typeof response.body !== "string") {
			delete response.body["id_token"];
		}
	});
	if (typeof mutateUserinfo !== "undefined") {
		oauth.service.on("beforeUserinfo", mutateUserinfo);
	}
	await oauth.start(0, "localhost");
	server = oauth;
	const url = oauth.issuer.url;
	if (typeof url === "undefined") {
		throw new Error("OAuth2 server did not report a URL");
	}
	return url;
};

const makeLocalProvider = (
	serverUrl: string,
	overrides?: Partial<OAuth2ProviderConfig>,
) =>
	makeOAuth2Provider({
		name: "local",
		issuer: pinnedIssuer,
		authorizationEndpoint: `${serverUrl}/authorize`,
		tokenEndpoint: `${serverUrl}/token`,
		userinfoEndpoint: `${serverUrl}/userinfo`,
		clientId: "example-client",
		clientSecret: "example-secret",
		scopes: ["identify"],
		allowInsecure: true,
		...overrides,
	});

const authorizeCode = async (authorizeUrl: string) => {
	const redirect = await fetch(authorizeUrl, { redirect: "manual" });
	const location = redirect.headers.get("location");
	if (location === null) {
		throw new Error("authorize endpoint did not redirect with a code");
	}
	return new URL(location).searchParams;
};

test("resolves a human identity from userinfo with the config-pinned issuer", async () => {
	const serverUrl = await startIdp();
	const provider = makeLocalProvider(serverUrl);

	const authorized = await Effect.runPromise(
		provider.authorize({ redirectUri, searchParams: new URLSearchParams() }),
	);
	const searchParams = await authorizeCode(authorized.url);
	const identity = await Effect.runPromise(
		provider.callback({ redirectUri, searchParams, stash: authorized.stash }),
	);

	expect(identity).toEqual({
		issuer: pinnedIssuer,
		subject: "johndoe",
		displayName: "johndoe",
	});
});

test("derives the display name from the name claim", async () => {
	const serverUrl = await startIdp((response) => {
		response.body = { sub: "johndoe", name: "Ada Lovelace" };
	});
	const provider = makeLocalProvider(serverUrl);

	const authorized = await Effect.runPromise(
		provider.authorize({ redirectUri, searchParams: new URLSearchParams() }),
	);
	const searchParams = await authorizeCode(authorized.url);
	const identity = await Effect.runPromise(
		provider.callback({ redirectUri, searchParams, stash: authorized.stash }),
	);

	expect(identity).toEqual({
		issuer: pinnedIssuer,
		subject: "johndoe",
		displayName: "Ada Lovelace",
	});
});

test("falls back to preferred_username when the name claim is absent", async () => {
	const serverUrl = await startIdp((response) => {
		response.body = { sub: "johndoe", preferred_username: "handle" };
	});
	const provider = makeLocalProvider(serverUrl);

	const authorized = await Effect.runPromise(
		provider.authorize({ redirectUri, searchParams: new URLSearchParams() }),
	);
	const searchParams = await authorizeCode(authorized.url);
	const identity = await Effect.runPromise(
		provider.callback({ redirectUri, searchParams, stash: authorized.stash }),
	);

	expect(identity).toEqual({
		issuer: pinnedIssuer,
		subject: "johndoe",
		displayName: "handle",
	});
});

test("rejects a state mismatch with OAuthStateMismatchError", async () => {
	const serverUrl = await startIdp();
	const provider = makeLocalProvider(serverUrl);

	const authorized = await Effect.runPromise(
		provider.authorize({ redirectUri, searchParams: new URLSearchParams() }),
	);
	const error = await Effect.runPromise(
		provider
			.callback({
				redirectUri,
				searchParams: new URLSearchParams({ code: "code", state: "tampered" }),
				stash: authorized.stash,
			})
			.pipe(Effect.flip),
	);

	expect(error._tag).toBe("OAuthStateMismatchError");
});

test("rejects a failed token exchange with TokenExchangeError", async () => {
	const serverUrl = await startIdp();
	const provider = makeLocalProvider(serverUrl);

	const authorized = await Effect.runPromise(
		provider.authorize({ redirectUri, searchParams: new URLSearchParams() }),
	);
	const error = await Effect.runPromise(
		provider
			.callback({
				redirectUri,
				searchParams: new URLSearchParams({
					code: "never-issued",
					state: authorized.stash.state,
				}),
				stash: authorized.stash,
			})
			.pipe(Effect.flip),
	);

	expect(error._tag).toBe("TokenExchangeError");
});

test("rejects a failed userinfo request with UserinfoError", async () => {
	const serverUrl = await startIdp((response) => {
		response.statusCode = 500;
	});
	const provider = makeLocalProvider(serverUrl);

	const authorized = await Effect.runPromise(
		provider.authorize({ redirectUri, searchParams: new URLSearchParams() }),
	);
	const searchParams = await authorizeCode(authorized.url);
	const error = await Effect.runPromise(
		provider
			.callback({ redirectUri, searchParams, stash: authorized.stash })
			.pipe(Effect.flip),
	);

	expect(error._tag).toBe("UserinfoError");
});

test("rejects a userinfo response without a subject with IdentityClaimsError", async () => {
	const serverUrl = await startIdp((response) => {
		response.body = { name: "No Subject" };
	});
	const provider = makeLocalProvider(serverUrl);

	const authorized = await Effect.runPromise(
		provider.authorize({ redirectUri, searchParams: new URLSearchParams() }),
	);
	const searchParams = await authorizeCode(authorized.url);
	const error = await Effect.runPromise(
		provider
			.callback({ redirectUri, searchParams, stash: authorized.stash })
			.pipe(Effect.flip),
	);

	expect(error._tag).toBe("IdentityClaimsError");
});

test("rejects a non-object userinfo response with IdentityClaimsError", async () => {
	const serverUrl = await startIdp((response) => {
		response.body = "";
	});
	const provider = makeLocalProvider(serverUrl);

	const authorized = await Effect.runPromise(
		provider.authorize({ redirectUri, searchParams: new URLSearchParams() }),
	);
	const searchParams = await authorizeCode(authorized.url);
	const error = await Effect.runPromise(
		provider
			.callback({ redirectUri, searchParams, stash: authorized.stash })
			.pipe(Effect.flip),
	);

	expect(error._tag).toBe("IdentityClaimsError");
});

test("maps a provider-specific userinfo shape through identityFromUserinfo", async () => {
	const serverUrl = await startIdp((response) => {
		response.body = { id: 583231, login: "octocat" };
	});
	const provider = makeLocalProvider(serverUrl, {
		identityFromUserinfo: (userinfo) =>
			typeof userinfo["id"] === "number"
				? {
						subject: String(userinfo["id"]),
						displayName:
							typeof userinfo["login"] === "string"
								? userinfo["login"]
								: undefined,
					}
				: undefined,
	});

	const authorized = await Effect.runPromise(
		provider.authorize({ redirectUri, searchParams: new URLSearchParams() }),
	);
	const searchParams = await authorizeCode(authorized.url);
	const identity = await Effect.runPromise(
		provider.callback({ redirectUri, searchParams, stash: authorized.stash }),
	);

	expect(identity).toEqual({
		issuer: pinnedIssuer,
		subject: "583231",
		displayName: "octocat",
	});
});
