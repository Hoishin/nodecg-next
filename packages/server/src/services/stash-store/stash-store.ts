import { Context, type Effect, type Option } from "effect";

export interface AuthStash {
	readonly provider: string;
	readonly state: string;
	readonly codeVerifier?: string;
	readonly nonce?: string;
}

export interface StashStore {
	readonly create: (stash: AuthStash) => Effect.Effect<string>;
	readonly lookup: (id: string) => Effect.Effect<Option.Option<AuthStash>>;
	readonly revoke: (id: string) => Effect.Effect<void>;
}

export class StashStoreService extends Context.Tag("StashStore")<
	StashStoreService,
	StashStore
>() {}
