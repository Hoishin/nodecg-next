import type { Authentication } from "@nodecg-next/internal";
import { Context, type Effect, type Option } from "effect";

export interface SessionStore {
	readonly create: (account: Authentication) => Effect.Effect<string>;

	readonly lookup: (
		sessionId: string,
	) => Effect.Effect<Option.Option<Authentication>>;

	readonly refreshTTL: (sessionId: string) => Effect.Effect<void>;

	readonly revoke: (sessionId: string) => Effect.Effect<void>;
}

export class SessionStoreService extends Context.Service<
	SessionStoreService,
	SessionStore
>()("SessionStore") {}
