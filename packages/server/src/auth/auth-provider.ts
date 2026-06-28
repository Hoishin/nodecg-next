import type { HumanIdentity } from "@nodecg/internal";
import { Context, Data, type Effect, HashMap } from "effect";

import type { AuthStash } from "../services/stash-store/stash-store.ts";

export class StateMismatchError extends Data.TaggedError("StateMismatchError") {
	override readonly message = `State mismatch`;
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

export type AuthorizeError = ProviderDiscoveryError;
export type CallbackError =
	| StateMismatchError
	| ProviderDiscoveryError
	| TokenExchangeError
	| IdentityClaimsError;

export interface AuthProvider {
	readonly name: string;
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
	}) => Effect.Effect<HumanIdentity, CallbackError>;
}

export class AuthProviderRegistry extends Context.Tag("AuthProviderRegistry")<
	AuthProviderRegistry,
	HashMap.HashMap<string, AuthProvider>
>() {}
