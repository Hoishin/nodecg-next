import { createHash } from "node:crypto";

import { HumanIdentitySchema } from "@nodecg/internal";
import { Effect } from "effect";
import {
	allowInsecureRequests,
	authorizationCodeGrant,
	buildAuthorizationUrl,
	discovery,
	randomNonce,
	randomPKCECodeVerifier,
	randomState,
} from "openid-client";

import {
	type AuthProvider,
	IdentityClaimsError,
	StateMismatchError,
	TokenExchangeError,
} from "./auth-provider.ts";

export interface OidcProviderConfig {
	readonly name: string;
	readonly issuer: string;
	readonly clientId: string;
	readonly clientSecret: string;
	readonly scopes?: ReadonlyArray<string>;
	/** Permit plain-http issuer/endpoints — for local development only. */
	readonly allowInsecure?: boolean;
}

const pickString = (value: unknown): string | undefined =>
	typeof value === "string" && value.length > 0 ? value : undefined;

const identityFromClaims = (claims: Record<string, unknown>) => {
	const issuer = pickString(claims["iss"]);
	const subject = pickString(claims["sub"]);
	if (typeof issuer === "undefined" || typeof subject === "undefined") {
		return undefined;
	}
	const displayName =
		pickString(claims["name"]) ??
		pickString(claims["preferred_username"]) ??
		subject;
	return HumanIdentitySchema.make({ issuer, subject, displayName });
};

const callbackUrl = (redirectUri: string, searchParams: URLSearchParams) => {
	const url = new URL(redirectUri);
	for (const [key, value] of searchParams) {
		url.searchParams.set(key, value);
	}
	return url;
};

export const makeOidcProvider = async (
	config: OidcProviderConfig,
): Promise<AuthProvider> => {
	const scope = (config.scopes ?? ["openid", "profile", "email"]).join(" ");
	const configuration = await discovery(
		new URL(config.issuer),
		config.clientId,
		config.clientSecret,
		undefined,
		{
			execute: config.allowInsecure ? [allowInsecureRequests] : undefined,
		},
	);

	return {
		name: config.name,
		authorize: Effect.fn("OidcProvider.authorize")((input) =>
			Effect.sync(() => {
				const codeVerifier = randomPKCECodeVerifier();
				const state = randomState();
				const nonce = randomNonce();
				const url = buildAuthorizationUrl(configuration, {
					redirect_uri: input.redirectUri,
					scope,
					state,
					nonce,
					code_challenge: createHash("sha256")
						.update(codeVerifier)
						.digest("base64url"),
					code_challenge_method: "S256",
				});
				return {
					url: url.toString(),
					stash: {
						provider: config.name,
						state,
						codeVerifier,
						nonce,
					},
				};
			}),
		),
		callback: Effect.fn("OidcProvider.callback")(function* (input) {
			if (input.searchParams.get("state") !== input.stash.state) {
				return yield* new StateMismatchError();
			}
			const tokens = yield* Effect.tryPromise({
				try: () =>
					authorizationCodeGrant(
						configuration,
						callbackUrl(input.redirectUri, input.searchParams),
						{
							expectedState: input.stash.state,
							expectedNonce: input.stash.nonce,
							pkceCodeVerifier: input.stash.codeVerifier,
						},
					),
				catch: (cause) =>
					new TokenExchangeError({ provider: config.name, cause }),
			});
			const claims = tokens.claims();
			const identity =
				typeof claims === "undefined" ? undefined : identityFromClaims(claims);
			if (typeof identity === "undefined") {
				return yield* new IdentityClaimsError({ provider: config.name });
			}
			return identity;
		}),
	};
};
