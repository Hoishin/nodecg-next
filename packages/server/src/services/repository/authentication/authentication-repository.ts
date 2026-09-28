import type {
	AccountId,
	Authentication,
	AuthenticationId,
	UserSessionId,
} from "@nodecg-next/internal";
import { Context, type Effect, type Option } from "effect";

import type { BackendError } from "../repository-errors.ts";

export interface AuthenticationRepository {
	readonly findOrCreateAuthentication: (
		authentication: Authentication,
		displayName: string,
		now: number,
	) => Effect.Effect<AuthenticationId, BackendError>;

	readonly resolveBySession: (
		sessionId: UserSessionId,
		now: number,
	) => Effect.Effect<
		Option.Option<{
			readonly accountId: AccountId;
			readonly authentication: Authentication;
			readonly displayName: string;
		}>,
		BackendError
	>;
}

export class AuthenticationRepositoryService extends Context.Service<
	AuthenticationRepositoryService,
	AuthenticationRepository
>()("AuthenticationRepository") {}
