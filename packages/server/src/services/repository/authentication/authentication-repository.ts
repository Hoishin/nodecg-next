import type {
	Authentication,
	AuthenticationId,
	UserSessionId,
} from "@nodecg-next/internal";
import { Context, type Effect, type Option } from "effect";

import type { BackendError } from "../repository-errors.ts";

export interface AuthenticationRepository {
	readonly findOrCreateAuthentication: (
		authentication: Authentication,
		now: number,
	) => Effect.Effect<AuthenticationId, BackendError>;

	readonly resolveBySession: (
		sessionId: UserSessionId,
		now: number,
	) => Effect.Effect<Option.Option<Authentication>, BackendError>;
}

export class AuthenticationRepositoryService extends Context.Service<
	AuthenticationRepositoryService,
	AuthenticationRepository
>()("AuthenticationRepository") {}
