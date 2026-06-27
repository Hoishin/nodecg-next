import type { HumanIdentity } from "@nodecg/internal";
import { Context, Data, type Effect, HashMap } from "effect";

import type { AuthStash } from "../services/stash-store/stash-store.ts";

export class StateMismatchError extends Data.TaggedError("StateMismatchError") {
	override readonly message = `State mismatch`;
}

export interface AuthProvider {
	readonly name: string;
	readonly authorize: (input: {
		readonly redirectUri: string;
		readonly searchParams: URLSearchParams;
	}) => Effect.Effect<{ readonly url: string; readonly stash: AuthStash }>;
	readonly callback: (input: {
		readonly redirectUri: string;
		readonly searchParams: URLSearchParams;
		readonly stash: AuthStash;
	}) => Effect.Effect<HumanIdentity, StateMismatchError>;
}

export class AuthProviderRegistry extends Context.Tag("AuthProviderRegistry")<
	AuthProviderRegistry,
	HashMap.HashMap<string, AuthProvider>
>() {}
