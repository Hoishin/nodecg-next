import type {
	AccountId,
	Authentication,
	GlobalRoleName,
	Role,
} from "@nodecg-next/internal";
import { Context, HashSet, type Effect } from "effect";

import type { BackendError } from "../repository-errors.ts";

export interface RoleGrants {
	readonly roles: ReadonlyArray<Role>;
	readonly globalRoles: ReadonlyArray<GlobalRoleName>;
}

export interface RoleAssignment {
	readonly authentication: Authentication;
	readonly displayName: string;
	readonly roles: ReadonlyArray<Role>;
	readonly globalRoles: ReadonlyArray<GlobalRoleName>;
}

export interface RoleRepository {
	readonly read: (
		accountId: AccountId,
	) => Effect.Effect<RoleGrants, BackendError>;

	readonly listAll: () => Effect.Effect<
		ReadonlyArray<RoleAssignment>,
		BackendError
	>;

	readonly globalRoleExists: (
		role: GlobalRoleName,
	) => Effect.Effect<boolean, BackendError>;

	readonly grantRoles: (
		accountId: AccountId,
		roles: HashSet.HashSet<Role>,
	) => Effect.Effect<void, BackendError>;

	readonly revokeRole: (
		accountId: AccountId,
		role: Role,
	) => Effect.Effect<void, BackendError>;

	readonly grantGlobalRole: (
		accountId: AccountId,
		role: GlobalRoleName,
	) => Effect.Effect<void, BackendError>;

	readonly revokeGlobalRole: (
		accountId: AccountId,
		role: GlobalRoleName,
	) => Effect.Effect<void, BackendError>;

	readonly revokeAllRoles: () => Effect.Effect<void, BackendError>;
}

export class RoleRepositoryService extends Context.Service<
	RoleRepositoryService,
	RoleRepository
>()("RoleRepository") {}
