import {
	AccountId,
	type Authentication,
	type GlobalRoleName,
	type Role,
} from "@nodecg-next/internal";
import { Context, HashMap, HashSet, type Effect, Schema } from "effect";

import type { BackendError } from "../repository-errors.ts";

export class UnknownAccount extends Schema.TaggedError<UnknownAccount>()(
	"UnknownAccount",
	{ accountId: AccountId },
) {
	override readonly message = `No account has the id "${this.accountId}"`;
}

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
		grants: HashMap.HashMap<AccountId, HashSet.HashSet<Role>>,
	) => Effect.Effect<void, BackendError>;

	readonly grantRole: (
		accountId: AccountId,
		role: Role,
	) => Effect.Effect<void, BackendError | UnknownAccount>;

	readonly revokeRole: (
		accountId: AccountId,
		role: Role,
	) => Effect.Effect<void, BackendError | UnknownAccount>;

	readonly grantGlobalRole: (
		accountId: AccountId,
		role: GlobalRoleName,
	) => Effect.Effect<void, BackendError | UnknownAccount>;

	readonly revokeGlobalRole: (
		accountId: AccountId,
		role: GlobalRoleName,
	) => Effect.Effect<void, BackendError | UnknownAccount>;

	readonly revokeAllRoles: () => Effect.Effect<void, BackendError>;
}

export class RoleRepositoryService extends Context.Service<
	RoleRepositoryService,
	RoleRepository
>()("RoleRepository") {}
