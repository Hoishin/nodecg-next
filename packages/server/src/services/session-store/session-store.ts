import type { HumanAccount } from "@nodecg/internal";
import { Context, type Effect, type Option } from "effect";

export interface SessionStore {
	readonly create: (account: HumanAccount) => Effect.Effect<string>;

	readonly lookup: (
		sessionId: string,
	) => Effect.Effect<Option.Option<HumanAccount>>;

	readonly refreshTTL: (sessionId: string) => Effect.Effect<void>;

	readonly revoke: (sessionId: string) => Effect.Effect<void>;
}

export class SessionStoreService extends Context.Tag("SessionStore")<
	SessionStoreService,
	SessionStore
>() {}
