import type { HumanAccount } from "@nodecg/internal";
import { Context, Data, type Effect, HashMap } from "effect";

import type { AuthStash } from "../services/stash-store/stash-store.ts";

export class OAuthStateMismatchError extends Data.TaggedError(
	"OAuthStateMismatchError",
) {
	override readonly message = `OAuth state mismatch`;
}

// TODO: don't leak OIDC details in service definition
export class ProviderDiscoveryError extends Data.TaggedError(
	"ProviderDiscoveryError",
)<{
	readonly provider: string;
	readonly cause: unknown;
}> {
	override readonly message = `Discovery failed for authentication provider "${this.provider}"`;
}

// TODO: don't leak OIDC details in service definition
export class TokenExchangeError extends Data.TaggedError("TokenExchangeError")<{
	readonly provider: string;
	readonly cause: unknown;
}> {
	override readonly message = `Token exchange failed for authentication provider "${this.provider}"`;
}

// TODO: don't leak OIDC details in service definition
export class IdentityClaimsError extends Data.TaggedError(
	"IdentityClaimsError",
)<{
	readonly provider: string;
}> {
	override readonly message = `Authentication provider "${this.provider}" returned no usable identity claims`;
}

// TODO: don't leak OIDC details in service definition
export class UserinfoError extends Data.TaggedError("UserinfoError")<{
	readonly provider: string;
	readonly cause: unknown;
}> {
	override readonly message = `Userinfo request failed for authentication provider "${this.provider}"`;
}

export type AuthorizeError = ProviderDiscoveryError;
export type CallbackError =
	| OAuthStateMismatchError
	| ProviderDiscoveryError
	| TokenExchangeError
	| UserinfoError
	| IdentityClaimsError;

export interface AuthProvider {
	readonly name: string;
	readonly issuer: string;
	readonly authorize: (input: {
		readonly redirectUri: string;
		readonly searchParams: URLSearchParams;
	}) => Effect.Effect<
		{ readonly url: string; readonly stash: AuthStash },
		AuthorizeError
	>;
	readonly callback: (input: {
		readonly redirectUri: string;
		readonly searchParams: URLSearchParams;
		readonly stash: AuthStash;
	}) => Effect.Effect<HumanAccount, CallbackError>;
}

export class AuthProviderRegistry extends Context.Tag("AuthProviderRegistry")<
	AuthProviderRegistry,
	HashMap.HashMap<string, AuthProvider>
>() {}
