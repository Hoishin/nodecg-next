import type { HumanAccount } from "@nodecg/internal";
import { Context, type Effect, HashMap, Schema } from "effect";

import type { AuthStash } from "../services/stash-store/stash-store.ts";

export class ProviderStateMismatch extends Schema.TaggedError<ProviderStateMismatch>()(
	"ProviderStateMismatch",
	{},
) {
	override readonly message = `OAuth state mismatch`;
}

export class ProviderUnavailableError extends Schema.TaggedError<ProviderUnavailableError>()(
	"ProviderUnavailableError",
	{ provider: Schema.String, cause: Schema.Unknown },
) {
	override readonly message = `Discovery failed for authentication provider "${this.provider}"`;
}

export class CredentialExchangeError extends Schema.TaggedError<CredentialExchangeError>()(
	"CredentialExchangeError",
	{ provider: Schema.String, cause: Schema.Unknown },
) {
	override readonly message = `Token exchange failed for authentication provider "${this.provider}"`;
}

export class NoIdentity extends Schema.TaggedError<NoIdentity>()("NoIdentity", {
	provider: Schema.String,
}) {
	override readonly message = `Authentication provider "${this.provider}" returned no usable identity claims`;
}

export class ProviderResponseError extends Schema.TaggedError<ProviderResponseError>()(
	"ProviderResponseError",
	{ provider: Schema.String, cause: Schema.Unknown },
) {
	override readonly message = `Userinfo request failed for authentication provider "${this.provider}"`;
}

export type AuthorizeError = ProviderUnavailableError;
export type CallbackError =
	| ProviderStateMismatch
	| ProviderUnavailableError
	| CredentialExchangeError
	| ProviderResponseError
	| NoIdentity;

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
