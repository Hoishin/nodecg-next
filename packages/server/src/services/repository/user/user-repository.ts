import type {
	AccountId,
	Authentication,
	GlobalRoleName,
	Role,
	UserId,
} from "@nodecg-next/internal";
import { Context, type Effect } from "effect";

import type { BackendError } from "../repository-errors.ts";

export interface UserRepository {
	readonly listAll: () => Effect.Effect<
		ReadonlyArray<{
			readonly id: UserId;
			readonly accountId: AccountId;
			readonly displayName: string;
			readonly authentications: ReadonlyArray<Authentication>;
			readonly roles: ReadonlyArray<Role>;
			readonly globalRoles: ReadonlyArray<GlobalRoleName>;
		}>,
		BackendError
	>;
}

export class UserRepositoryService extends Context.Service<
	UserRepositoryService,
	UserRepository
>()("UserRepository") {}
