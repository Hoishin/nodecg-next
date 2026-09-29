import type { AccountId, Authentication } from "@nodecg-next/internal";
import { Context, type Effect, type Option } from "effect";

import type { BackendError } from "../repository-errors.ts";

export interface AccountRepository {
	readonly resolveByAuthentication: (
		authentication: Authentication,
	) => Effect.Effect<Option.Option<AccountId>, BackendError>;
}

export class AccountRepositoryService extends Context.Service<
	AccountRepositoryService,
	AccountRepository
>()("AccountRepository") {}
