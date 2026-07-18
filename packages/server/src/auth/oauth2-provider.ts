import { createHash } from "node:crypto";

import { HumanAccountSchema } from "@nodecg/internal";
import { Effect } from "effect";
import {
	allowInsecureRequests,
	authorizationCodeGrant,
	buildAuthorizationUrl,
	Configuration,
	fetchProtectedResource,
	randomPKCECodeVerifier,
	randomState,
} from "openid-client";

import {
	type AuthProvider,
	IdentityClaimsError,
	OAuthStateMismatchError,
	TokenExchangeError,
	UserinfoError,
} from "./auth-provider.ts";

export interface OAuth2ProviderConfig {
	readonly name: string;
	readonly issuer: string;
	readonly authorizationEndpoint: string;
	readonly tokenEndpoint: string;
	readonly userinfoEndpoint: string;
	readonly clientId: string;
	readonly clientSecret: string;
	readonly scopes: ReadonlyArray<string>;
	readonly identityFromUserinfo?: (
		userinfo: Record<string, unknown>,
	) => { readonly subject: string; readonly displayName?: string } | undefined;
	readonly allowInsecure?: boolean;
}

const pickString = (value: unknown): string | undefined =>
	typeof value === "string" && value.length > 0 ? value : undefined;

const callbackUrl = (redirectUri: string, searchParams: URLSearchParams) => {
	const url = new URL(redirectUri);
	for (const [key, value] of searchParams) {
		url.searchParams.set(key, value);
	}
	return url;
};

const defaultIdentityFromUserinfo = (userinfo: Record<string, unknown>) => {
	const subject = pickString(userinfo["sub"]);
	if (typeof subject === "undefined") {
		return undefined;
	}
	return {
		subject,
		displayName:
			pickString(userinfo["name"]) ??
			pickString(userinfo["preferred_username"]),
	};
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

export const makeOAuth2Provider = (
	config: OAuth2ProviderConfig,
): AuthProvider => {
	const scope = config.scopes.join(" ");
	const identityFromUserinfo =
		config.identityFromUserinfo ?? defaultIdentityFromUserinfo;
	const configuration = new Configuration(
		{
			issuer: config.issuer,
			authorization_endpoint: config.authorizationEndpoint,
			token_endpoint: config.tokenEndpoint,
		},
		config.clientId,
		config.clientSecret,
	);
	if (config.allowInsecure) {
		allowInsecureRequests(configuration);
	}

	return {
		name: config.name,
		issuer: config.issuer,
		authorize: Effect.fn("OAuth2Provider.authorize")((input) =>
			Effect.sync(() => {
				const codeVerifier = randomPKCECodeVerifier();
				const state = randomState();
				const parameters: Record<string, string> = {
					redirect_uri: input.redirectUri,
					state,
					code_challenge: createHash("sha256")
						.update(codeVerifier)
						.digest("base64url"),
					code_challenge_method: "S256",
				};
				if (scope.length > 0) {
					parameters["scope"] = scope;
				}
				const url = buildAuthorizationUrl(configuration, parameters);
				return {
					url: url.toString(),
					stash: {
						provider: config.name,
						state,
						codeVerifier,
					},
				};
			}),
		),
		callback: Effect.fn("OAuth2Provider.callback")(function* (input) {
			if (input.searchParams.get("state") !== input.stash.state) {
				return yield* new OAuthStateMismatchError();
			}
			const tokens = yield* Effect.tryPromise({
				try: () =>
					authorizationCodeGrant(
						configuration,
						callbackUrl(input.redirectUri, input.searchParams),
						{
							expectedState: input.stash.state,
							pkceCodeVerifier: input.stash.codeVerifier,
						},
					),
				catch: (cause) =>
					new TokenExchangeError({ provider: config.name, cause }),
			});
			const response = yield* Effect.tryPromise({
				try: () =>
					fetchProtectedResource(
						configuration,
						tokens.access_token,
						new URL(config.userinfoEndpoint),
						"GET",
					),
				catch: (cause) => new UserinfoError({ provider: config.name, cause }),
			});
			if (!response.ok) {
				return yield* new UserinfoError({
					provider: config.name,
					cause: { status: response.status },
				});
			}
			const body = yield* Effect.tryPromise({
				try: (): Promise<unknown> => response.json(),
				catch: (cause) => new UserinfoError({ provider: config.name, cause }),
			});
			const identity = isRecord(body) ? identityFromUserinfo(body) : undefined;
			const subject = pickString(identity?.subject);
			if (typeof subject === "undefined") {
				return yield* new IdentityClaimsError({ provider: config.name });
			}
			return HumanAccountSchema.make({
				issuer: config.issuer,
				subject,
				displayName: pickString(identity?.displayName) ?? subject,
			});
		}),
	};
};
