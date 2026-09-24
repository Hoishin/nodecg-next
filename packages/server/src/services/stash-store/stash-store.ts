import type { AuthStash } from "@nodecg-next/internal";
import { Context, type Effect, type Option } from "effect";

export interface StashStore {
	readonly create: (stash: AuthStash) => Effect.Effect<string>;
	readonly lookup: (id: string) => Effect.Effect<Option.Option<AuthStash>>;
	readonly revoke: (id: string) => Effect.Effect<void>;
}

export class StashStoreService extends Context.Service<
	StashStoreService,
	StashStore
>()("StashStore") {}
