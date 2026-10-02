import type {
	AccountId,
	Authentication,
	AuthenticationId,
	UserId,
	UserSessionId,
} from "@nodecg-next/internal";
import { Context, type Effect, type Option } from "effect";

import type { BackendError } from "../repository-errors.ts";

export interface AuthenticationRepository {
	readonly findOrCreateAuthentication: (
		authentication: Authentication,
		displayName: string,
	) => Effect.Effect<
		{
			readonly authenticationId: AuthenticationId;
			readonly userId: UserId;
			readonly accountId: AccountId;
		},
		BackendError
	>;

	readonly resolveBySession: (sessionId: UserSessionId) => Effect.Effect<
		Option.Option<{
			readonly accountId: AccountId;
			readonly userId: UserId;
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
