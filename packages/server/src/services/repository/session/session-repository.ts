import type { AuthenticationId, UserSessionId } from "@nodecg-next/internal";
import { Context, type Effect } from "effect";
import type { DateTime } from "effect";

import type { BackendError, KeyTaken } from "../repository-errors.ts";

export interface SessionRepository {
	readonly create: (
		id: UserSessionId,
		authenticationId: AuthenticationId,
		expiresAt: DateTime.DateTime,
	) => Effect.Effect<void, KeyTaken | BackendError>;

	readonly refreshTTL: (
		id: UserSessionId,
		expiresAt: DateTime.DateTime,
	) => Effect.Effect<void, BackendError>;

	readonly revoke: (id: UserSessionId) => Effect.Effect<void, BackendError>;
}

export class SessionRepositoryService extends Context.Service<
	SessionRepositoryService,
	SessionRepository
>()("SessionRepository") {}
